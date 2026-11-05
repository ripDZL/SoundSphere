"use strict";

/*
  SoundSphere 1.3 content fallback.

  Chrome normally uses tabCapture in the offscreen engine. This script stays
  passive until the background script explicitly asks for fallback control.
  That matters on sites like Bandcamp: eagerly calling createMediaElementSource()
  can reroute the site's own <audio> element into a suspended AudioContext.

  This script is still needed for Firefox and for Chrome pages where tabCapture is unavailable.
  It tries media-element WebAudio first, then falls back to basic 0-100 volume.

  Two browser rules decide whether an element may be rerouted through WebAudio.
  Breaking either one silences the element, so both are checked first:
    - cross-origin media without CORS outputs silence from
      createMediaElementSource (common on CDN-hosted audio such as Bandcamp)
    - a suspended AudioContext (no page gesture yet) renders nothing
*/

const EQ_BANDS_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const CLIP_RANGE = 4;
const CLIP_KNEE = 0.85;
const CONTEXT_START_WAIT_MS = 300;
const IS_TOP_FRAME = (() => {
  try { return window.top === window; } catch { return false; }
})();

// Diagnostics for beta builds: decisions on the CORS / off-DOM paths only
// (rare events, never per-sample). Visible in the page's web console.
const DEBUG_LOG = true;
function ssLog(...args) {
  if (!DEBUG_LOG) return;
  try { console.info("[SoundSphere]", ...args); } catch {}
}

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

// True when WebAudio may read the element's samples. Same-origin, blob: (MSE,
// used by YouTube/Twitch), data:, MediaStream and CORS-enabled media qualify.
// Elements with no source yet return false and are retried on "play".
function isCorsReadable(el) {
  try {
    if (el.srcObject) return true;
    if (el.crossOrigin === "anonymous" || el.crossOrigin === "use-credentials") return true;
    const src = el.currentSrc || el.src || "";
    if (!src) return false;
    const url = new URL(src, document.baseURI);
    if (url.protocol === "blob:" || url.protocol === "data:" || url.protocol === "mediastream:") return true;
    return url.origin === window.location.origin;
  } catch {
    return false;
  }
}

// Cross-origin http(s) media loaded without CORS: playable, but WebAudio
// would read silence. Firefox can unlock it (see unlockCors).
function isCorsBlocked(el) {
  try {
    if (!isMediaElement(el) || el.srcObject || el.crossOrigin) return false;
    const src = el.currentSrc || el.src || "";
    if (!src) return false;
    const url = new URL(src, document.baseURI);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin !== window.location.origin;
  } catch {
    return false;
  }
}

// Volume cuts and mute work on the element itself; anything louder or
// shaped needs WebAudio.
function needsProcessing(settings) {
  return !settings.muted && (
    settings.volume > 100 ||
    settings.mode !== "default" ||
    settings.eqGains.some(value => value !== 0)
  );
}

const CORS_RELOAD_TIMEOUT_MS = 5000;
const corsPending = new WeakSet(); // elements mid-reload: never hook yet

// Check that a URL loads in CORS mode *before* touching the site's player:
// a failed CORS load fires "error" on the element, and players such as
// Bandcamp's treat that as a dead track even if SoundSphere then reverts.
// The probe is a detached, muted element that only loads metadata.
const corsProbeCache = new Map(); // url -> Promise<boolean>

function probeCors(url) {
  if (corsProbeCache.has(url)) return corsProbeCache.get(url);
  const result = new Promise(resolve => {
    let probe;
    let timer = null;
    const finish = ok => {
      clearTimeout(timer);
      try {
        probe.removeAttribute("src");
        probe.load();
      } catch {}
      ssLog("CORS probe", ok ? "passed" : "failed", url);
      resolve(ok);
    };
    try {
      probe = document.createElement("audio");
      probe.muted = true;
      probe.preload = "metadata";
      probe.crossOrigin = "anonymous";
      probe.addEventListener("loadedmetadata", () => finish(true), { once: true });
      probe.addEventListener("error", () => finish(false), { once: true });
      timer = setTimeout(() => finish(false), CORS_RELOAD_TIMEOUT_MS);
      probe.src = url;
    } catch (error) {
      ssLog("CORS probe could not start:", error && error.message);
      resolve(false);
    }
  });
  corsProbeCache.set(url, result);
  return result;
}

