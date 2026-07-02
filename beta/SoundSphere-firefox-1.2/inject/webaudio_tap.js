/*
  SoundSphere — WebAudio tap (page context)

  Some sites build audio with WebAudio graphs instead of direct <audio>/<video>
  elements. In those cases we can’t always hook a MediaElement source.

  This patch watches for AudioNode connections to an AudioContext destination
  and reroutes them through a SoundSphere “master bus” (gain / EQ / mode).

  Best-effort and fail-safe: if anything looks risky, we fall back to the
  site’s original routing.
*/

(() => {
  // Keep a legacy flag around (older builds had a typo) so we never double-patch.
  const FLAG = "__SOUNDSPHERE_WEBAUDIO_TAP__";
  const LEGACY_FLAG = "__SOUNDSHPERE_WEBAUDIO_TAP__";
  if (window[FLAG] || window[LEGACY_FLAG]) return;
  window[FLAG] = true;
  window[LEGACY_FLAG] = true;

  const EQ_BANDS_HZ = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

  const BYPASS = Symbol("ss_bypass_connect");

  const state = {
    volumePercent: 100,
    muted: false,
    mode: "default",
    eq: new Array(10).fill(0)
  };

  // Track contexts we have seen so we can apply updated settings.
  const seenContexts = new Set();
  const chains = new WeakMap();

  function clamp(n, min, max) {
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

  function buildChain(ctx) {
    // Master chain nodes
    const input = ctx.createGain();
    const gain = ctx.createGain();

    // Mode segment
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

    // Connect output to destination, but mark output as bypass so our connect
    // patch does not redirect this final connection.
    output[BYPASS] = true;
    try {
      // Use original connect if available (patched later). We'll attach later
      // via connectToDestination() so we can use the *unpatched* original.
    } catch {}

    const chain = {
      ctx,
      input,
      gain,
      mode: { in: modeIn, out: modeOut },
      eq,
      compressor,
      shaper,
      output,
      connected: false
    };

    return chain;
  }

  function applyMode(chain, mode) {
    if (!chain || !chain.ctx || !chain.gain) return;

    const ctx = chain.ctx;

    // Disconnect current mode segment (safe-guarded).
    try { chain.mode.in.disconnect(); } catch {}
    try { chain.mode.out.disconnect(); } catch {}

    const modeIn = ctx.createGain();
    const modeOut = ctx.createGain();

    // Default passthrough
    if (mode === "voice") {
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
    } else if (mode === "bass") {
      const ls = ctx.createBiquadFilter();
      ls.type = "lowshelf";
      ls.frequency.value = 90;
      ls.gain.value = 10;
      modeIn.connect(ls);
      ls.connect(modeOut);
    } else {
      modeIn.connect(modeOut);
    }

    // Rewire into chain: gain -> modeIn
    try { chain.gain.disconnect(); } catch {}
    chain.gain.connect(modeIn);

    // modeOut -> eq[0]
    const start = chain.eq[0] || chain.compressor;
    modeOut.connect(start);

    chain.mode = { in: modeIn, out: modeOut };
  }

  function applySettings(chain) {
    if (!chain || !chain.ctx) return;

    // Gain
    const g = state.muted ? 0 : clamp(state.volumePercent, 0, 800) / 100;
    try {
      chain.gain.gain.setValueAtTime(g, chain.ctx.currentTime);
    } catch {
      chain.gain.gain.value = g;
    }

    // EQ
    for (let i = 0; i < chain.eq.length; i++) {
      const db = clamp(state.eq[i] ?? 0, -24, 24);
      try {
        chain.eq[i].gain.setValueAtTime(db, chain.ctx.currentTime);
      } catch {
        chain.eq[i].gain.value = db;
      }
    }

    // Mode
    applyMode(chain, state.mode);
  }

  function getChainFor(ctx) {
    if (!ctx) return null;

    let chain = chains.get(ctx);
    if (!chain) {
      chain = buildChain(ctx);
      chains.set(ctx, chain);
      seenContexts.add(ctx);

      // Initial apply
      applySettings(chain);
    }
    return chain;
  }

  // Patch connect
  const NativeAudioNode = window.AudioNode;
  const nativeConnect = NativeAudioNode && NativeAudioNode.prototype && NativeAudioNode.prototype.connect;

  function isAudioParam(x) {
    // AudioParam doesn't reliably expose a public class name.
    return x && typeof x === "object" && typeof x.setValueAtTime === "function" && typeof x.value !== "undefined";
  }

  if (nativeConnect) {
    NativeAudioNode.prototype.connect = function (...args) {
      try {
        const dest = args[0];

        // Do not interfere with AudioParam connections.
        if (isAudioParam(dest)) {
          return nativeConnect.apply(this, args);
        }

        // Only reroute direct destination connections.
        const ctx = this && this.context;
        if (ctx && dest === ctx.destination && !this[BYPASS]) {
          const chain = getChainFor(ctx);
          if (chain && chain.input) {
            // Ensure master output is connected to destination exactly once.
            if (!chain.connected) {
              // Connect output -> destination without re-entry.
              try {
                nativeConnect.call(chain.output, ctx.destination);
              } catch {}
              chain.connected = true;
            }

            // Route source into master input.
            nativeConnect.call(this, chain.input);
            return dest;
          }
        }
      } catch {
        // Fall through to native behavior.
      }

      return nativeConnect.apply(this, args);
    };
  }

  // Messages from extension content script
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || typeof data !== "object") return;
    if (data.source !== "SoundSphere") return;

    if (data.type === "SS_SETTINGS" && data.payload) {
      const p = data.payload;
      const vp = (typeof p.volumePercent === "number" ? p.volumePercent : p.volume);
      state.volumePercent = clamp(vp ?? state.volumePercent, 0, 800);
      state.muted = !!p.muted;
      state.mode = p.mode === "voice" || p.mode === "bass" ? p.mode : "default";
      if (Array.isArray(p.eq)) {
        const arr = p.eq.slice(0, 10);
        while (arr.length < 10) arr.push(0);
        state.eq = arr.map(v => clamp(v, -24, 24));
      }

      // Apply to all known contexts.
      for (const ctx of Array.from(seenContexts)) {
        const chain = chains.get(ctx);
        if (chain) applySettings(chain);
      }

      window.postMessage({
        source: "SoundSphereTap",
        type: "SS_TAP_APPLIED",
        payload: { contexts: seenContexts.size }
      }, "*");
    }

    if (data.type === "SS_PING") {
      window.postMessage({ source: "SoundSphereTap", type: "SS_TAP_PONG" }, "*");
    }
  });

  // Announce readiness
  window.postMessage({
    source: "SoundSphereTap",
    type: "SS_TAP_READY",
    payload: { ok: !!nativeConnect }
  }, "*");
})();
