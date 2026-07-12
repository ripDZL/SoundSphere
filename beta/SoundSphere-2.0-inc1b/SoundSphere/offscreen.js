// SoundSphere offscreen audio engine.
//
// Captures a tab's mixed audio from a tabCapture stream and runs it through
// gain -> mode filter -> 10-band EQ -> compressor. Because it taps the tab's
// post-mix output rather than a media element, it works on live streams,
// DRM-protected playback, and any other audible tab.

const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

let ctx = null;
let source = null;
let gainNode = null;
let modeFilter = null;
let eqNodes = [];
let compressor = null;
let stream = null;
let capturedTabId = null;

let currentMode = "default";              // "default" | "voice" | "bass"
let currentEqGains = new Array(10).fill(0); // dB per band

// Enhancement stages (all bypassed at neutral settings)
let widenerNodes = null;   // stereo width via mid/side
let clarityShelf = null;   // presence high-shelf
let nightLowShelf = null;  // night mode: tame lows
let nightHighShelf = null; // night mode: tame harsh highs
let analyser = null;       // spectrum/waveform tap (read by UI)

let fx = {
  width: 1,        // 0 = mono, 1 = normal, up to 2 = wide
  clarity: 0,      // 0..6 dB presence shelf @ 3.5 kHz
  night: false     // reduces harsh highs + boosts intelligibility comp
};

function log(...args) {
  console.log("[SoundSphere offscreen]", ...args);
}

function teardown() {
  try { if (source) source.disconnect(); } catch (e) {}
  try { if (gainNode) gainNode.disconnect(); } catch (e) {}
  try { if (modeFilter) modeFilter.disconnect(); } catch (e) {}
  try { eqNodes.forEach(n => n.disconnect()); } catch (e) {}
  try { if (compressor) compressor.disconnect(); } catch (e) {}
  try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch (e) {}
  try { if (ctx) ctx.close(); } catch (e) {}
  try { if (widenerNodes) Object.values(widenerNodes).forEach(n => n.disconnect && n.disconnect()); } catch (e) {}
  try { if (clarityShelf) clarityShelf.disconnect(); } catch (e) {}
  try { if (nightLowShelf) nightLowShelf.disconnect(); } catch (e) {}
  try { if (nightHighShelf) nightHighShelf.disconnect(); } catch (e) {}
  try { if (analyser) analyser.disconnect(); } catch (e) {}
  widenerNodes = clarityShelf = nightLowShelf = nightHighShelf = analyser = null;
  source = gainNode = modeFilter = compressor = stream = ctx = null;
  eqNodes = [];
  capturedTabId = null;
}

function applyMode() {
  if (!modeFilter || !ctx) return;
  const t = ctx.currentTime;
  modeFilter.gain.setValueAtTime(0, t);

  if (currentMode === "voice") {
    modeFilter.type = "peaking";
    modeFilter.frequency.setValueAtTime(3000, t);
    modeFilter.Q.setValueAtTime(1, t);
    modeFilter.gain.setValueAtTime(10, t);
  } else if (currentMode === "bass") {
    modeFilter.type = "lowshelf";
    modeFilter.frequency.setValueAtTime(90, t);
    modeFilter.gain.setValueAtTime(12, t);
  } else {
    modeFilter.type = "peaking";
    modeFilter.frequency.setValueAtTime(1000, t);
    modeFilter.Q.setValueAtTime(1, t);
    modeFilter.gain.setValueAtTime(0, t);
  }
}

function applyEq() {
  if (!ctx || !eqNodes.length) return;
  const t = ctx.currentTime;
  const gains = currentEqGains.length === 10 ? currentEqGains : new Array(10).fill(0);
  eqNodes.forEach((node, i) => {
    node.type = "peaking";
    node.frequency.setValueAtTime(EQ_FREQUENCIES[i] || 1000, t);
    node.Q.setValueAtTime(1, t);
    node.gain.setValueAtTime(typeof gains[i] === "number" ? gains[i] : 0, t);
  });
}