// Reload one element in CORS mode, keeping position and play state. Resolves
// true once metadata loads (now WebAudio-readable). On error or timeout the
// crossorigin attribute is removed and the original load restored.
function reloadWithCors(el) {
  return new Promise(resolve => {
    const state = {
      time: Number(el.currentTime) || 0,
      paused: !!el.paused,
      rate: Number(el.playbackRate) || 1,
      src: el.getAttribute && el.getAttribute("src") ? (el.currentSrc || el.src) : null
    };
    const reloadSource = () => {
      if (state.src) el.src = state.src;
      else el.load();
    };
    const restorePlayback = () => {
      try {
        if (state.time > 0) el.currentTime = state.time;
        el.playbackRate = state.rate;
      } catch {}
      if (!state.paused) {
        try {
          const played = el.play();
          if (played && typeof played.catch === "function") played.catch(() => {});
        } catch {}
      }
    };

    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeEventListener("loadedmetadata", onLoaded);
      el.removeEventListener("error", onError);
      corsPending.delete(el);
      if (ok) {
        restorePlayback();
      } else {
        try { el.removeAttribute("crossorigin"); } catch {}
        el.addEventListener("loadedmetadata", restorePlayback, { once: true });
        reloadSource();
      }
      resolve(ok);
    };
    const onLoaded = () => finish(true);
    const onError = () => {
      const code = el.error && el.error.code;
      ssLog("CORS reload failed", code ? `(media error ${code})` : "(timeout)", state.src || "");
      finish(false);
    };
    const timer = setTimeout(onError, CORS_RELOAD_TIMEOUT_MS);

    corsPending.add(el);
    el.addEventListener("loadedmetadata", onLoaded);
    el.addEventListener("error", onError);
    try {
      el.crossOrigin = "anonymous";
      reloadSource();
    } catch {
      finish(false);
    }
  });
}

function boostDb(settings) {
  if (settings.muted) return 0;
  const volumeDb = 20 * Math.log10(Math.max(settings.volume, 1) / 100);
  const eqDb = Math.max(0, ...settings.eqGains);
  const modeDb = settings.mode === "voice" ? 8 : settings.mode === "bass" ? 10 : 0;
  return volumeDb + eqDb + modeDb;
}

function makeSoftClipCurve() {
  const samples = 8193;
  const curve = new Float32Array(samples);
  const span = 1 - CLIP_KNEE;
  for (let i = 0; i < samples; i++) {
    const x = ((i / (samples - 1)) * 2 - 1) * CLIP_RANGE;
    const ax = Math.abs(x);
    const y = ax <= CLIP_KNEE ? ax : CLIP_KNEE + span * Math.tanh((ax - CLIP_KNEE) / span);
    curve[i] = Math.sign(x) * y;
  }
  return curve;
}

function markDrm(kind) {
  drmState.inUse = true;
  if (kind === "encrypted") drmState.encryptedEvent = true;
  if (kind === "mediaKeys") drmState.mediaKeys = true;
}

