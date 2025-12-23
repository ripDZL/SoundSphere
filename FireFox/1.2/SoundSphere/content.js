"use strict";

/*
  SoundSphere — content script audio engine (Firefox MV2)

  This script runs in the page, discovers media sources, and (when allowed)
  routes them through WebAudio so SoundSphere can apply:
    - Gain (including >100% “Overdrive”)
    - 10-band EQ
    - Voice / Bass modes

  Some players (notably Spotify Web in Firefox-family browsers) may use
  protected playback; in those cases SoundSphere falls back to basic
  mute + 0–100% volume control.
*/

const API = typeof browser !== "undefined" ? browser : chrome;

// Host flags (used to avoid applying experimental hooks on sites that are
// known to be sensitive to audio pipeline tampering).
const HOSTNAME = (() => {
  try {
    return String(location?.hostname || "").toLowerCase();
  } catch {
    return "";
  }
})();

const IS_SPOTIFY = HOSTNAME === "open.spotify.com";

// ---------------------------------------------------------------------------
// Protected playback (DRM / EME) detection
//
// Spotify Web may use EME (e.g. Widevine CDM). When that happens, browsers can
// intentionally restrict access to the raw media samples, which prevents
// extensions from reliably processing audio via WebAudio.
// We detect common EME signals and expose them to the popup UI so we can
// gracefully fall back to "basic" controls.
// ---------------------------------------------------------------------------

const DRM_GUARD = (() => {
  const state = {
    inUse: false,
    encryptedEvent: false,
    mediaKeys: false,
    lastChangedAt: 0
  };

  const watched = new WeakSet();

  function mark(kind) {
    if (kind === "encrypted") state.encryptedEvent = true;
    if (kind === "mediaKeys") state.mediaKeys = true;
    if (!state.inUse) state.inUse = true;
    state.lastChangedAt = Date.now();
  }

  function inspectElement(el) {
    try {
      if (el && el.mediaKeys) mark("mediaKeys");
    } catch {}
  }

  function watchElement(el) {
    if (!el || watched.has(el)) return;
    watched.add(el);

    inspectElement(el);

    try {
      // 'encrypted' fires when the UA encounters encrypted init data for EME.
      // We only need the first signal.
      el.addEventListener(
        "encrypted",
        () => mark("encrypted"),
        { once: true, passive: true }
      );
    } catch {}
  }

  function scan() {
    try {
      const list = document.querySelectorAll("audio,video");
      for (const el of list) watchElement(el);
    } catch {}
  }

  if (IS_SPOTIFY) {
    // Scan periodically for a short time after load. Spotify often creates
    // the media element lazily after user interaction.
    let ticks = 0;
    const t = setInterval(() => {
      scan();
      ticks++;
      if (state.inUse || ticks >= 40) clearInterval(t); // ~100s max
    }, 2500);
    setTimeout(scan, 600);
  }

  // Expose a narrow hook for page-context probes (e.g., setMediaKeys patch)
  // so we can mark DRM usage even if the encrypted event fires before we
  // attach listeners.
  return { state, watchElement, scan, markExternal: mark };
})();

// Spotify EME can fire MediaEncryptedEvent before we ever touch the specific
// <audio> element. Attaching a capture-phase listener at the document level
// keeps detection passive and avoids prototype patching that could interfere
// with playback on hardened players.
if (IS_SPOTIFY) {
  try {
    document.addEventListener("encrypted", () => {
      try { DRM_GUARD.markExternal("encrypted"); } catch {}
    }, true);
  } catch {}
}

// Runtime flag controlled via Options (storage). Kept separate from the
// controller instance so low-level hooks can read it without importing state.
let spotifyExperimentalEnabled = false;

// ---------------------------------------------------------------------------
// Page-context WebAudio tap
// ---------------------------------------------------------------------------
// Some sites build audio using WebAudio graphs rather than exposing a
// hookable <audio>/<video> element. To improve coverage, we install a
// conservative "master bus" patch in the page context (Firefox-only) that
// reroutes WebAudio connections to destination through SoundSphere's chain.
//
// This remains best-effort: if a site is DRM-protected or uses unusual
// routing, the tap may not activate.

const WEB_AUDIO_TAP = {
  ready: false,
  lastSeenAt: 0
};

function injectWebAudioTap() {
  // Attempt A: inject a page script (may be blocked by CSP on some sites).
  try {
    const url = API.runtime.getURL("inject/webaudio_tap.js");
    const s = document.createElement("script");
    s.src = url;
    s.async = false;
    (document.documentElement || document.head || document).appendChild(s);
    s.addEventListener("load", () => s.remove());
    s.addEventListener("error", () => s.remove());
  } catch {
    // ignore
  }
}

