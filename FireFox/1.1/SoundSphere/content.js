const host = location.hostname;
const useInjectedWebAudio =
  host === "soundcloud.com" ||
  host.endsWith(".soundcloud.com") ||
  host === "bandcamp.com" ||
  host.endsWith(".bandcamp.com");

let audioContext = null;
let currentVolumePercent = 100;
let currentGain = 1;
let currentMode = "default";
let overdriveEnabled = false;

const audioElements = new Map();

function mapVolumeToGain(percent) {
  const p = Math.max(0, Math.min(800, Number(percent) || 0));
  if (p === 0) return 0;
  if (p <= 600) return (p / 600) * 6;
  const extra = (p - 600) / 200;
  return 6 + extra * 2;
}

function ensureContext() {
  if (audioContext) return audioContext;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  audioContext = new Ctor();
  return audioContext;
}

function setFilterForMode(filter) {
  if (!audioContext || !filter) return;
  const t = audioContext.currentTime || 0;

  if (currentMode === "voice") {
    filter.type = "highshelf";
    filter.frequency.setValueAtTime(3000, t);
    filter.Q.setValueAtTime(0.9, t);
    filter.gain.setValueAtTime(10, t);
    return;
  }

  if (currentMode === "bass") {
    filter.type = "lowshelf";
    filter.frequency.setValueAtTime(160, t);
    filter.Q.setValueAtTime(0.8, t);
    filter.gain.setValueAtTime(12, t);
    return;
  }

  filter.type = "peaking";
  filter.frequency.setValueAtTime(1000, t);
  filter.Q.setValueAtTime(1, t);
  filter.gain.setValueAtTime(0, t);
}

function applyOverdriveToCompressor(compressor) {
  if (!audioContext || !compressor) return;
  const t = audioContext.currentTime || 0;

  if (overdriveEnabled) {
    compressor.threshold.setValueAtTime(-18, t);
    compressor.knee.setValueAtTime(15, t);
    compressor.ratio.setValueAtTime(8, t);
    compressor.attack.setValueAtTime(0.003, t);
    compressor.release.setValueAtTime(0.25, t);
  } else {
    compressor.threshold.setValueAtTime(0, t);
    compressor.knee.setValueAtTime(0, t);
    compressor.ratio.setValueAtTime(1, t);
    compressor.attack.setValueAtTime(0.003, t);
    compressor.release.setValueAtTime(0.25, t);
  }
}

function makeSourceForElement(ctx, el) {
  let source = null;

  try {
    source = ctx.createMediaElementSource(el);
    return source;
  } catch (e) {}

  let stream = null;
  try {
    if (typeof el.captureStream === "function") {
      stream = el.captureStream();
    } else if (typeof el.mozCaptureStream === "function") {
      stream = el.mozCaptureStream();
    }
  } catch (e) {}

  if (!stream) return null;

  try {
    source = ctx.createMediaStreamSource(stream);
    return source;
  } catch (e) {
    return null;
  }
}

function attachMedia(el) {
  if (!el || audioElements.has(el)) return;

  const ctx = ensureContext();
  if (!ctx) return;

  try {
    const source = makeSourceForElement(ctx, el);
    if (!source) return;

    const filter = ctx.createBiquadFilter();
    const compressor = ctx.createDynamicsCompressor();
    const gain = ctx.createGain();

    source.connect(filter);
    filter.connect(compressor);
    compressor.connect(gain);
    gain.connect(ctx.destination);

    currentGain = mapVolumeToGain(currentVolumePercent);
    gain.gain.setValueAtTime(currentGain, ctx.currentTime);
    setFilterForMode(filter);
    applyOverdriveToCompressor(compressor);

    el.addEventListener("play", () => {
      if (ctx.state === "suspended") {
        ctx.resume().catch(() => {});
      }
    });

    el.addEventListener("ended", () => {
      audioElements.delete(el);
      try {
        source.disconnect();
        filter.disconnect();
        compressor.disconnect();
        gain.disconnect();
      } catch (e) {}
    });

    if (!el.paused && !el.ended && ctx.state === "suspended") {
      ctx.resume().catch(() => {});
    }

    audioElements.set(el, { source, filter, compressor, gain });
  } catch (e) {
    console.error("SoundSphere: failed to attach media element", e);
  }
}

function scanForMedia(root = document) {
  const nodes = root.querySelectorAll("audio, video");
  nodes.forEach(attachMedia);
}

function installObserver() {
  const observer = new MutationObserver(mutations => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach(node => {
        if (!(node instanceof HTMLElement)) return;

        if (node.matches && node.matches("audio, video")) {
          attachMedia(node);
        }

        scanForMedia(node);
      });
    }
  });

  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true
  });
}