// "encrypted" events are caught by the document-level capture listener below,
// so per-element listeners (previously re-added on every scan) are unneeded.
function watchForDrm(el) {
  try {
    if (el.mediaKeys) markDrm("mediaKeys");
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

// --- Hidden-player bridge (Firefox MAIN-world script on Spotify/SoundCloud) --
// inject/media_main.js controls players this script cannot see (detached or in
// shadow DOM) and reports them here. Only registered on these hosts.
const IS_MAIN_HOST = /(^|\.)soundcloud\.com$|^open\.spotify\.com$/i.test(window.location.hostname || "");
const MAIN_REPLY_WAIT_MS = 150;

const mainState = { present: false, media: 0, hooked: 0, readable: 0, drm: false };
let mainWaiters = [];

function postMainSettings(settings) {
  if (!IS_MAIN_HOST) return;
  try {
    window.postMessage({
      source: "SoundSphere",
      type: "SS_MAIN_SETTINGS",
      payload: {
        volume: settings.volume,
        muted: settings.muted,
        mode: settings.mode,
        eqGains: settings.eqGains.slice()
      }
    }, "*");
  } catch {}
}

// Resolves on the page script's next status report (or after timeoutMs).
function waitForMainStatus(timeoutMs) {
  if (!IS_MAIN_HOST) return Promise.resolve(false);
  return new Promise(resolve => {
    const waiter = ok => {
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      mainWaiters = mainWaiters.filter(w => w !== waiter);
      resolve(false);
    }, timeoutMs);
    mainWaiters.push(waiter);
  });
}

window.addEventListener("message", event => {
  if (!event || event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "SoundSphereMain" || data.type !== "SS_MAIN_STATUS") return;
  const p = data.payload || {};
  mainState.present = true;
  mainState.media = clamp(p.media, 0, 64);
  mainState.hooked = clamp(p.hooked, 0, 64);
  mainState.readable = clamp(p.readable, 0, 64);
  mainState.drm = !!p.drm;
  const waiters = mainWaiters;
  mainWaiters = [];
  waiters.forEach(w => w(true));
});

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
  constructor(onRunning) {
    this.ctx = null;
    this.input = null;
    this.gain = null;
    this.modeFilter = null;
    this.eq = [];
    this.compressor = null;
    this.clipInput = null;
    this.shaper = null;
    this.output = null;
    this.onRunning = onRunning;
  }

  isRunning() {
    return !!this.ctx && this.ctx.state === "running";
  }

  // Resolves true once the context runs, false after timeoutMs. A fresh
  // context reports "suspended" until the browser lets it start.
  waitForRunning(timeoutMs) {
    if (!this.ctx) return Promise.resolve(false);
    if (this.isRunning()) return Promise.resolve(true);
    this.resume();
    return new Promise(resolve => {
      const done = value => {
        clearTimeout(timer);
        this.ctx.removeEventListener("statechange", onChange);
        resolve(value);
      };
      const onChange = () => { if (this.isRunning()) done(true); };
      const timer = setTimeout(() => done(this.isRunning()), timeoutMs);
      this.ctx.addEventListener("statechange", onChange);
    });
  }

  ensure() {
    if (this.ctx) return true;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return false;

    this.ctx = new AudioContextClass();
    this.ctx.addEventListener("statechange", () => {
      if (this.isRunning() && this.onRunning) this.onRunning();
    });
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

    // Ratio stays at 1 (transparent) until settings boost; see apply().
    this.compressor = this.ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -8;
    this.compressor.knee.value = 18;
    this.compressor.ratio.value = 1;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.25;

    // WaveShaper maps [-1, 1]; the pre-gain lets the curve cover +12 dBFS.
    this.clipInput = this.ctx.createGain();
    this.clipInput.gain.value = 1 / CLIP_RANGE;
    this.shaper = this.ctx.createWaveShaper();
    this.shaper.curve = makeSoftClipCurve();
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
    this.compressor.connect(this.clipInput);
    this.clipInput.connect(this.shaper);
    this.shaper.connect(this.output);
    this.output.connect(this.ctx.destination);

    const resume = () => this.resume();
    window.addEventListener("pointerdown", resume, { passive: true });
    window.addEventListener("keydown", resume, { passive: true });
    return true;
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
    const amount = Math.max(0, Math.min(1, boostDb(settings) / 6));
    this.compressor.ratio.setTargetAtTime(1 + 3 * amount, t, 0.05);
    this.resume();
  }
}

function mediaElements() {
  try {
    return Array.from(document.querySelectorAll("audio,video"));
  } catch {
    return [];
  }
}

class MediaHook {
  constructor(bus) {
    this.bus = bus;
    this.sources = new WeakMap();
    this.hookedCount = 0;
  }

