// SoundSphere content script
// YouTube: full WebAudio chain (boost + EQ + modes).
// Bandcamp/SoundCloud: safe direct volume/mute control only.

const HOST = location.hostname;
const IS_YOUTUBE =
  HOST.includes("youtube.com") || HOST.includes("music.youtube.com");
const IS_BANDCAMP = HOST.includes("bandcamp.com");
const IS_SOUNDCLOUD = HOST.includes("soundcloud.com");

// Shared state
let currentVolume = 1.0;            // 1.0 = 100%
let currentMode = "default";        // "default" | "voice" | "bass"
let eqGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

const EQ_FREQUENCIES = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

// WebAudio only for YouTube
const AudioContextClass = (IS_YOUTUBE && (window.AudioContext || window.webkitAudioContext)) || null;
let audioCtx = null;

// Map<HTMLMediaElement, { gain, modeFilter, eqNodes }>
const mediaMap = new Map();

function ensureContext() {
  if (!IS_YOUTUBE) return null;
  if (audioCtx) return audioCtx;
  if (!AudioContextClass) return null;
  audioCtx = new AudioContextClass();
  return audioCtx;
}

function applyModeFilter(node, ctx) {
  if (!node || !ctx) return;

  node.gain.setValueAtTime(0, ctx.currentTime);

  if (currentMode === "default") {
    node.type = "peaking";
    node.frequency.setValueAtTime(1000, ctx.currentTime);
    node.Q.setValueAtTime(1, ctx.currentTime);
    node.gain.setValueAtTime(0, ctx.currentTime);
    return;
  }

  if (currentMode === "voice") {
    node.type = "peaking";
    node.frequency.setValueAtTime(3000, ctx.currentTime);
    node.Q.setValueAtTime(1, ctx.currentTime);
    node.gain.setValueAtTime(10, ctx.currentTime);
    return;
  }

  if (currentMode === "bass") {
    node.type = "lowshelf";
    node.frequency.setValueAtTime(90, ctx.currentTime);
    node.gain.setValueAtTime(12, ctx.currentTime);
  }
}

function applyEqFilters(nodes, ctx) {
  if (!nodes || !ctx) return;

  const gains = eqGains.length === 10 ? eqGains : new Array(10).fill(0);

  nodes.forEach((node, index) => {
    const freq = EQ_FREQUENCIES[index] || 1000;
    const gain = typeof gains[index] === "number" ? gains[index] : 0;

    node.type = "peaking";
    node.frequency.setValueAtTime(freq, ctx.currentTime);
    node.Q.setValueAtTime(1, ctx.currentTime);
    node.gain.setValueAtTime(gain, ctx.currentTime);
  });
}

function createCompressor(ctx) {
  const node = ctx.createDynamicsCompressor();
  try {
    node.threshold.setValueAtTime(-6, ctx.currentTime);
    node.knee.setValueAtTime(12, ctx.currentTime);
    node.ratio.setValueAtTime(4, ctx.currentTime);
    node.attack.setValueAtTime(0.003, ctx.currentTime);
    node.release.setValueAtTime(0.25, ctx.currentTime);
  } catch (e) {
    // Some engines may not support every parameter; that's fine.
  }
  return node;
}

function makeSourceForElement(el, ctx) {
  // Only used on YouTube
  try {
    const capture = el.captureStream
      ? el.captureStream()
      : (el.mozCaptureStream ? el.mozCaptureStream() : null);
    if (capture) {
      return ctx.createMediaStreamSource(capture);
    }
  } catch (e) {
    // captureStream not available or failed
  }

  try {
    return ctx.createMediaElementSource(el);
  } catch (e) {
    return null;
  }
}

