"use strict";

/*
  SoundSphere 1.3 content fallback.

  Chrome normally uses tabCapture in the offscreen engine. This script stays
  passive until the background script explicitly asks for fallback control.
  That matters on sites like Bandcamp: eagerly calling createMediaElementSource()
  can reroute the site's own <audio> element into a suspended AudioContext.

  This script is still needed for Firefox and for Chrome pages where tabCapture is unavailable.
  It tries media-element WebAudio first, then falls back to basic 0-100 volume.
*/

const EQ_BANDS_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

const drmState = {
  inUse: false,
  encryptedEvent: false,
  mediaKeys: false
};

const tapState = {
  ready: false,
  injected: false,
  contexts: 0,
  lastSeenAt: 0
};

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function normalizeSettings(settings) {
  const raw = settings && typeof settings === "object" ? settings : {};
  const eq = Array.isArray(raw.eqGains) ? raw.eqGains.slice(0, 10) : [];
  while (eq.length < 10) eq.push(0);

  return {
    volume: clamp(raw.volume ?? 100, 0, 800),
    muted: !!raw.muted,
    mode: raw.mode === "voice" || raw.mode === "bass" ? raw.mode : "default",
    eqGains: eq.map(value => clamp(value, -24, 24))
  };
}

function isMediaElement(node) {
  return node && node.nodeType === 1 && (node.tagName === "AUDIO" || node.tagName === "VIDEO");
}

function markDrm(kind) {
  drmState.inUse = true;
  if (kind === "encrypted") drmState.encryptedEvent = true;
  if (kind === "mediaKeys") drmState.mediaKeys = true;
}

function watchForDrm(el) {
  try {
    if (el.mediaKeys) markDrm("mediaKeys");
  } catch {}

  try {
    el.addEventListener("encrypted", () => markDrm("encrypted"), { once: true, passive: true });
  } catch {}
}

document.addEventListener("encrypted", () => markDrm("encrypted"), true);

function injectWebAudioTap() {
  if (tapState.injected) return;
  try {
    const root = document.documentElement || document.head;
    if (!root) return;
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("inject/webaudio_tap.js");
    script.async = false;
    root.appendChild(script);
    script.addEventListener("load", () => script.remove(), { once: true });
    script.addEventListener("error", () => script.remove(), { once: true });
    tapState.injected = true;
  } catch {}
}

function postTapSettings(settings) {
  try {
    window.postMessage({
      source: "SoundSphere",
      type: "SS_SETTINGS",
      payload: {
        volumePercent: settings.volume,
        muted: settings.muted,
        mode: settings.mode,
        eq: settings.eqGains.slice()
      }
    }, "*");
  } catch {}
}

function pingTap() {
  try {
    window.postMessage({ source: "SoundSphere", type: "SS_PING" }, "*");
  } catch {}
}

window.addEventListener("message", event => {
  if (!event || event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "SoundSphereTap") return;

  if (data.type === "SS_TAP_READY" || data.type === "SS_TAP_PONG") {
    tapState.ready = true;
    tapState.lastSeenAt = Date.now();
  }

  if (data.type === "SS_TAP_APPLIED") {
    tapState.ready = true;
    tapState.contexts = Number(data.payload && data.payload.contexts) || tapState.contexts;
    tapState.lastSeenAt = Date.now();
  }
});

class AudioBus {
  constructor() {
    this.ctx = null;
    this.input = null;
    this.gain = null;
    this.modeFilter = null;
    this.eq = [];
    this.compressor = null;
    this.shaper = null;
    this.output = null;
  }

  ensure() {
    if (this.ctx) return true;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;

    this.ctx = new AudioContextClass();
    this.input = this.ctx.createGain();
    this.gain = this.ctx.createGain();
    this.modeFilter = this.ctx.createBiquadFilter();
    this.eq = EQ_BANDS_HZ.map(frequency => {
      const node = this.ctx.createBiquadFilter();
      node.type = "peaking";
      node.frequency.value = frequency;
      node.Q.value = 1;
      node.gain.value = 0;
      return node;
    });

    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -8;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    this.shaper = this.ctx.createWaveShaper();
    this.shaper.curve = AudioBus.makeSoftClipCurve();
    this.shaper.oversample = "2x";

    this.output = this.ctx.createGain();
    this.input.connect(this.gain);
    this.gain.connect(this.modeFilter);
    let tail = this.modeFilter;
    for (const node of this.eq) {
      tail.connect(node);
      tail = node;
    }
    tail.connect(this.compressor);
    this.compressor.connect(this.shaper);
    this.shaper.connect(this.output);
    this.output.connect(this.ctx.destination);

    const resume = () => this.resume();
    window.addEventListener("pointerdown", resume, { passive: true });
    window.addEventListener("keydown", resume, { passive: true });
    return true;
  }

  static makeSoftClipCurve() {
    const samples = 4096;
    const curve = new Float32Array(samples);
    for (let index = 0; index < samples; index++) {
      const x = (index / (samples - 1)) * 2 - 1;
      curve[index] = x / (1 + 0.65 * Math.abs(x));
    }
    return curve;
  }

  resume() {
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
  }