  isHooked(el) {
    return this.sources.has(el);
  }

  // Could be rerouted through WebAudio without going silent (once running).
  canHook(el) {
    if (!isMediaElement(el) || this.sources.has(el) || corsPending.has(el)) return false;
    watchForDrm(el);
    if (drmState.inUse) return false;
    return isCorsReadable(el);
  }

  hook(el) {
    if (this.sources.has(el)) return true;
    if (!this.canHook(el)) return false;
    if (!this.bus.ensure()) return false;

    // createMediaElementSource is irreversible; rerouting into a context that
    // is not running yet would silence the element. Retry on statechange.
    if (!this.bus.isRunning()) {
      this.bus.resume();
      return false;
    }

    try {
      const source = this.bus.ctx.createMediaElementSource(el);
      source.connect(this.bus.input);
      this.sources.set(el, source);
      this.hookedCount += 1;
      return true;
    } catch {
      return false;
    }
  }

  hookAll() {
    let hooked = false;
    for (const el of mediaElements()) {
      if (this.hook(el)) hooked = true;
    }
    return hooked;
  }

  hasCandidates() {
    return mediaElements().some(el => this.canHook(el));
  }
}

class SoundSphereContentController {
  constructor() {
    this.bus = new AudioBus(() => this.onContextRunning());
    this.hook = new MediaHook(this.bus);
    this.settings = normalizeSettings({});
    this.started = false;
    this.active = false;
    this.backend = "basic";
    // Element state SoundSphere changed, so it can be handed back untouched.
    this.originalVolume = new WeakMap();
    this.mutedByUs = new WeakSet();
    // Set when the background can add CORS headers for this tab (Firefox).
    this.corsUnlockAvailable = false;
    this.corsReloads = new Map(); // element -> reload promise
    this.corsFailed = new WeakSet();
  }

  // Cross-origin media that could be boosted once the background adds CORS
  // headers for this tab and the element is reloaded in CORS mode.
  corsCandidates() {
    if (!this.corsUnlockAvailable || drmState.inUse) return [];
    return mediaElements().filter(el => {
      watchForDrm(el);
      return !drmState.inUse &&
        !this.hook.isHooked(el) &&
        !this.corsFailed.has(el) &&
        !this.corsReloads.has(el) &&
        isCorsBlocked(el);
    });
  }

  // Called by the background after it installed the tab's CORS header rule.
  async unlockCors() {
    for (const el of this.corsCandidates()) {
      const url = el.currentSrc || el.src;
      ssLog("CORS unlock candidate:", url);
      const reload = probeCors(url)
        .then(probeOk => (probeOk ? reloadWithCors(el) : false))
        .then(ok => {
          this.corsReloads.delete(el);
          if (!ok) this.corsFailed.add(el);
          ssLog("CORS unlock", ok ? "succeeded" : "skipped (player left untouched)", url);
          return ok;
        });
      this.corsReloads.set(el, reload);
    }
    await Promise.all(Array.from(this.corsReloads.values()));

    this.hook.hookAll();
    if (this.hook.hasCandidates() && !this.bus.isRunning()) {
      if (await this.bus.waitForRunning(CONTEXT_START_WAIT_MS)) this.hook.hookAll();
    }
    return this.applyNow();
  }

  start() {
    if (this.started) return;
    this.started = true;
    injectWebAudioTap();
    // Media created later is picked up when it starts playing. A subtree
    // MutationObserver (previous approach) cost a querySelectorAll per DOM
    // insertion on busy pages and caught nothing "play" does not.
    document.addEventListener("play", event => this.onPlay(event.target), true);
  }

  hasMedia() {
    return mediaElements().length > 0 || this.hook.hookedCount > 0 || mainState.media > 0;
  }

  onPlay(el) {
    if (!this.active || !isMediaElement(el)) return;
    this.hook.hook(el);
    this.applyNow();
  }

  onContextRunning() {
    if (!this.active) return;
    if (this.hook.hookAll()) this.applyNow();
  }