// Listen for tap readiness and allow settings updates.
window.addEventListener(
  "message",
  (ev) => {
    if (!ev || ev.source !== window) return;
    const data = ev.data;
    if (!data || typeof data !== "object") return;
    if (data.source !== "SoundSphereTap") return;

    if (data.type === "SS_TAP_READY") {
      WEB_AUDIO_TAP.ready = true;
      WEB_AUDIO_TAP.lastSeenAt = Date.now();
    }
    if (data.type === "SS_TAP_PONG") {
      WEB_AUDIO_TAP.ready = true;
      WEB_AUDIO_TAP.lastSeenAt = Date.now();
    }
  },
  false
);

function postSettingsToTap(payload) {
  try {
    window.postMessage({ source: "SoundSphere", type: "SS_SETTINGS", payload }, "*");
  } catch {
    // ignore
  }
}

function pingWebAudioTap() {
  try {
    window.postMessage({ source: "SoundSphere", type: "SS_PING" }, "*");
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Spotify Graph Tap (Firefox-family only, no screen capture)
// ---------------------------------------------------------------------------
//
// Spotify Web is frequently delivered through protected / segmented pipelines
// where attaching a MediaElementAudioSourceNode or captureStream() is blocked
// or unreliable. When Spotify uses WebAudio internally, we can still apply
// SoundSphere processing by rerouting WebAudio connections to destination
// through a per-context SoundSphere "master bus".
//
// This is a best-effort technique. If Spotify does not use WebAudio for the
// audible path (or if the browser blocks access for protected media), this
// will have no effect. It is intentionally OFF unless the user enables
// "Spotify: Experimental processing" in Options.
//
// Implementation notes
// - This does NOT inject <script> tags (which CSP may block).
// - Instead it uses Firefox-family content-script bridging (wrappedJSObject +
//   exportFunction) when available.
// - No third-party code is used; this is SoundSphere’s own implementation.

const SPOTIFY_TAP = (() => {
  const state = {
    volumePercent: 100,
    muted: false,
    mode: "default",
    eq: new Array(10).fill(0)
  };

  const contexts = new Set();
  const chains = new WeakMap();
  const bypass = new WeakSet();

  let installed = false;
  let lastError = "";

  function clampNumber(n, min, max) {
    const v = Number(n);
    if (!Number.isFinite(v)) return min;
    return Math.max(min, Math.min(max, v));
  }

  function makeSoftClipCurve() {
    const N = 2048;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      curve[i] = x / (1 + 0.65 * Math.abs(x));
    }
    return curve;
  }

  function isAudioParam(x) {
    try {
      return x && typeof x === "object" && typeof x.setValueAtTime === "function" && ("value" in x);
    } catch {
      return false;
    }
  }

  function buildChain(ctx) {
    const input = ctx.createGain();
    const gain = ctx.createGain();

    // Mode block (rebuilt when mode changes)
    let modeIn = ctx.createGain();
    let modeOut = ctx.createGain();
    modeIn.connect(modeOut);

    const eq = EQ_BANDS_HZ.map((hz) => {
      const f = ctx.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = hz;
      f.Q.value = 1.0;
      f.gain.value = 0;
      return f;
    });

    const compressor = ctx.createDynamicsCompressor();
    try {
      compressor.threshold.value = -8;
      compressor.knee.value = 18;
      compressor.ratio.value = 3.5;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
    } catch {}

    const shaper = ctx.createWaveShaper();
    shaper.curve = makeSoftClipCurve();
    shaper.oversample = "2x";

    const output = ctx.createGain();
    output.gain.value = 1;

    // Wire: input -> gain -> modeIn -> modeOut -> eq -> comp -> shaper -> output
    input.connect(gain);
    gain.connect(modeIn);

    let tail = modeOut;
    for (const b of eq) {
      tail.connect(b);
      tail = b;
    }
    tail.connect(compressor);
    compressor.connect(shaper);
    shaper.connect(output);

    bypass.add(output);

    return {
      ctx,
      input,
      gain,
      mode: { in: modeIn, out: modeOut, name: "default" },
      eq,
      compressor,
      shaper,
      output,
      connected: false
    };
  }

  function applyMode(chain) {
    const ctx = chain.ctx;
    const wanted = state.mode === "voice" || state.mode === "bass" ? state.mode : "default";
    if (chain.mode && chain.mode.name === wanted) return;

    // Disconnect existing mode segment safely.
    try { chain.mode.in.disconnect(); } catch {}
    try { chain.mode.out.disconnect(); } catch {}

    const modeIn = ctx.createGain();
    const modeOut = ctx.createGain();

    if (wanted === "voice") {
      const hp = ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 120;
      hp.Q.value = 0.7;

      const presence = ctx.createBiquadFilter();
      presence.type = "peaking";
      presence.frequency.value = 3200;
      presence.Q.value = 1.1;
      presence.gain.value = 8;

      modeIn.connect(hp);
      hp.connect(presence);
      presence.connect(modeOut);
    } else if (wanted === "bass") {
      const ls = ctx.createBiquadFilter();
      ls.type = "lowshelf";
      ls.frequency.value = 90;
      ls.gain.value = 10;
      modeIn.connect(ls);
      ls.connect(modeOut);
    } else {
      modeIn.connect(modeOut);
    }

    // Rewire: gain -> modeIn
    try { chain.gain.disconnect(); } catch {}
    chain.gain.connect(modeIn);

    // modeOut -> eq[0] (or compressor if EQ missing)
    const start = chain.eq[0] || chain.compressor;
    modeOut.connect(start);

    chain.mode = { in: modeIn, out: modeOut, name: wanted };
  }

  function applySettings(chain) {
    // Gain
    const g = state.muted ? 0 : clampNumber(state.volumePercent, 0, 800) / 100;
    try {
      chain.gain.gain.setValueAtTime(g, chain.ctx.currentTime);
    } catch {
      chain.gain.gain.value = g;
    }

    // EQ
    for (let i = 0; i < chain.eq.length; i++) {
      const db = clampNumber(state.eq[i] ?? 0, -24, 24);
      try {
        chain.eq[i].gain.setValueAtTime(db, chain.ctx.currentTime);
      } catch {
        chain.eq[i].gain.value = db;
      }
    }

    applyMode(chain);
  }

  function getChain(ctx) {
    let chain = chains.get(ctx);
    if (!chain) {
      chain = buildChain(ctx);
      chains.set(ctx, chain);
      contexts.add(ctx);
      applySettings(chain);
    }
    return chain;
  }

  function install() {
    if (installed) return;
    installed = true;

    // Only meaningful on Spotify.
    if (!IS_SPOTIFY) return;

    // Firefox-family bridge primitives.
    const w = (() => {
      try { return window.wrappedJSObject || null; } catch { return null; }
    })();

    if (!w) {
      lastError = "wrappedJSObject unavailable";
      return;
    }

    if (typeof exportFunction !== "function") {
      lastError = "exportFunction unavailable";
      return;
    }

    const proto = w.AudioNode && w.AudioNode.prototype ? w.AudioNode.prototype : null;
    if (!proto || typeof proto.connect !== "function") {
      lastError = "AudioNode.connect unavailable";
      return;
    }

    const nativeConnect = proto.connect;

    // Patch connect. This function executes in the extension content-script
    // scope but is callable by page scripts.
    function patchedConnect(...args) {
      try {
        const dest = args[0];

        if (isAudioParam(dest)) {
          return nativeConnect.apply(this, args);
        }

        const ctx = this && this.context;
        if (!ctx) {
          return nativeConnect.apply(this, args);
        }

        // Only reroute direct destination connections.
        if (dest === ctx.destination && !bypass.has(this)) {
          const chain = getChain(ctx);

          // Connect master output to destination exactly once.
          if (!chain.connected) {
            try { nativeConnect.call(chain.output, ctx.destination); } catch {}
            chain.connected = true;
          }

          // Route current node into master input.
          try { nativeConnect.call(this, chain.input); } catch {}
          return dest;
        }
      } catch {
        // fall through
      }

      return nativeConnect.apply(this, args);
    }

    try {
      exportFunction(patchedConnect, proto, { defineAs: "connect" });
    } catch (e) {
      lastError = String(e && e.message ? e.message : e);
    }
  }

  function apply(payload) {
    if (!payload || typeof payload !== "object") return;

    const vp = typeof payload.volumePercent === "number" ? payload.volumePercent : payload.volume;
    state.volumePercent = clampNumber(vp ?? state.volumePercent, 0, 800);
    state.muted = !!payload.muted;
    state.mode = payload.mode === "voice" || payload.mode === "bass" ? payload.mode : "default";

    if (Array.isArray(payload.eq)) {
      const arr = payload.eq.slice(0, 10);
      while (arr.length < 10) arr.push(0);
      state.eq = arr.map((v) => clampNumber(v, -24, 24));
    }

    // Apply to all known contexts.
    for (const ctx of Array.from(contexts)) {
      const chain = chains.get(ctx);
      if (chain) applySettings(chain);
    }
  }

  function engaged() {
    return contexts.size > 0;
  }

  function info() {
    return {
      installed,
      contexts: contexts.size,
      lastError
    };
  }

  return { install, apply, engaged, info };
})();

// WebAudio Tap is experimental. It helps on some WebAudio-heavy sites, but
// can disrupt segmented/protected pipelines. We explicitly avoid installing it
// on Spotify Web.
if (!IS_SPOTIFY) {
  injectWebAudioTap();
  pingWebAudioTap();
}

// 10-band ISO-ish center frequencies (Hz)
const EQ_BANDS_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function clampNumber(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function isMediaElement(node) {
  return (
    node &&
    node.nodeType === 1 &&
    (node.tagName === "AUDIO" || node.tagName === "VIDEO")
  );
}

function isTopFrameSafe() {
  try {
    return window.top === window;
  } catch {
    return false;
  }
}

function dispatchRangeEvents(el) {
  try {
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } catch {}
  try {
    el.dispatchEvent(new Event("change", { bubbles: true }));
  } catch {}
}

function simulatePointerDragToPercent(target, pct01) {
  const p = clampNumber(pct01, 0, 1);
  let rect;
  try {
    rect = target.getBoundingClientRect();
  } catch {
    return;
  }
  if (!rect || !rect.width || !rect.height) return;

  const x = rect.left + rect.width * p;
  const y = rect.top + rect.height / 2;
  const opts = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    screenX: x,
    screenY: y,
    buttons: 1
  };

  try { target.dispatchEvent(new PointerEvent("pointerdown", opts)); } catch {}
  try { target.dispatchEvent(new MouseEvent("mousedown", opts)); } catch {}
  try { target.dispatchEvent(new PointerEvent("pointermove", opts)); } catch {}
  try { target.dispatchEvent(new MouseEvent("mousemove", opts)); } catch {}
  try { target.dispatchEvent(new PointerEvent("pointerup", opts)); } catch {}
  try { target.dispatchEvent(new MouseEvent("mouseup", opts)); } catch {}
  try { target.dispatchEvent(new MouseEvent("click", Object.assign({}, opts, { buttons: 0 }))); } catch {}
}

function applySpotifyUiVolumeMute(volume01, muted) {
  // Keep this lightweight and conservative.
  if (!isTopFrameSafe()) return;

  const v01 = clampNumber(volume01, 0, 1);

  // Toggle mute if needed.
  try {
    const btn =
      document.querySelector("button[aria-label*='Mute'], button[aria-label*='Unmute']") ||
      document.querySelector("button[data-testid='control-button-volume'], button[data-testid*='volume']") ||
      document.querySelector("button[aria-controls*='volume'], button[aria-haspopup='menu'][aria-label*='Volume']") ||
      null;

    if (btn) {
      const label = String(btn.getAttribute("aria-label") || "");
      const wantsMute = !!muted;
      const isMuteAction = /mute/i.test(label) && !/unmute/i.test(label);
      const isUnmuteAction = /unmute/i.test(label);

      if (wantsMute && isMuteAction) btn.click();
      if (!wantsMute && isUnmuteAction) btn.click();
    }
  } catch {}

  // Prefer a native range input if present.
  try {
    const range =
      document.querySelector("input[type='range'][data-testid='volume-bar']") ||
      document.querySelector("input[type='range'][aria-label*='Volume']") ||
      document.querySelector("[data-testid*='volume'] input[type='range']") ||
      document.querySelector("input[type='range'][data-testid*='volume']") ||
      // Very general fallback: any range input that looks like volume.
      Array.from(document.querySelectorAll("input[type='range']")).find((el) =>
        /volume/i.test(String(el.getAttribute("aria-label") || ""))
      ) ||
      null;
    if (range) {
      const min = Number(range.min || 0);
      const max = Number(range.max || 1);
      const v = min + (max - min) * v01;
      range.value = String(v);
      dispatchRangeEvents(range);
      return;
    }
  } catch {}

  // Fall back to role=slider (React-style sliders).
  try {
    const slider =
      document.querySelector("[role='slider'][data-testid='volume-bar']") ||
      document.querySelector("[role='slider'][aria-label*='Volume']") ||
      document.querySelector("[data-testid*='volume'] [role='slider']") ||
      document.querySelector("[data-testid='volume-bar'][role='slider']") ||
      document.querySelector("[data-testid='volume-bar'] [role='slider']") ||
      null;
    if (slider) {
      simulatePointerDragToPercent(slider, v01);
    }
  } catch {}
}

let soundCloudEnforceTimer = null;

function applySoundCloudUiVolumeMute(volume01, muted) {
  if (!isTopFrameSafe()) return;

  // Direct element volume/mute (SoundCloud sometimes snaps these back; we enforce briefly).
  const applyElements = () => {
    const audios = document.querySelectorAll("audio,video");
    for (const el of audios) {
      try {
        el.muted = !!muted;
      } catch {}
      try {
        el.volume = clampNumber(volume01, 0, 1);
      } catch {}
    }
  };
  try { applyElements(); } catch {}

  // UI-based mute/volume where available.
  try {
    const btn =
      document.querySelector("button[aria-label*='Mute'], button[aria-label*='Unmute']") ||
      document.querySelector(".volume__button, .playControls__soundBadge button") ||
      null;
    if (btn) {
      const label = String(btn.getAttribute("aria-label") || btn.getAttribute("title") || "");
      const wantsMute = !!muted;
      const isMuteAction = /mute/i.test(label) && !/unmute/i.test(label);
      const isUnmuteAction = /unmute/i.test(label);
      if (wantsMute && isMuteAction) btn.click();
      if (!wantsMute && isUnmuteAction) btn.click();
    }
  } catch {}

  try {
    const range =
      document.querySelector("input[type='range'][aria-label*='volume']") ||
      document.querySelector(".volume__sliderWrapper input[type='range']") ||
      document.querySelector(".playControls__soundBadge input[type='range']") ||
      null;
    if (range) {
      const min = Number(range.min || 0);
      const max = Number(range.max || 1);
      const v = min + (max - min) * clampNumber(volume01, 0, 1);
      range.value = String(v);
      dispatchRangeEvents(range);
    } else {
      const slider = document.querySelector("[role='slider'][aria-label*='volume']");
      if (slider) simulatePointerDragToPercent(slider, volume01);
    }
  } catch {}

  // Short enforcement window to counter "snap back" volume logic.
  try {
    if (soundCloudEnforceTimer) clearInterval(soundCloudEnforceTimer);
    let ticks = 0;
    soundCloudEnforceTimer = setInterval(() => {
      ticks++;
      applyElements();
      if (ticks >= 15) {
        clearInterval(soundCloudEnforceTimer);
        soundCloudEnforceTimer = null;
      }
    }, 200);
  } catch {}
}

class AudioBus {
  constructor() {
    this.ctx = null;
    this.input = null;
    this.gain = null;
    this.modeStage = null;
    this.eq = [];
    this.compressor = null;
    this.softClip = null;
    this.output = null;
    this._wired = false;
  }

  ensure() {
    if (this._wired) return true;

    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;

    this.ctx = new AC();

    // Mix point for multiple media elements
    this.input = this.ctx.createGain();

    // Main gain (implements boost)
    this.gain = this.ctx.createGain();

    // Mode stage implemented as a "chain segment" with nodes that can be rewired.
    this.modeStage = { in: this.ctx.createGain(), out: this.ctx.createGain() };
    this.modeStage.in.connect(this.modeStage.out);

    // 10-band EQ
    this.eq = EQ_BANDS_HZ.map((hz) => {
      const f = this.ctx.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = hz;
      f.Q.value = 1.0;
      f.gain.value = 0;
      return f;
    });

    // Compressor as a safety net
    this.compressor = this.ctx.createDynamicsCompressor();
    try {
      this.compressor.threshold.value = -8;
      this.compressor.knee.value = 18;
      this.compressor.ratio.value = 3.5;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.25;
    } catch {}

    // Soft-clipper to reduce harsh digital clipping at high boosts.
    this.softClip = this.ctx.createWaveShaper();
    this.softClip.curve = AudioBus.makeSoftClipCurve();
    this.softClip.oversample = "2x";

    this.output = this.ctx.createGain();
    this.output.gain.value = 1;

    // Wire graph:
    // input -> gain -> modeStage -> eq -> compressor -> softClip -> output -> destination
    this.input.connect(this.gain);
    this.gain.connect(this.modeStage.in);

    let tail = this.modeStage.out;
    for (const band of this.eq) {
      tail.connect(band);
      tail = band;
    }
    tail.connect(this.compressor);
    this.compressor.connect(this.softClip);
    this.softClip.connect(this.output);
    this.output.connect(this.ctx.destination);

    // Resume context on user gesture.
    const resume = () => {
      if (this.ctx && this.ctx.state === "suspended") {
        this.ctx.resume().catch(() => {});
      }
    };
    window.addEventListener("pointerdown", resume, { passive: true });
    window.addEventListener("keydown", resume, { passive: true });

    this._wired = true;
    return true;
  }

  static makeSoftClipCurve() {
    // Smooth tanh-ish curve. Fixed size; cheap and stable.
    const N = 2048;
    const curve = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const x = (i / (N - 1)) * 2 - 1;
      // Rational approximation for soft saturation.
      curve[i] = x / (1 + 0.65 * Math.abs(x));
    }
    return curve;
  }

  setGainLinear(value) {
    if (!this._wired || !this.ctx || !this.gain) return;
    const g = clampNumber(value, 0, 8);
    try {
      this.gain.gain.setValueAtTime(g, this.ctx.currentTime);
    } catch {
      this.gain.gain.value = g;
    }
  }

  setEqDb(dbArray) {
    if (!this._wired || !this.ctx) return;
    const arr = Array.isArray(dbArray) ? dbArray : [];
    for (let i = 0; i < this.eq.length; i++) {
      const db = Number(arr[i]) || 0;
      try {
        this.eq[i].gain.setValueAtTime(clampNumber(db, -24, 24), this.ctx.currentTime);
      } catch {
        this.eq[i].gain.value = clampNumber(db, -24, 24);
      }
    }
  }

  setMode(mode) {
    if (!this._wired || !this.ctx || !this.modeStage) return;

    // Rebuild mode segment without touching the rest of the graph.
    // Disconnect current segment.
    try {
      this.modeStage.in.disconnect();
    } catch {}
    try {
      this.modeStage.out.disconnect();
    } catch {}

    const input = this.ctx.createGain();
    const output = this.ctx.createGain();

    // Default: passthrough
    let head = input;

    if (mode === "voice") {
      // Speech intelligibility: remove rumble + add presence.
      const hp = this.ctx.createBiquadFilter();
      hp.type = "highpass";
      hp.frequency.value = 120;
      hp.Q.value = 0.7;

      const presence = this.ctx.createBiquadFilter();
      presence.type = "peaking";
      presence.frequency.value = 3200;
      presence.Q.value = 1.1;
      presence.gain.value = 8;

      head.connect(hp);
      hp.connect(presence);
      presence.connect(output);
    } else if (mode === "bass") {
      const ls = this.ctx.createBiquadFilter();
      ls.type = "lowshelf";
      ls.frequency.value = 90;
      ls.gain.value = 10;

      head.connect(ls);
      ls.connect(output);
    } else {
      head.connect(output);
    }

    this.modeStage = { in: input, out: output };

    // Reconnect: gain -> modeStage.in -> modeStage.out -> (first EQ band)
    this.gain.disconnect();
    this.gain.connect(this.modeStage.in);

    // Connect mode output to EQ chain start
    const eqStart = this.eq[0] || this.compressor;
    this.modeStage.out.connect(eqStart);
  }
}