// Mid/side stereo widener. width 1 = unity; <1 narrows, >1 widens.
// Built from splitter/merger + gains implementing:
//   L' = mid + width*side,  R' = mid - width*side
function buildWidener() {
  const split = ctx.createChannelSplitter(2);
  const merge = ctx.createChannelMerger(2);
  const midL = ctx.createGain(), midR = ctx.createGain();
  const sideL = ctx.createGain(), sideR = ctx.createGain();
  const invR = ctx.createGain();
  const outL = ctx.createGain(), outR = ctx.createGain();

  // mid = 0.5(L+R); side = 0.5(L-R)
  midL.gain.value = 0.5; midR.gain.value = 0.5;
  sideL.gain.value = 0.5; invR.gain.value = -0.5;

  split.connect(midL, 0); split.connect(midR, 1);
  split.connect(sideL, 0); split.connect(invR, 1);

  const mid = ctx.createGain();
  midL.connect(mid); midR.connect(mid);
  const side = ctx.createGain();
  sideL.connect(side); invR.connect(side);

  // L' = mid + w*side ; R' = mid - w*side
  const sidePos = ctx.createGain();
  const sideNeg = ctx.createGain();
  side.connect(sidePos); side.connect(sideNeg);
  sideNeg.gain.value = -1;

  mid.connect(outL); sidePos.connect(outL);
  mid.connect(outR); sideNeg.connect(outR);
  outL.connect(merge, 0, 0);
  outR.connect(merge, 0, 1);

  return { input: split, output: merge, sidePos, sideNeg };
}

function applyFx() {
  if (!ctx) return;
  const t = ctx.currentTime;
  if (widenerNodes) {
    const w = Math.max(0, Math.min(2, Number(fx.width) || 1));
    widenerNodes.sidePos.gain.setTargetAtTime(w, t, 0.02);
    widenerNodes.sideNeg.gain.setTargetAtTime(-w, t, 0.02);
  }
  if (clarityShelf) {
    const c = Math.max(0, Math.min(6, Number(fx.clarity) || 0));
    clarityShelf.gain.setTargetAtTime(c, t, 0.02);
  }
  if (nightLowShelf && nightHighShelf) {
    nightLowShelf.gain.setTargetAtTime(fx.night ? 3 : 0, t, 0.02);
    nightHighShelf.gain.setTargetAtTime(fx.night ? -6 : 0, t, 0.02);
  }
}

function createCompressor() {
  const node = ctx.createDynamicsCompressor();
  const t = ctx.currentTime;
  try {
    node.threshold.setValueAtTime(-6, t);
    node.knee.setValueAtTime(12, t);
    node.ratio.setValueAtTime(4, t);
    node.attack.setValueAtTime(0.003, t);
    node.release.setValueAtTime(0.25, t);
  } catch (e) {}
  return node;
}

function setVolume(percent) {
  if (!gainNode || !ctx) return;
  const v = Math.max(0, Number(percent) || 0) / 100; // 100% -> 1.0, 800% -> 8.0
  gainNode.gain.setTargetAtTime(v, ctx.currentTime, 0.01);
}