  restoreElement(el) {
    if (this.originalVolume.has(el)) {
      try { el.volume = this.originalVolume.get(el); } catch {}
      this.originalVolume.delete(el);
    }
    if (this.mutedByUs.has(el)) {
      try { el.muted = false; } catch {}
      this.mutedByUs.delete(el);
    }
  }

  // Basic mode: scale relative to the player's own volume and never above it,
  // so falling back can't make a page suddenly louder.
  applyBasicTo(el, settings) {
    try {
      if (!this.originalVolume.has(el)) this.originalVolume.set(el, el.volume);
      const base = this.originalVolume.get(el);
      el.volume = Math.max(0, Math.min(1, base * Math.min(1, settings.volume / 100)));

      if (settings.muted || settings.volume <= 0) {
        if (!el.muted) {
          el.muted = true;
          this.mutedByUs.add(el);
        }
      } else if (this.mutedByUs.has(el)) {
        el.muted = false;
        this.mutedByUs.delete(el);
      }
    } catch {}
  }

  syncElements(settings) {
    for (const el of mediaElements()) {
      watchForDrm(el);
      // Hooked elements are boosted in WebAudio; give the player its volume back.
      if (this.hook.isHooked(el)) this.restoreElement(el);
      else this.applyBasicTo(el, settings);
    }
  }

  async apply(settings) {
    this.settings = normalizeSettings(settings);
    this.active = true;
    this.start();
    pingTap();
    this.hook.hookAll();

    // A new AudioContext starts "suspended" and switches to "running" shortly
    // after (or only after a page gesture). Wait briefly before deciding.
    if (!drmState.inUse && this.hook.hasCandidates() && !this.bus.isRunning()) {
      if (await this.bus.waitForRunning(CONTEXT_START_WAIT_MS)) this.hook.hookAll();
    }
    const result = this.applyNow();
    if (!IS_MAIN_HOST) return result;
    // Let the page-world script apply and report its hidden players.
    await waitForMainStatus(MAIN_REPLY_WAIT_MS);
    return this.buildResult();
  }

  applyNow() {
    const settings = drmState.inUse
      ? normalizeSettings({
        volume: clamp(this.settings.volume, 0, 100),
        muted: this.settings.muted,
        mode: "default",
        eqGains: []
      })
      : this.settings;

    if (this.hook.hookedCount > 0) this.bus.apply(settings);
    postTapSettings(settings);
    postMainSettings(this.settings); // page script clamps DRM players itself
    this.syncElements(settings);

    const previousBackend = this.backend;
    if (drmState.inUse) this.backend = "protected-basic";
    else if (this.hook.hookedCount > 0) this.backend = "media-element";
    else if (tapState.contexts > 0) this.backend = "page-webaudio";
    else this.backend = "basic";
    if (this.backend !== previousBackend || !this.loggedBackend) {
      this.loggedBackend = true;
      ssLog("backend:", this.backend, "| media:", mediaElements().length, "| hooked:", this.hook.hookedCount,
        "| drm:", drmState.inUse, "| context:", this.bus.ctx ? this.bus.ctx.state : "none");
    }

    return this.buildResult();
  }

  buildResult() {
    const result = this.status();
    // Ask the background to unlock cross-origin media only when the user
    // wants more than the element alone can give (boost / EQ / mode).
    result.corsUnlockNeeded = needsProcessing(this.settings) && this.corsCandidates().length > 0;
    return result;
  }

  reset() {
    if (!this.started) return;
    this.active = false;
    this.settings = normalizeSettings({});
    if (this.hook.hookedCount > 0) this.bus.apply(this.settings);
    postTapSettings(this.settings);
    postMainSettings(this.settings);
    for (const el of mediaElements()) this.restoreElement(el);
    this.backend = "basic";
  }

