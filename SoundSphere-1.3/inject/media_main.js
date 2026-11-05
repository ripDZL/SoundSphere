/*
  SoundSphere - hidden player control (page MAIN world, Firefox).

  Some players create their <audio>/<video> without attaching it to the page
  (Spotify Web, SoundCloud) or keep it inside a shadow root. The isolated
  content script cannot see those elements, so this script runs in the page's
  own JavaScript world (manifest "world": "MAIN", Firefox 128+) and:

    - notes every element the page plays (wrapping HTMLMediaElement.play)
    - controls only elements the content script cannot see
    - volume/mute always; boost/EQ through WebAudio when the audio is readable
      (not DRM-protected, and same-origin, blob:, or CORS-enabled)

  Registered only for open.spotify.com and soundcloud.com. It talks to the
  content script with window.postMessage: "SoundSphere" -> settings in,
  "SoundSphereMain" -> status out. MAIN-world scripts have no extension APIs.
*/

(() => {
  "use strict";

  const FLAG = "__soundSphereMediaMain";
  if (window[FLAG]) return;
  try {
    Object.defineProperty(window, FLAG, { value: true });
  } catch {
    return;
  }

  const EQ_BANDS_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const CLIP_RANGE = 4;
  const CLIP_KNEE = 0.85;
  const TRACK_LIMIT = 32;

  const tracked = [];               // elements the page played (newest last)
  const sources = new WeakMap();    // element -> MediaElementAudioSourceNode
  const pageVolume = new WeakMap(); // element -> volume the page asked for
  const mutedByUs = new WeakSet();
  let basicLevel = 1;               // SoundSphere's 0..1 level in basic mode

  // Native volume accessor, captured before the page can touch it.
  const volumeDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume");
  const nativeGetVolume = el => volumeDescriptor.get.call(el);
  const nativeSetVolume = (el, value) => volumeDescriptor.set.call(el, value);
  // Captured before SoundSphere's page WebAudio tap can patch connect(), so
  // this bus is never rerouted through the tap (which would boost twice).
  const nativeConnect = window.AudioNode && window.AudioNode.prototype.connect;
  const DEBUG_LOG = false;
  let bus = null;
  let settings = null;              // null until SoundSphere is used on the tab

  function clamp(value, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return min;
    return Math.max(min, Math.min(max, number));
  }

  function normalize(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    const eq = Array.isArray(s.eqGains) ? s.eqGains.slice(0, 10) : [];
    while (eq.length < 10) eq.push(0);
    return {
      volume: clamp(s.volume ?? 100, 0, 800),
      muted: !!s.muted,
      mode: s.mode === "voice" || s.mode === "bass" ? s.mode : "default",
      eqGains: eq.map(v => clamp(v, -24, 24))
    };
  }

  // The isolated content script handles media it can find with
  // document.querySelectorAll; everything else is ours.
  function isHidden(el) {
    try {
      return !el.isConnected || el.getRootNode() !== document;
    } catch {
      return false;
    }
  }

  function isDrm(el) {
    try {
      return !!el.mediaKeys;
    } catch {
      return false;
    }
  }

  function isReadable(el) {
    try {
      if (el.srcObject) return true;
      if (el.crossOrigin === "anonymous" || el.crossOrigin === "use-credentials") return true;
      const src = el.currentSrc || el.src || "";
      if (!src) return false;
      const url = new URL(src, document.baseURI);
      if (url.protocol === "blob:" || url.protocol === "data:") return true;
      return url.origin === location.origin;
    } catch {
      return false;
    }
  }

  function hiddenMedia() {
    return tracked.filter(isHidden);
  }

  // --- WebAudio bus (same transparent-at-neutral DSP as the extension) ------
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

  function ensureBus() {
    if (bus) return bus;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    const ctx = new AudioContextClass();
    const input = ctx.createGain();
    const gain = ctx.createGain();
    const mode = ctx.createBiquadFilter();
    const eq = EQ_BANDS_HZ.map(hz => {
      const f = ctx.createBiquadFilter();
      f.type = "peaking";
      f.frequency.value = hz;
      f.Q.value = 1;
      f.gain.value = 0;
      return f;
    });
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -8;
    compressor.knee.value = 18;
    compressor.ratio.value = 1;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    const clipInput = ctx.createGain();
    clipInput.gain.value = 1 / CLIP_RANGE;
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeSoftClipCurve();
    shaper.oversample = "2x";

    input.connect(gain);
    gain.connect(mode);
    let tail = mode;
    for (const f of eq) {
      tail.connect(f);
      tail = f;
    }
    tail.connect(compressor);
    compressor.connect(clipInput);
    clipInput.connect(shaper);
    if (nativeConnect) nativeConnect.call(shaper, ctx.destination);
    else shaper.connect(ctx.destination);

    ctx.addEventListener("statechange", () => {
      if (ctx.state === "running") applyAll();
    });
    bus = { ctx, input, gain, mode, eq, compressor };
    return bus;
  }

  function applyBus(s) {
    if (!bus) return;
    const t = bus.ctx.currentTime;
    bus.gain.gain.setTargetAtTime(s.muted ? 0 : s.volume / 100, t, 0.012);

    if (s.mode === "voice") {
      bus.mode.type = "peaking";
      bus.mode.frequency.setValueAtTime(3000, t);
      bus.mode.Q.setValueAtTime(1.1, t);
      bus.mode.gain.setTargetAtTime(8, t, 0.015);
    } else if (s.mode === "bass") {
      bus.mode.type = "lowshelf";
      bus.mode.frequency.setValueAtTime(90, t);
      bus.mode.Q.setValueAtTime(0.7, t);
      bus.mode.gain.setTargetAtTime(10, t, 0.015);
    } else {
      bus.mode.type = "peaking";
      bus.mode.frequency.setValueAtTime(1000, t);
      bus.mode.Q.setValueAtTime(1, t);
      bus.mode.gain.setTargetAtTime(0, t, 0.015);
    }
    bus.eq.forEach((f, i) => f.gain.setTargetAtTime(s.eqGains[i] || 0, t, 0.015));

    const volumeDb = 20 * Math.log10(Math.max(s.volume, 1) / 100);
    const modeDb = s.mode === "voice" ? 8 : s.mode === "bass" ? 10 : 0;
    const boostDb = s.muted ? 0 : volumeDb + Math.max(0, ...s.eqGains) + modeDb;
    const amount = Math.max(0, Math.min(1, boostDb / 6));
    bus.compressor.ratio.setTargetAtTime(1 + 3 * amount, t, 0.05);
  }

  // Reroute only into a running context; a suspended one would silence it.
  function tryHook(el) {
    if (sources.has(el)) return true;
    if (isDrm(el) || !isReadable(el)) return false;
    const b = ensureBus();
    if (!b) return false;
    if (b.ctx.state !== "running") {
      b.ctx.resume().catch(() => {});
      return false;
    }
    try {
      const source = b.ctx.createMediaElementSource(el);
      source.connect(b.input);
      sources.set(el, source);
      restoreElement(el);
      return true;
    } catch {
      return false;
    }
  }

  // --- element volume (basic mode), on top of the player's own volume ------
  // Players such as Spotify re-apply their own volume to the element, which
  // undid a one-off write. While SoundSphere manages an element, the volume
  // accessor (below) stores what the page asks for and outputs
  // pageVolume x basicLevel; the page still reads back its own value.
  function restoreElement(el) {
    if (pageVolume.has(el)) {
      try { nativeSetVolume(el, pageVolume.get(el)); } catch {}
      pageVolume.delete(el);
    }
    if (mutedByUs.has(el)) {
      try { el.muted = false; } catch {}
      mutedByUs.delete(el);
    }
  }

  function applyBasic(el, s) {
    try {
      if (!pageVolume.has(el)) pageVolume.set(el, nativeGetVolume(el));
      nativeSetVolume(el, clamp(pageVolume.get(el) * basicLevel, 0, 1));
      if (s.muted || s.volume <= 0) {
        if (!el.muted) {
          el.muted = true;
          mutedByUs.add(el);
        }
      } else if (mutedByUs.has(el)) {
        el.muted = false;
        mutedByUs.delete(el);
      }
    } catch {}
  }

  function needsProcessing(s) {
    return !s.muted && (s.volume > 100 || s.mode !== "default" || s.eqGains.some(v => v !== 0));
  }

  function applyAll() {
    if (!settings) return;
    const s = settings;
    basicLevel = Math.min(1, s.volume / 100);
    let hooked = 0;
    for (const el of hiddenMedia()) {
      // Only reroute when the settings need WebAudio; volume cuts and mute
      // stay on the element so neutral use never touches the audio path.
      if (sources.has(el) || (needsProcessing(s) && tryHook(el))) {
        hooked++;
      } else {
        applyBasic(el, s);
      }
    }
    if (hooked) applyBus(s);
    report();
  }

  function report() {
    const media = hiddenMedia();
    const status = {
      media: media.length,
      hooked: media.filter(el => sources.has(el)).length,
      drm: media.some(isDrm),
      readable: media.filter(el => !isDrm(el) && isReadable(el)).length,
      context: bus ? bus.ctx.state : "none"
    };
    try {
      window.postMessage({ source: "SoundSphereMain", type: "SS_MAIN_STATUS", payload: status }, "*");
    } catch {}
  }

  function track(el) {
    if (!(el instanceof HTMLMediaElement)) return;
    if (!tracked.includes(el)) {
      tracked.push(el);
      if (tracked.length > TRACK_LIMIT) tracked.shift();
      if (DEBUG_LOG && isHidden(el)) {
        try {
          console.info("[SoundSphere] hidden player found:", el.tagName.toLowerCase(),
            "| drm:", isDrm(el), "| readable:", isReadable(el));
        } catch {}
      }
    }
    if (settings && isHidden(el)) applyAll();
    else if (isHidden(el)) report();
  }

  // --- volume accessor: only elements SoundSphere manages are affected -----
  if (volumeDescriptor && volumeDescriptor.get && volumeDescriptor.set) {
    try {
      Object.defineProperty(HTMLMediaElement.prototype, "volume", {
        configurable: true,
        enumerable: volumeDescriptor.enumerable,
        get() {
          return pageVolume.has(this) ? pageVolume.get(this) : nativeGetVolume(this);
        },
        set(value) {
          if (!pageVolume.has(this)) {
            nativeSetVolume(this, value);
            return;
          }
          const number = Number(value);
          // Out-of-range values throw exactly as the native setter does.
          if (!(number >= 0 && number <= 1)) {
            nativeSetVolume(this, value);
            return;
          }
          pageVolume.set(this, number);
          nativeSetVolume(this, clamp(number * basicLevel, 0, 1));
        }
      });
    } catch {}
  }

  // --- play() hook: plain same-world wrapper, behaviour unchanged ----------
  const proto = HTMLMediaElement.prototype;
  const nativePlay = proto.play;
  if (typeof nativePlay === "function") {
    const play = function play() {
      try { track(this); } catch {}
      return nativePlay.apply(this, arguments);
    };
    try {
      Object.defineProperty(proto, "play", {
        value: play,
        writable: true,
        configurable: true,
        enumerable: false
      });
    } catch {}
  }

  window.addEventListener("message", event => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== "SoundSphere") return;
    if (data.type === "SS_MAIN_SETTINGS") {
      settings = normalize(data.payload);
      applyAll();
    } else if (data.type === "SS_MAIN_PING") {
      report();
    }
  });
})();