class MediaHook {
  constructor(bus) {
    this.bus = bus;
    this.sources = new WeakMap();
    this.hookedCount = 0;
    this._pendingRetry = new WeakSet();
  }

  _makeSource(el) {
    const ctx = this.bus.ctx;
    if (!ctx) return null;

    // Attempt 1: MediaElementAudioSourceNode
    try {
      return ctx.createMediaElementSource(el);
    } catch {}

    // Attempt 2: captureStream / mozCaptureStream
    try {
      const s =
        typeof el.captureStream === "function"
          ? el.captureStream()
          : typeof el.mozCaptureStream === "function"
          ? el.mozCaptureStream()
          : null;
      if (s) return ctx.createMediaStreamSource(s);
    } catch {}

    return null;
  }

  async hook(el) {
    if (!isMediaElement(el)) return false;

    // Track EME/DRM signals (Spotify).
    if (IS_SPOTIFY) {
      DRM_GUARD.watchElement(el);
    }
    if (!this.bus.ensure()) return false;
    if (this.sources.has(el)) return true;

    // Best-effort: set crossOrigin early. If the media is already playing,
    // we do not force a reload (that would be disruptive).
    // On Spotify, avoid touching crossOrigin because it can change how
    // segmented playback is fetched and can lead to silence.
    if (!IS_SPOTIFY) {
      try {
        if (!el.crossOrigin) el.crossOrigin = "anonymous";
      } catch {}
    }

    const node = this._makeSource(el);
    if (!node) {
      // Some implementations only expose a usable captureStream once playback
      // has started or metadata has loaded. Schedule a one-time retry.
      try {
        if (!this._pendingRetry.has(el)) {
          this._pendingRetry.add(el);
          const retry = () => {
            try { this._pendingRetry.delete(el); } catch {}
            this.hook(el);
          };
          el.addEventListener("playing", retry, { once: true, passive: true });
          el.addEventListener("loadedmetadata", retry, { once: true, passive: true });
        }
      } catch {}
      return false;
    }

    try {
      node.connect(this.bus.input);
      this.sources.set(el, node);
      this.hookedCount++;

      // Spotify experimental mode: silence the native element output so the
      // user hears the processed path only. The MediaCapture-from-element spec
      // allows capture even when muted; implementations vary, so this remains
      // best-effort.
      if (IS_SPOTIFY && spotifyExperimentalEnabled) {
        try { el.muted = true; } catch {}
        try { el.volume = 1; } catch {}
      }

      // When we own gain, keep element volume at unity to avoid 0..1 cap.
      try {
        el.volume = 1;
      } catch {}
      return true;
    } catch {
      return false;
    }
  }