async function start(streamId, tabId, volumePercent, mode, gains, startFx) {
  log("start received: tab", tabId, "vol", volumePercent, "mode", mode);
  teardown();

  if (typeof mode === "string") currentMode = mode;
  if (startFx && typeof startFx === "object") {
    fx = Object.assign({ width: 1, clarity: 0, night: false }, startFx);
  }
  if (Array.isArray(gains)) {
    currentEqGains = gains.slice(0, 10);
    while (currentEqGains.length < 10) currentEqGains.push(0);
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
    log("getUserMedia ok: capture stream acquired");
    stream.getAudioTracks().forEach(t => {
      t.onended = () => { log("capture track ended; tearing down"); teardown(); };
    });
  } catch (e) {
    log("getUserMedia FAILED:", e && e.message);
    teardown();
    throw e;
  }

  ctx = new AudioContext();
  source = ctx.createMediaStreamSource(stream);
  gainNode = ctx.createGain();
  modeFilter = ctx.createBiquadFilter();
  eqNodes = EQ_FREQUENCIES.map(() => ctx.createBiquadFilter());
  compressor = createCompressor();

  clarityShelf = ctx.createBiquadFilter();
  clarityShelf.type = "highshelf";
  clarityShelf.frequency.value = 3500;
  clarityShelf.gain.value = 0;

  nightLowShelf = ctx.createBiquadFilter();
  nightLowShelf.type = "lowshelf";
  nightLowShelf.frequency.value = 120;
  nightLowShelf.gain.value = 0;

  nightHighShelf = ctx.createBiquadFilter();
  nightHighShelf.type = "highshelf";
  nightHighShelf.frequency.value = 6000;
  nightHighShelf.gain.value = 0;

  widenerNodes = buildWidener();

  analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.8;

  // source -> gain -> mode -> EQ x10 -> clarity -> night(lo,hi)
  //        -> widener -> compressor -> analyser -> destination
  source.connect(gainNode);
  gainNode.connect(modeFilter);
  let last = modeFilter;
  eqNodes.forEach(node => {
    last.connect(node);
    last = node;
  });
  last.connect(clarityShelf);
  clarityShelf.connect(nightLowShelf);
  nightLowShelf.connect(nightHighShelf);
  nightHighShelf.connect(widenerNodes.input);
  widenerNodes.output.connect(compressor);
  compressor.connect(analyser);
  analyser.connect(ctx.destination);
  log("graph built (gain -> mode -> 10-band EQ -> compressor)");

  capturedTabId = tabId;
  applyMode();
  applyEq();
  applyFx();
  setVolume(volumePercent);

  if (ctx.state === "suspended") {
    try { await ctx.resume(); log("context resumed"); } catch (e) { log("resume failed:", e && e.message); }
  }
  log("HOOKED: capturing tab", tabId, "@", volumePercent + "%", "state", ctx.state);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;

  if (msg.type === "start") {
    start(msg.streamId, msg.tabId, msg.volume, msg.mode, msg.gains, msg.fx)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  }

  if (msg.type === "volume") {
    if (!gainNode || !ctx) {
      sendResponse({ ok: false, needsStart: true });
      return;
    }
    setVolume(msg.volume);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "mode") {
    if (typeof msg.mode === "string") currentMode = msg.mode;
    if (!ctx || !modeFilter) { sendResponse({ ok: false, needsStart: true }); return; }
    applyMode();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "eq") {
    if (Array.isArray(msg.gains)) {
      currentEqGains = msg.gains.slice(0, 10);
      while (currentEqGains.length < 10) currentEqGains.push(0);
    }
    if (!ctx || !eqNodes.length) { sendResponse({ ok: false, needsStart: true }); return; }
    applyEq();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "fx") {
    if (msg.fx && typeof msg.fx === "object") {
      if ("width" in msg.fx) fx.width = msg.fx.width;
      if ("clarity" in msg.fx) fx.clarity = msg.fx.clarity;
      if ("night" in msg.fx) fx.night = !!msg.fx.night;
    }
    if (!ctx) { sendResponse({ ok: false, needsStart: true }); return; }
    applyFx();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "spectrum") {
    if (!analyser) { sendResponse({ ok: false, needsStart: true }); return; }
    const bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(bins);
    const wave = new Uint8Array(512);
    analyser.getByteTimeDomainData(wave);
    // Uint8Array doesn't survive messaging; send plain arrays (downsampled).
    const step = Math.max(1, Math.floor(bins.length / 128));
    const spec = [];
    for (let i = 0; i < bins.length; i += step) spec.push(bins[i]);
    sendResponse({ ok: true, spectrum: spec, waveform: Array.from(wave) });
    return;
  }

  if (msg.type === "stop") {
    teardown();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "status") {
    sendResponse({ ok: true, capturedTabId, mode: currentMode, state: ctx ? ctx.state : "none" });
    return;
  }
});

log("offscreen loaded, message listener registered");