  status() {
    // Hidden players controlled by the page-world script (Spotify/SoundCloud).
    const mainBoostable = mainState.hooked > 0 || mainState.readable > 0;
    const mainProtected = mainState.drm && !mainBoostable;

    // Before the first apply nothing is hooked yet, so report what *can* be
    // boosted (CORS-readable media present) rather than what already is.
    const canBoost = mainBoostable || (!drmState.inUse && (
      this.hook.hookedCount > 0 ||
      tapState.contexts > 0 ||
      this.hook.hasCandidates() ||
      this.corsReloads.size > 0 ||
      this.corsCandidates().length > 0
    ));

    let backend = this.backend;
    if (backend === "basic" && mainState.hooked > 0) backend = "media-element";
    else if (backend === "basic" && mainProtected) backend = "protected-basic";

    let reason = "";
    if (drmState.inUse || (mainProtected && !canBoost)) {
      reason = "Protected playback detected. Basic 0-100 volume only.";
    } else if (!canBoost) {
      reason = this.hasMedia()
        ? "This player's audio can't be processed here. Basic 0-100 volume only."
        : "No media found yet. Basic 0-100 volume only.";
    } else if (this.active && this.hook.hookedCount === 0 && this.hook.hasCandidates() &&
      !this.bus.isRunning()) {
      reason = "Click the page once to enable boost and EQ.";
    }

    return {
      ok: true,
      backend,
      canBoost,
      engaged: this.active,
      hooked: this.hook.hookedCount + mainState.hooked,
      contextState: this.bus.ctx ? this.bus.ctx.state : "none",
      tapReady: tapState.ready,
      tapContexts: tapState.contexts,
      hiddenPlayers: mainState.media,
      drm: { ...drmState, hiddenPlayer: mainState.drm },
      reason
    };
  }

}

const controller = new SoundSphereContentController();

// The background broadcasts to every frame of the tab and keeps the first
// answer. Frames with media answer at once; the top frame answers last as a
// fallback; other frames (ads, widgets) stay silent so they can't report a
// misleading "basic" status for the whole tab.
// Media frames answer APPLY after at most CONTEXT_START_WAIT_MS and STATUS
// synchronously, so the media-less top frame waits just past those.
const TOP_FRAME_APPLY_DELAY_MS = CONTEXT_START_WAIT_MS + 100;
const TOP_FRAME_STATUS_DELAY_MS = 60;

function isRelevantFrame() {
  return controller.hasMedia() || tapState.contexts > 0;
}

// Reloads take up to CORS_RELOAD_TIMEOUT_MS; a frame with nothing to reload
// answers only after that so it can't pre-empt the frame doing the work.
const TOP_FRAME_CORS_DELAY_MS = CORS_RELOAD_TIMEOUT_MS + 1000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return undefined;
  if (message.corsUnlock) controller.corsUnlockAvailable = true;

  if (message.type === "SS_CONTENT_CORS_RELOAD") {
    const relevant = controller.corsCandidates().length > 0 || controller.corsReloads.size > 0;
    if (!relevant && !IS_TOP_FRAME) return undefined;
    if (!relevant) {
      setTimeout(() => sendResponse(controller.status()), TOP_FRAME_CORS_DELAY_MS);
      return true;
    }
    controller.unlockCors().then(sendResponse);
    return true;
  }

  if (message.type === "SS_CONTENT_APPLY") {
    const relevant = isRelevantFrame();
    const pending = controller.apply(message.settings);
    if (!relevant && !IS_TOP_FRAME) return undefined; // apply silently
    pending.then(result => {
      if (relevant) sendResponse(result);
      else setTimeout(() => sendResponse(controller.status()), TOP_FRAME_APPLY_DELAY_MS);
    });
    return true;
  }

  if (message.type === "SS_CONTENT_STATUS") {
    if (isRelevantFrame()) {
      sendResponse(controller.status());
      return undefined;
    }
    if (!IS_TOP_FRAME) return undefined;
    setTimeout(() => sendResponse(controller.status()), TOP_FRAME_STATUS_DELAY_MS);
    return true;
  }

  if (message.type === "SS_CONTENT_RESET") {
    controller.reset();
    if (IS_TOP_FRAME) sendResponse({ ok: true });
    return undefined;
  }

  return undefined;
});
