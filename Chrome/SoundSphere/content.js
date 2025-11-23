// SoundSphere content.js — Chrome version with simple limiter.
// Receives volume as 0–800 from popup and converts that to gain (0.0–8.0).
// Chain: media -> gain -> filter (voice/bass) -> compressor -> destination.

let currentVolume = 1.0;      // gain value
let currentMode = 'default';  // 'default' | 'voice' | 'bass'

// Map of media element -> node bundle
const mediaMap = new Map();

function applyMode(filter, ctx) {
  if (!filter || !ctx) return;

  if (currentMode === 'default') {
    filter.type = 'peaking';
    filter.frequency.setValueAtTime(1000, ctx.currentTime);
    filter.Q.setValueAtTime(1, ctx.currentTime);
    filter.gain.setValueAtTime(0, ctx.currentTime);
    return;
  }

  if (currentMode === 'voice') {
    filter.type = 'peaking';
    filter.frequency.setValueAtTime(2500, ctx.currentTime);
    filter.Q.setValueAtTime(1.2, ctx.currentTime);
    filter.gain.setValueAtTime(6, ctx.currentTime);
    return;
  }

  if (currentMode === 'bass') {
    filter.type = 'lowshelf';
    filter.frequency.setValueAtTime(120, ctx.currentTime);
    filter.gain.setValueAtTime(8, ctx.currentTime);
    return;
  }
}

function createCompressor(ctx) {
  const comp = ctx.createDynamicsCompressor();
  try {
    // Gentle limiter-style settings
    comp.threshold.setValueAtTime(-6, ctx.currentTime);  // start clamping peaks
    comp.knee.setValueAtTime(12, ctx.currentTime);
    comp.ratio.setValueAtTime(4, ctx.currentTime);
    comp.attack.setValueAtTime(0.003, ctx.currentTime);
    comp.release.setValueAtTime(0.25, ctx.currentTime);
  } catch (e) {
    // some platforms might not support setting all params, that's fine
  }
  return comp;
}

function hookElement(el) {
  if (!el || mediaMap.has(el)) return;

  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(el);
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const compressor = createCompressor(ctx);

    gain.gain.setValueAtTime(currentVolume, ctx.currentTime);
    applyMode(filter, ctx);

    // media -> gain -> tone filter -> compressor -> speakers
    source.connect(gain);
    gain.connect(filter);
    filter.connect(compressor);
    compressor.connect(ctx.destination);

    mediaMap.set(el, { ctx, source, gain, filter, compressor });

    const handleEnded = () => {
      mediaMap.delete(el);
      try { ctx.close(); } catch (e) {}
      el.removeEventListener('ended', handleEnded);
      el.removeEventListener('pause', handlePause);
    };

    const handlePause = () => {
      if (ctx.state === 'running') {
        ctx.suspend().catch(() => {});
      }
    };

    el.addEventListener('ended', handleEnded);
    el.addEventListener('pause', handlePause);
    el.addEventListener('play', () => {
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {});
      }
    });
  } catch (e) {
    console.error('SoundSphere hook error:', e);
  }
}

function scanAndHook(root) {
  const scope = root || document;
  scope.querySelectorAll('audio, video').forEach(hookElement);
}

// initial scan
scanAndHook(document);

// periodic scan for sites that swap players (Bandcamp, SoundCloud, etc.)
setInterval(() => scanAndHook(document), 1500);

// react to DOM changes as well
new MutationObserver((mutations) => {
  for (const mut of mutations) {
    mut.addedNodes.forEach((node) => {
      if (!(node instanceof Element)) return;
      if (node.matches('audio,video')) {
        hookElement(node);
      } else if (node.querySelectorAll) {
        scanAndHook(node);
      }
    });
  }
}).observe(document.documentElement || document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src']
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.action === 'setVolume') {
    const percent = typeof message.volume === 'number' ? message.volume : 100;
    const clamped = Math.max(0, Math.min(percent, 800));

    // 0–800% -> 0.0–8.0 gain
    currentVolume = clamped / 100;

    mediaMap.forEach(({ gain, ctx }) => {
      try {
        gain.gain.setValueAtTime(currentVolume, ctx.currentTime);
      } catch (e) {}
    });

    sendResponse({ success: true });
    return true;
  }

  if (message.action === 'setMode') {
    currentMode = message.mode || 'default';
    mediaMap.forEach(({ filter, ctx }) => applyMode(filter, ctx));
    sendResponse({ success: true });
    return true;
  }

  return false;
});

console.log('SoundSphere content script loaded (Chrome with limiter)');
