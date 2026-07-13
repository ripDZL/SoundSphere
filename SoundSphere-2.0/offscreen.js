"use strict";

/*
  Hidden Chrome MV3 audio engine.

  Each captured tab gets its own WebAudio graph:
    tab stream -> gain -> quick mode -> 10-band EQ -> compressor -> soft clip -> output

  Captured tab audio is muted by Chrome unless this document plays the stream
  back to the user, so every active graph ends at AudioContext.destination.
*/

const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const engines = new Map();

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

function makeSoftClipCurve() {
  const samples = 4096;
  const curve = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = x / (1 + 0.65 * Math.abs(x));
  }
  return curve;
}

function createCompressor(ctx) {
  const node = ctx.createDynamicsCompressor();
  const t = ctx.currentTime;
  node.threshold.setValueAtTime(-8, t);
  node.knee.setValueAtTime(18, t);
  node.ratio.setValueAtTime(4, t);
  node.attack.setValueAtTime(0.003, t);
  node.release.setValueAtTime(0.25, t);
  return node;
}

function applyMode(engine) {
  const { ctx, modeFilter, settings } = engine;
  const t = ctx.currentTime;

  if (settings.mode === "voice") {
    modeFilter.type = "peaking";
    modeFilter.frequency.setValueAtTime(3000, t);
    modeFilter.Q.setValueAtTime(1.1, t);
    modeFilter.gain.setTargetAtTime(8, t, 0.015);
    return;
  }

  if (settings.mode === "bass") {
    modeFilter.type = "lowshelf";
    modeFilter.frequency.setValueAtTime(90, t);
    modeFilter.Q.setValueAtTime(0.7, t);
    modeFilter.gain.setTargetAtTime(10, t, 0.015);
    return;
  }

  modeFilter.type = "peaking";
  modeFilter.frequency.setValueAtTime(1000, t);
  modeFilter.Q.setValueAtTime(1, t);
  modeFilter.gain.setTargetAtTime(0, t, 0.015);
}

function applySettings(engine, nextSettings) {
  engine.settings = normalizeSettings(nextSettings);

  const { ctx, gainNode, eqNodes, settings } = engine;
  const t = ctx.currentTime;
  const gain = settings.muted ? 0 : settings.volume / 100;

  gainNode.gain.setTargetAtTime(gain, t, 0.012);
  eqNodes.forEach((node, index) => {
    node.gain.setTargetAtTime(settings.eqGains[index] || 0, t, 0.015);
  });
  applyMode(engine);
}

function teardown(tabId) {
  const engine = engines.get(tabId);
  if (!engine) return;

  try { engine.source.disconnect(); } catch {}
  try { engine.gainNode.disconnect(); } catch {}
  try { engine.modeFilter.disconnect(); } catch {}
  try { engine.eqNodes.forEach(node => node.disconnect()); } catch {}
  try { engine.compressor.disconnect(); } catch {}
  try { engine.shaper.disconnect(); } catch {}
  try { engine.analyser.disconnect(); } catch {}
  try { engine.stream.getTracks().forEach(track => track.stop()); } catch {}
  try { engine.ctx.close(); } catch {}

  engines.delete(tabId);
}

async function openTabStream(streamId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });
}

async function startEngine(tabId, streamId, settings) {
  teardown(tabId);

  const stream = await openTabStream(streamId);
  const ctx = new AudioContext({ latencyHint: "interactive" });
  const source = ctx.createMediaStreamSource(stream);
  const gainNode = ctx.createGain();
  const modeFilter = ctx.createBiquadFilter();
  const eqNodes = EQ_FREQUENCIES.map(frequency => {
    const node = ctx.createBiquadFilter();
    node.type = "peaking";
    node.frequency.value = frequency;
    node.Q.value = 1;
    node.gain.value = 0;
    return node;
  });
  const compressor = createCompressor(ctx);
  const shaper = ctx.createWaveShaper();
  const analyser = ctx.createAnalyser();

  shaper.curve = makeSoftClipCurve();
  shaper.oversample = "2x";
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.78;

  source.connect(gainNode);
  gainNode.connect(modeFilter);
  let tail = modeFilter;
  for (const node of eqNodes) {
    tail.connect(node);
    tail = node;
  }
  tail.connect(compressor);
  compressor.connect(shaper);
  shaper.connect(analyser);
  analyser.connect(ctx.destination);

  const engine = {
    tabId,
    stream,
    ctx,
    source,
    gainNode,
    modeFilter,
    eqNodes,
    compressor,
    shaper,
    analyser,
    settings: normalizeSettings(settings),
    startedAt: Date.now()
  };
  engines.set(tabId, engine);

  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => teardown(tabId), { once: true });
  }

  applySettings(engine, settings);
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});

  return { ok: true, active: true, state: ctx.state };
}

function status(tabId) {
  const engine = engines.get(tabId);
  if (!engine) return { ok: true, active: false };
  return {
    ok: true,
    active: true,
    state: engine.ctx.state,
    startedAt: engine.startedAt,
    settings: engine.settings
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== "offscreen") return undefined;

  if (message.type === "SS_OFFSCREEN_START") {
    startEngine(Number(message.tabId), message.streamId, message.settings)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error.message || String(error) }));
    return true;
  }

  if (message.type === "SS_OFFSCREEN_APPLY") {
    const tabId = Number(message.tabId);
    const engine = engines.get(tabId);
    if (!engine) {
      sendResponse({ ok: false, active: false, error: "No active audio graph for this tab" });
      return undefined;
    }
    applySettings(engine, message.settings);
    sendResponse({ ok: true, active: true, state: engine.ctx.state });
    return undefined;
  }

  if (message.type === "SS_OFFSCREEN_STATUS") {
    sendResponse(status(Number(message.tabId)));
    return undefined;
  }

  if (message.type === "SS_OFFSCREEN_STOP") {
    teardown(Number(message.tabId));
    sendResponse({ ok: true });
    return undefined;
  }

  return undefined;
});