  scan(root = document) {
    const list = root.querySelectorAll ? root.querySelectorAll("audio,video") : [];
    for (const el of list) this.hook(el);
  }
}

class SoundSpherePageController {
  constructor() {
    this.bus = new AudioBus();
    this.hook = new MediaHook(this.bus);

    // Spotify is unusually sensitive to audio pipeline manipulation.
    // By default, SoundSphere uses "basic" controls on Spotify (0..100 + mute).
    // Users may opt into a best-effort in-page processing mode via Options.
    this.spotifyExperimental = false;

    this.volumePercent = 100; // 0..800
    this.muted = false;
    this.mode = "default";
    this.eqDb = new Array(10).fill(0);

    this._observer = null;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;

    if (!IS_SPOTIFY) {
      // Default path: hook <audio>/<video> elements into WebAudio.
      this._installMediaHooks();
    } else if (this.spotifyExperimental) {
      // Spotify path: prefer the Graph Tap (no element tampering, no screen share).
      SPOTIFY_TAP.install();
    }

    this._applyAll();
  }

  _installMediaHooks() {
    // Idempotent hook installer.
    if (this._observer) return;

    // Initial scan
    this.hook.scan();

    // Hook newly-added nodes.
    this._observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const n of m.addedNodes || []) {
          if (isMediaElement(n)) {
            this.hook.hook(n);
          } else if (n && n.querySelectorAll) {
            this.hook.scan(n);
          }
        }
      }
    });

    try {
      this._observer.observe(document.documentElement || document, {
        childList: true,
        subtree: true
      });
    } catch {}

    // Many sites create media lazily. The capture-phase play listener helps.
    document.addEventListener(
      "play",
      (e) => {
        const t = e && e.target;
        if (isMediaElement(t)) this.hook.hook(t);
      },
      true
    );
  }

  _applyAll() {
    // Spotify default safe mode: basic controls only.
    if (IS_SPOTIFY && !this.spotifyExperimental) {
      const v = clampNumber(this.volumePercent, 0, 100) / 100;
      applySpotifyUiVolumeMute(v, !!this.muted);
      return;
    }
    // Prefer WebAudio if at least one element is hooked.
    const usingWebAudio = this.bus._wired && this.hook.hookedCount > 0;
    const usingGenericTap = WEB_AUDIO_TAP.ready;
    const usingSpotifyTap = IS_SPOTIFY && this.spotifyExperimental && SPOTIFY_TAP.engaged();

    const payload = {
      volumePercent: clampNumber(this.volumePercent, 0, 800),
      muted: !!this.muted,
      mode: this.mode,
      eq: this.eqDb.slice()
    };

    // Spotify experimental path: keep Graph Tap settings up-to-date even
    // before we have observed an AudioContext.
    if (IS_SPOTIFY && this.spotifyExperimental) {
      SPOTIFY_TAP.apply(payload);
      if (usingSpotifyTap) return;
    }

    if (usingWebAudio) {
      const gainLinear = this.muted ? 0 : clampNumber(this.volumePercent, 0, 800) / 100;
      this.bus.setGainLinear(gainLinear);
      this.bus.setEqDb(this.eqDb);
      this.bus.setMode(this.mode);
      return;
    }

    // If the page-context WebAudio tap is active, route settings to it.
    // This is used when the site does not expose a hookable media element.
    if (usingGenericTap) {
      postSettingsToTap(payload);
      return;
    }

    // Fallback: basic element controls only (0..100%)
    const v = clampNumber(this.volumePercent, 0, 100) / 100;
    for (const el of document.querySelectorAll("audio,video")) {
      try {
        el.muted = !!this.muted;
        el.volume = v;
      } catch {}
    }

    // Best-effort per-site UI control for players that fight direct volume
    // assignments (Spotify Web, SoundCloud). These remain 0..100% only.
    try {
      if (typeof location !== "undefined") {
        const host = String(location.hostname || "").toLowerCase();
        if (host === "open.spotify.com") {
          applySpotifyUiVolumeMute(v, !!this.muted);
        } else if (host.endsWith("soundcloud.com")) {
          applySoundCloudUiVolumeMute(v, !!this.muted);
        }
      }
    } catch {}
  }

  setVolumePercent(pct) {
    this.volumePercent = clampNumber(pct, 0, 800);
    this.start();
    this._applyAll();
  }

  setMuted(m) {
    this.muted = !!m;
    this.start();
    this._applyAll();
  }

  setMode(mode) {
    this.mode = mode === "voice" || mode === "bass" ? mode : "default";
    this.start();
    this._applyAll();
  }

  setEqDb(arr) {
    const a = Array.isArray(arr) ? arr.slice(0, 10) : [];
    while (a.length < 10) a.push(0);
    this.eqDb = a.map((x) => clampNumber(x, -24, 24));
    this.start();
    this._applyAll();
  }

  getState() {
    const usingWebAudio = this.bus._wired && this.hook.hookedCount > 0;
    const usingSpotifyTap = IS_SPOTIFY && this.spotifyExperimental && SPOTIFY_TAP.engaged();
    const usingTap = WEB_AUDIO_TAP.ready || usingSpotifyTap;

    const drmInUse = IS_SPOTIFY && DRM_GUARD.state.inUse;
    const blockedEffects = !!drmInUse;

    const canBoost = !blockedEffects && (usingWebAudio || usingTap);
    const backend = blockedEffects
      ? "protected"
      : (usingWebAudio
          ? "webaudio"
          : (usingSpotifyTap ? "spotifyTap" : (usingTap ? "tap" : "element")));

    const blockReason = blockedEffects
      ? "Protected playback detected (DRM/Widevine). Advanced SoundSphere processing is not available for Spotify in this browser session. Mute and 0–100% volume remain supported."
      : null;

    return {
      volume: this.volumePercent,
      muted: this.muted,
      mode: this.mode,
      eq: this.eqDb.slice(),
      canBoost,
      backend,
      hooked: this.hook.hookedCount,
      ctxState: this.bus.ctx ? this.bus.ctx.state : "none",
      tapInfo: IS_SPOTIFY ? SPOTIFY_TAP.info() : null,

      drm: drmInUse,
      drmSignals: IS_SPOTIFY
        ? {
            encryptedEvent: !!DRM_GUARD.state.encryptedEvent,
            mediaKeys: !!DRM_GUARD.state.mediaKeys,
            lastChangedAt: DRM_GUARD.state.lastChangedAt || 0
          }
        : null,

      blockedEffects,
      blockReason
    };
  }
}

