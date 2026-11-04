"use strict";

/*
  Hidden Chrome MV3 audio engine.

  Each captured tab gets its own WebAudio graph:
    tab stream -> gain -> quick mode -> 10-band EQ -> compressor -> soft clip -> output

  Captured tab audio is muted by Chrome unless this document plays the stream
  back to the user, so every active graph ends at AudioContext.destination.

  At neutral settings (100%, flat EQ, default mode) the chain is transparent:
  the compressor ratio sits at 1 and the soft clip is identity below its knee.
*/

const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const CLIP_RANGE = 4;    // soft clip handles inputs up to +12 dBFS
const CLIP_KNEE = 0.85;  // identity below this amplitude
const engines = new Map();
const startTokens = new Map(); // tabId -> token of the newest start request

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

// WaveShaper only maps inputs in [-1, 1], so the shaper is fed through a
// 1/CLIP_RANGE pre-gain and the curve is evaluated over the real range.
// Identity below CLIP_KNEE, then a tanh knee that approaches 1.0 (never clips
// hard). The previous x/(1+0.65|x|) curve attenuated and distorted every
// sample, even at 100%.
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

// Rough peak gain (dB) the settings add. The compressor only engages while
// boosting; its ratio fades in over the first 6 dB so there is no jump in
// loudness (DynamicsCompressor applies automatic makeup gain when ratio > 1).
function boostDb(settings) {
  if (settings.muted) return 0;
  const volumeDb = 20 * Math.log10(Math.max(settings.volume, 1) / 100);
  const eqDb = Math.max(0, ...settings.eqGains);
  const modeDb = settings.mode === "voice" ? 8 : settings.mode === "bass" ? 10 : 0;
  return volumeDb + eqDb + modeDb;
}

function applyDynamics(compressor, settings, t) {
  const amount = Math.max(0, Math.min(1, boostDb(settings) / 6));
  compressor.ratio.setTargetAtTime(1 + 3 * amount, t, 0.05);
}

function createCompressor(ctx) {
  const node = ctx.createDynamicsCompressor();
  const t = ctx.currentTime;
  node.threshold.setValueAtTime(-8, t);
  node.knee.setValueAtTime(18, t);
  node.ratio.setValueAtTime(1, t);
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
  applyDynamics(engine.compressor, settings, t);
}

function teardown(tabId) {
  const engine = engines.get(tabId);
  if (!engine) return;

  try { engine.source.disconnect(); } catch {}
  try { engine.gainNode.disconnect(); } catch {}
  try { engine.modeFilter.disconnect(); } catch {}
  try { engine.eqNodes.forEach(node => node.disconnect()); } catch {}
  try { engine.compressor.disconnect(); } catch {}
  try { engine.clipInput.disconnect(); } catch {}
  try { engine.shaper.disconnect(); } catch {}
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
  const token = {};
  startTokens.set(tabId, token);
  teardown(tabId);

  let stream;
  try {
    stream = await openTabStream(streamId);
  } catch (error) {
    if (startTokens.get(tabId) === token) startTokens.delete(tabId);
    throw error;
  }

  // A newer start (or a stop) arrived while getUserMedia was pending: drop
  // this stream instead of building a second graph that would double audio.
  if (startTokens.get(tabId) !== token) {
    try { stream.getTracks().forEach(track => track.stop()); } catch {}
    return { ok: true, active: engines.has(tabId), superseded: true };
  }
  startTokens.delete(tabId);
  teardown(tabId);

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
  const clipInput = ctx.createGain();
  const shaper = ctx.createWaveShaper();

  clipInput.gain.value = 1 / CLIP_RANGE;
  shaper.curve = makeSoftClipCurve();
  shaper.oversample = "2x";

  source.connect(gainNode);
  gainNode.connect(modeFilter);
  let tail = modeFilter;
  for (const node of eqNodes) {
    tail.connect(node);
    tail = node;
  }
  tail.connect(compressor);
  compressor.connect(clipInput);
  clipInput.connect(shaper);
  shaper.connect(ctx.destination);

  const engine = {
    tabId,
    stream,
    ctx,
    source,
    gainNode,
    modeFilter,
    eqNodes,
    compressor,
    clipInput,
    shaper,
    settings: normalizeSettings(settings),
    startedAt: Date.now()
  };
  engines.set(tabId, engine);

  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => {
      if (engines.get(tabId) === engine) teardown(tabId);
    }, { once: true });
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
    const tabId = Number(message.tabId);
    startTokens.delete(tabId);
    teardown(tabId);
    sendResponse({ ok: true, count: engines.size });
    return undefined;
  }

  if (message.type === "SS_OFFSCREEN_COUNT") {
    sendResponse({ ok: true, count: engines.size + startTokens.size });
    return undefined;
  }

  return undefined;
});