  apply(settings) {
    if (!this.ensure()) return;
    const t = this.ctx.currentTime;
    const gain = settings.muted ? 0 : settings.volume / 100;
    this.gain.gain.setTargetAtTime(gain, t, 0.012);

    if (settings.mode === "voice") {
      this.modeFilter.type = "peaking";
      this.modeFilter.frequency.setValueAtTime(3000, t);
      this.modeFilter.Q.setValueAtTime(1.1, t);
      this.modeFilter.gain.setTargetAtTime(8, t, 0.015);
    } else if (settings.mode === "bass") {
      this.modeFilter.type = "lowshelf";
      this.modeFilter.frequency.setValueAtTime(90, t);
      this.modeFilter.Q.setValueAtTime(0.7, t);
      this.modeFilter.gain.setTargetAtTime(10, t, 0.015);
    } else {
      this.modeFilter.type = "peaking";
      this.modeFilter.frequency.setValueAtTime(1000, t);
      this.modeFilter.Q.setValueAtTime(1, t);
      this.modeFilter.gain.setTargetAtTime(0, t, 0.015);
    }

    this.eq.forEach((node, index) => {
      node.gain.setTargetAtTime(settings.eqGains[index] || 0, t, 0.015);
    });
    this.resume();
  }
}

class MediaHook {
  constructor(bus) {
    this.bus = bus;
    this.sources = new WeakMap();
    this.hookedCount = 0;
  }

  hook(el) {
    if (!isMediaElement(el)) return false;
    watchForDrm(el);
    if (drmState.inUse) return false;
    if (this.sources.has(el)) return true;
    if (!this.bus.ensure()) return false;

    try {
      const source = this.bus.ctx.createMediaElementSource(el);
      source.connect(this.bus.input);
      this.sources.set(el, source);
      this.hookedCount += 1;
      el.volume = 1;
      return true;
    } catch {
      return false;
    }
  }

  scan(root = document) {
    try {
      if (isMediaElement(root)) this.hook(root);
      const list = root.querySelectorAll ? root.querySelectorAll("audio,video") : [];
      for (const el of list) this.hook(el);
    } catch {}
  }
}

class SoundSphereContentController {
  constructor() {
    this.bus = new AudioBus();
    this.hook = new MediaHook(this.bus);
    this.settings = normalizeSettings({});
    this.started = false;
    this.observer = null;
    this.backend = "basic";
  }

  start() {
    if (this.started) return;
    this.started = true;
    injectWebAudioTap();
    pingTap();
    this.installObservers();
    this.scan();
  }

  installObservers() {
    document.addEventListener("play", event => {
      if (isMediaElement(event.target)) {
        this.hook.hook(event.target);
        this.apply(this.settings);
      }
    }, true);

    this.observer = new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes || []) {
          if (isMediaElement(node) || (node && node.querySelectorAll)) {
            this.hook.scan(node);
          }
        }
      }
    });

    try {
      this.observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true
      });
    } catch {}
  }

  scan() {
    this.hook.scan();
    for (const el of document.querySelectorAll("audio,video")) watchForDrm(el);
  }

  applyBasic(settings) {
    const volume = clamp(settings.volume, 0, 100) / 100;
    for (const el of document.querySelectorAll("audio,video")) {
      try { el.muted = settings.muted || settings.volume <= 0; } catch {}
      try { el.volume = settings.muted ? 0 : volume; } catch {}
    }
  }

  applyProtectedBasic(settings) {
    const safeSettings = normalizeSettings({
      volume: clamp(settings.volume, 0, 100),
      muted: settings.muted,
      mode: "default",
      eqGains: new Array(10).fill(0)
    });

    if (this.hook.hookedCount > 0) {
      this.bus.apply(safeSettings);
    }
    this.applyBasic(safeSettings);
  }

  apply(settings) {
    this.settings = normalizeSettings(settings);
    this.start();
    injectWebAudioTap();
    pingTap();
    this.scan();

    if (drmState.inUse) {
      this.applyProtectedBasic(this.settings);
      this.backend = "protected-basic";
      return this.status();
    }

    if (!drmState.inUse && this.hook.hookedCount > 0) {
      this.bus.apply(this.settings);
      this.backend = "media-element";
      return this.status();
    }

    if (!drmState.inUse && tapState.ready) {
      postTapSettings(this.settings);
      this.backend = "page-webaudio";
      return this.status();
    }

    this.applyBasic(this.settings);
    this.backend = drmState.inUse ? "protected-basic" : "basic";
    return this.status();
  }

  reset() {
    this.apply(normalizeSettings({ volume: 100, mode: "default", eqGains: new Array(10).fill(0) }));
  }

  status() {
    const canBoost = !drmState.inUse && (this.hook.hookedCount > 0 || tapState.ready);
    const reason = drmState.inUse
      ? "Protected playback detected. Basic 0-100 volume is available, but EQ and boost are blocked by the browser/site."
      : (canBoost ? "" : "Using basic 0-100 media element volume until WebAudio can attach.");

    return {
      ok: true,
      backend: this.backend,
      canBoost,
      hooked: this.hook.hookedCount,
      contextState: this.bus.ctx ? this.bus.ctx.state : "none",
      tapReady: tapState.ready,
      tapContexts: tapState.contexts,
      drm: { ...drmState },
      reason
    };
  }
}

const controller = new SoundSphereContentController();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return undefined;

  if (message.type === "SS_CONTENT_APPLY") {
    sendResponse(controller.apply(message.settings));
    return undefined;
  }

  if (message.type === "SS_CONTENT_STATUS") {
    controller.start();
    sendResponse(controller.status());
    return undefined;
  }

  if (message.type === "SS_CONTENT_RESET") {
    controller.reset();
    sendResponse({ ok: true });
    return undefined;
  }

  return undefined;
});