function injectWebAudioHook() {
  const code = `
    (function () {
      if (typeof AudioNode === "undefined") return;

      var nativeConnect = AudioNode.prototype.connect;
      var destinations = new Set();

      function mapVolumeToGain(percent) {
        var p = Math.max(0, Math.min(800, Number(percent) || 0));
        if (p === 0) return 0;
        if (p <= 600) return (p / 600) * 6;
        var extra = (p - 600) / 200;
        return 6 + extra * 2;
      }

      function applyModeToFilter(filter, ctx, mode) {
        var t = ctx.currentTime || 0;

        if (mode === "voice") {
          filter.type = "highshelf";
          filter.frequency.setValueAtTime(3000, t);
          filter.Q.setValueAtTime(0.9, t);
          filter.gain.setValueAtTime(10, t);
          return;
        }

        if (mode === "bass") {
          filter.type = "lowshelf";
          filter.frequency.setValueAtTime(160, t);
          filter.Q.setValueAtTime(0.8, t);
          filter.gain.setValueAtTime(12, t);
          return;
        }

        filter.type = "peaking";
        filter.frequency.setValueAtTime(1000, t);
        filter.Q.setValueAtTime(1, t);
        filter.gain.setValueAtTime(0, t);
      }

      function applyOverdriveToCompressor(compressor, ctx, enabled) {
        var t = ctx.currentTime || 0;
        if (enabled) {
          compressor.threshold.setValueAtTime(-18, t);
          compressor.knee.setValueAtTime(15, t);
          compressor.ratio.setValueAtTime(8, t);
          compressor.attack.setValueAtTime(0.003, t);
          compressor.release.setValueAtTime(0.25, t);
        } else {
          compressor.threshold.setValueAtTime(0, t);
          compressor.knee.setValueAtTime(0, t);
          compressor.ratio.setValueAtTime(1, t);
          compressor.attack.setValueAtTime(0.003, t);
          compressor.release.setValueAtTime(0.25, t);
        }
      }

      function ensureChain(dest) {
        var ctx = dest.context || dest.audioContext || null;
        if (!ctx) return null;

        if (!dest.__soundSphereChain) {
          var filter = ctx.createBiquadFilter();
          var compressor = ctx.createDynamicsCompressor();
          var gain = ctx.createGain();

          filter.connect(compressor);
          compressor.connect(gain);
          nativeConnect.call(gain, dest);

          dest.__soundSphereChain = {
            filter: filter,
            compressor: compressor,
            gain: gain
          };

          applyModeToFilter(filter, ctx, "default");
          applyOverdriveToCompressor(compressor, ctx, false);
        }

        destinations.add(dest);
        return dest.__soundSphereChain;
      }

      AudioNode.prototype.connect = function (target) {
        try {
          if (target instanceof AudioDestinationNode) {
            var chain = ensureChain(target);
            if (chain) {
              return nativeConnect.call(this, chain.filter);
            }
          }
        } catch (e) {}
        return nativeConnect.apply(this, arguments);
      };

      window.addEventListener("message", function (ev) {
        var data = ev.data;
        if (!data || data.type !== "SoundSphereCmd") return;

        if (data.kind === "setVolume") {
          var percent = Number(data.volume) || 0;
          var gainVal = mapVolumeToGain(percent);
          destinations.forEach(function (dest) {
            var chain = dest.__soundSphereChain;
            if (!chain) return;
            try {
              chain.gain.gain.value = gainVal;
            } catch (e) {}
          });
          return;
        }

        if (data.kind === "setMode") {
          var mode = data.mode || "default";
          destinations.forEach(function (dest) {
            var chain = dest.__soundSphereChain;
            if (!chain) return;
            var ctx = chain.gain.context || chain.filter.context;
            if (!ctx) return;
            applyModeToFilter(chain.filter, ctx, mode);
          });
          return;
        }

        if (data.kind === "setOverdrive") {
          var enabled = !!data.enabled;
          destinations.forEach(function (dest) {
            var chain = dest.__soundSphereChain;
            if (!chain) return;
            var ctx = chain.gain.context || chain.filter.context;
            if (!ctx) return;
            applyOverdriveToCompressor(chain.compressor, ctx, enabled);
          });
        }
      });
    })();
  `;

  const s = document.createElement("script");
  s.textContent = code;
  (document.documentElement || document.head || document.body).appendChild(s);
  s.remove();
}

if (useInjectedWebAudio) {
  injectWebAudioHook();
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== "string") {
    return;
  }

  if (useInjectedWebAudio) {
    if (message.action === "setVolume") {
      const value = Math.max(0, Math.min(800, Number(message.volume) || 0));
      window.postMessage(
        {
          type: "SoundSphereCmd",
          kind: "setVolume",
          volume: value
        },
        "*"
      );
      sendResponse({ success: true });
    }

    if (message.action === "setMode") {
      const mode = message.mode || "default";
      window.postMessage(
        {
          type: "SoundSphereCmd",
          kind: "setMode",
          mode: mode
        },
        "*"
      );
      sendResponse({ success: true });
    }

    if (message.action === "setOverdrive") {
      const enabled = !!message.enabled;
      window.postMessage(
        {
          type: "SoundSphereCmd",
          kind: "setOverdrive",
          enabled: enabled
        },
        "*"
      );
      overdriveEnabled = enabled;
      sendResponse({ success: true });
    }

    return true;
  }

  if (message.action === "setVolume") {
    const value = Math.max(0, Math.min(800, Number(message.volume) || 0));
    currentVolumePercent = value;
    currentGain = mapVolumeToGain(currentVolumePercent);

    if (audioContext) {
      const t = audioContext.currentTime || 0;
      audioElements.forEach(({ gain }) => {
        if (!gain) return;
        gain.gain.setValueAtTime(currentGain, t);
      });
    }

    sendResponse({ success: true });
  }

  if (message.action === "setMode") {
    currentMode = message.mode || "default";
    if (audioContext) {
      audioElements.forEach(({ filter }) => setFilterForMode(filter));
    }
    sendResponse({ success: true });
  }

  if (message.action === "setOverdrive") {
    overdriveEnabled = !!message.enabled;
    if (audioContext) {
      audioElements.forEach(({ compressor }) => {
        applyOverdriveToCompressor(compressor);
      });
    }
    sendResponse({ success: true });
  }

  return true;
});

if (!useInjectedWebAudio) {
  if (
    document.readyState === "complete" ||
    document.readyState === "interactive"
  ) {
    scanForMedia();
  } else {
    window.addEventListener("DOMContentLoaded", () => {
      scanForMedia();
    });
  }

  installObserver();
}

console.log(
  "SoundSphere content script loaded (" +
    (useInjectedWebAudio ? "WebAudio hook" : "media elements") +
    ") on " +
    host
);
