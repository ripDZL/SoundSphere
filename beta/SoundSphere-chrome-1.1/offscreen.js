// SoundSphere offscreen audio engine (Path B).
//
// Captures a tab's final mixed audio via a tabCapture media-stream id and runs
// it through gain -> mode filter -> 10-band EQ -> compressor. Works on YouTube
// live/SABR/DRM and any audible tab, because it taps post-mix output rather
// than a media element. DSP matches the original content-script graph.

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

async function start(streamId, tabId, volumePercent, mode, gains) {
  log("start received: tab", tabId, "vol", volumePercent, "mode", mode);
  teardown();

  if (typeof mode === "string") currentMode = mode;
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

  // source -> gain -> modeFilter -> EQ... -> compressor -> destination
  source.connect(gainNode);
  gainNode.connect(modeFilter);
  let last = modeFilter;
  eqNodes.forEach(node => {
    last.connect(node);
    last = node;
  });
  last.connect(compressor);
  compressor.connect(ctx.destination);
  log("graph built (gain -> mode -> 10-band EQ -> compressor)");

  capturedTabId = tabId;
  applyMode();
  applyEq();
  setVolume(volumePercent);

  if (ctx.state === "suspended") {
    try { await ctx.resume(); log("context resumed"); } catch (e) { log("resume failed:", e && e.message); }
  }
  log("HOOKED: capturing tab", tabId, "@", volumePercent + "%", "state", ctx.state);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;

  if (msg.type === "start") {
    start(msg.streamId, msg.tabId, msg.volume, msg.mode, msg.gains)
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // async response
  }

  if (msg.type === "volume") {
    setVolume(msg.volume);
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "mode") {
    if (typeof msg.mode === "string") currentMode = msg.mode;
    applyMode();
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "eq") {
    if (Array.isArray(msg.gains)) {
      currentEqGains = msg.gains.slice(0, 10);
      while (currentEqGains.length < 10) currentEqGains.push(0);
    }
    applyEq();
    sendResponse({ ok: true });
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