function hookElementYouTube(el) {
  if (!IS_YOUTUBE) return;
  if (!el) return;
  if (mediaMap.has(el)) return;
  if (el.dataset.soundsphereHooked === "1") return;

  const ctx = ensureContext();
  if (!ctx) return;

  const source = makeSourceForElement(el, ctx);
  if (!source) return;

  try {
    const gain = ctx.createGain();
    const modeFilter = ctx.createBiquadFilter();
    const eqNodes = EQ_FREQUENCIES.map(() => ctx.createBiquadFilter());
    const compressor = createCompressor(ctx);

    gain.gain.setValueAtTime(currentVolume, ctx.currentTime);
    applyModeFilter(modeFilter, ctx);
    applyEqFilters(eqNodes, ctx);

    // source -> gain -> modeFilter -> EQs -> compressor -> destination
    source.connect(gain);
    gain.connect(modeFilter);

    let last = modeFilter;
    eqNodes.forEach(node => {
      last.connect(node);
      last = node;
    });

    last.connect(compressor);
    compressor.connect(ctx.destination);

    el.dataset.soundsphereHooked = "1";
    mediaMap.set(el, { gain, modeFilter, eqNodes });

    const cleanup = () => {
      mediaMap.delete(el);
      delete el.dataset.soundsphereHooked;
      el.removeEventListener("ended", cleanup);
      el.removeEventListener("emptied", cleanup);
    };

    el.addEventListener("ended", cleanup);
    el.addEventListener("emptied", cleanup);

    el.addEventListener("play", () => {
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
    });
  } catch (err) {
    console.error("SoundSphere (Chrome YouTube) hook error:", err);
  }
}

function scanAndHook(root) {
  const scope = root || document;
  const mediaEls = scope.querySelectorAll("audio, video");

  if (IS_YOUTUBE) {
    mediaEls.forEach(hookElementYouTube);
  }
  // For Bandcamp/SoundCloud we do NOT hook WebAudio here;
  // we only use direct volume control in message handler.
}

// Initial scan
scanAndHook(document);

// Periodic scan for YouTube SPA / dynamic players
setInterval(() => scanAndHook(document), 1500);

// Watch DOM for dynamically added media elements (YouTube focused)
new MutationObserver(mutations => {
  for (const mutation of mutations) {
    mutation.addedNodes.forEach(node => {
      if (!(node instanceof Element)) return;

      if (node.matches("audio,video")) {
        scanAndHook(node);
      } else if (node.querySelectorAll) {
        scanAndHook(node);
      }
    });
  }
}).observe(document.documentElement || document.body, {
  childList: true,
  subtree: true
});

// Messages from popup (Chrome)

// Messages from popup/background land here. We keep the handler small
// and forward into helper functions so it's easier to reason about.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  const ctx = ensureContext();

  if (message.action === "setVolume") {
    const raw = typeof message.volume === "number" ? message.volume : 100;
    const clamped = Math.max(0, Math.min(raw, 800));
    currentVolume = clamped / 100;

    // YouTube: apply WebAudio gain for 0–800%
    if (IS_YOUTUBE && ctx) {
      mediaMap.forEach(({ gain }) => {
        try {
          gain.gain.setValueAtTime(currentVolume, ctx.currentTime);
        } catch (e) {}
      });
    }

    // Bandcamp/SoundCloud + generic fallback: direct element volume/mute 0–100%
    const directPercent = Math.max(0, Math.min(raw, 100));
    const directVolume = directPercent / 100;
    const shouldMute = directPercent === 0;

    const elements = document.querySelectorAll("audio, video");
    elements.forEach(el => {
      if (IS_BANDCAMP || IS_SOUNDCLOUD || !IS_YOUTUBE) {
        // Always direct-control on Bandcamp/SoundCloud
        // On non-YouTube hosts, this is our baseline behavior.
        if (shouldMute) {
          el.muted = true;
        } else {
          el.muted = false;
          el.volume = directVolume;
        }
      }
    });

    return;
  }

  if (message.action === "setMode") {
    currentMode = message.mode || "default";
    if (IS_YOUTUBE && ctx) {
      mediaMap.forEach(({ modeFilter }) => {
        applyModeFilter(modeFilter, ctx);
      });
    }
    return;
  }

  if (message.action === "setEqGains") {
    const gains = Array.isArray(message.gains) ? message.gains.slice(0, 10) : [];
    while (gains.length < 10) gains.push(0);
    eqGains = gains;

    if (IS_YOUTUBE && ctx) {
      mediaMap.forEach(({ eqNodes }) => {
        applyEqFilters(eqNodes, ctx);
      });
    }
    return;
  }

  if (message.action === "getState") {
    const payload = {
      volume: currentVolume * 100,
      mode: currentMode,
      eq: eqGains.slice()
    };
    sendResponse(payload);
  }
});

console.log(
  "SoundSphere content script loaded (Chrome) – YouTube: WebAudio, others: direct volume"
);