const controller = new SoundSpherePageController();

// Load saved settings (best-effort). We keep this independent from popup lifetime.
try {
  API.storage.sync.get(
    {
      mode: "default",
      eqGains: new Array(10).fill(0),
      muted: false,
      vol_global: 100,
      spotifyExperimental: false,
    },
    (data) => {
      controller.spotifyExperimental = !!data.spotifyExperimental;
      spotifyExperimentalEnabled = controller.spotifyExperimental;
      if (IS_SPOTIFY && controller.spotifyExperimental) {
        SPOTIFY_TAP.install();
      }
      controller.setMode(data.mode);
      controller.setEqDb(data.eqGains);
      controller.setMuted(!!data.muted);
      controller.setVolumePercent(Number(data.vol_global) || 100);
    }
  );
} catch {
  // ignore
}

// React to Options changes without requiring a full reload.
try {
  API.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !changes) return;
    if (changes.spotifyExperimental) {
      const enabled = !!changes.spotifyExperimental.newValue;
      controller.spotifyExperimental = enabled;
      spotifyExperimentalEnabled = enabled;
      if (IS_SPOTIFY && enabled) {
        SPOTIFY_TAP.install();
      }
      controller.start();
      controller._applyAll();
    }
  });
} catch {}

API.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;

  if (msg.action === "getState") {
    controller.start();
    sendResponse(controller.getState());
    return;
  }

  if (msg.action === "setVolume") {
    controller.setVolumePercent(msg.volume);
    // Save as global for now; popup still handles per-tab remember.
    try {
      API.storage.sync.set({ vol_global: controller.volumePercent });
    } catch {}
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === "toggleMute") {
    controller.setMuted(!controller.muted);
    try {
      API.storage.sync.set({ muted: controller.muted });
    } catch {}
    sendResponse({ ok: true, muted: controller.muted });
    return;
  }

  if (msg.action === "setMuted") {
    controller.setMuted(!!msg.muted);
    try {
      API.storage.sync.set({ muted: controller.muted });
    } catch {}
    sendResponse({ ok: true, muted: controller.muted });
    return;
  }

  if (msg.action === "setMode") {
    controller.setMode(msg.mode);
    try {
      API.storage.sync.set({ mode: controller.mode });
    } catch {}
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === "setEqGains") {
    controller.setEqDb(msg.gains);
    try {
      API.storage.sync.set({ eqGains: controller.eqDb.slice() });
    } catch {}
    sendResponse({ ok: true });
    return;
  }
});
