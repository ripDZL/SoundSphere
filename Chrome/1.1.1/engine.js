"use strict";

// SoundSphere engine
// Runs in engine.html and owns the WebAudio graph for tab-capture sites.

// Owns a single tab-capture audio graph.
// The popup tells this controller which tab to capture and what
// gain / mode / EQ settings to apply.
class TabAudioController {
  constructor() {
    this.audioCtx = null;
    this.stream = null;
    this.tabId = null;

    this.gainNode = null;
    this.modeFilter = null;
    this.eqNodes = [];

    this.currentGain = 1.0;
    this.currentMode = "default";
    this.currentEq = new Array(10).fill(0);
  }

  async ensureForTab(tabId) {
    if (!tabId) return;

    // If we already have a live graph for this tab, reuse it.
    if (
      this.tabId === tabId &&
      this.audioCtx &&
      this.gainNode &&
      this.stream
    ) {
      return;
    }

    this.dispose();
    this.tabId = tabId;

    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: tabId },
        id => {
          if (chrome.runtime.lastError || !id) {
            reject(
              chrome.runtime.lastError ||
                new Error("Failed to get tab capture stream id")
            );
          } else {
            resolve(id);
          }
        }
      );
    });

    const userStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;

    const ctx = new AudioContextCtor();
    this.audioCtx = ctx;
    this.stream = userStream;

    const source = ctx.createMediaStreamSource(userStream);
    const gain = ctx.createGain();
    const modeFilter = ctx.createBiquadFilter();

    // 10-band EQ filters (31 Hz → 16 kHz).
    const freqs = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    const eqNodes = freqs.map(freq => {
      const node = ctx.createBiquadFilter();
      node.type = "peaking";
      node.frequency.setValueAtTime(freq, ctx.currentTime);
      node.Q.setValueAtTime(1, ctx.currentTime);
      node.gain.setValueAtTime(0, ctx.currentTime);
      return node;
    });

    // Apply stored state to the fresh graph.
    try {
      gain.gain.setValueAtTime(this.currentGain, ctx.currentTime);
    } catch (error) {
      console.debug("SoundSphere tabCapture gain init issue:", error);
    }

    this._applyModeFilter(modeFilter, ctx);
    this._applyEqFilters(eqNodes, ctx);

    // Wire: source -> gain -> modeFilter -> eq[0..9] -> destination
    source.connect(gain);
    gain.connect(modeFilter);

    let last = modeFilter;
    eqNodes.forEach(node => {
      last.connect(node);
      last = node;
    });

    last.connect(ctx.destination);

    this.gainNode = gain;
    this.modeFilter = modeFilter;
    this.eqNodes = eqNodes;
  }

  async setGainPercent(tabId, percent) {
    const gainValue = Math.max(0, Number(percent) || 0) / 100.0;
    this.currentGain = gainValue;

    try {
      await this.ensureForTab(tabId);
    } catch (error) {
      const msg = error && error.message ? error.message : String(error || "Unknown error");

      // On some pages Chrome will naturally refuse tab capture (e.g. chrome:// pages,
      // certain internal URLs, or when a tab is closed mid-request). These show up
      // as DOMExceptions but are harmless for the user. We keep the log quiet in the
      // release build and only surface unusual issues in debug tools if needed.
      const benign =
        msg.includes("Permission denied") ||
        msg.includes("Could not start audio source") ||
        msg.includes("Requested device not found") ||
        msg.includes("The tab is gone") ||
        msg.includes("getUserMedia");

      if (!benign) {
        console.debug("SoundSphere tabCapture init issue:", msg);
      }
      return;
    }

    if (!this.audioCtx || !this.gainNode) return;

    try {
      this.gainNode.gain.setValueAtTime(
        gainValue,
        this.audioCtx.currentTime
      );
    } catch (error) {
      console.debug("SoundSphere tabCapture gain issue:", error);
    }
  }

  setEqGains(gains) {
    const arr = Array.isArray(gains) ? gains.slice(0, 10) : [];
    while (arr.length < 10) arr.push(0);
    this.currentEq = arr;

    if (!this.audioCtx || !this.eqNodes.length) return;
    this._applyEqFilters(this.eqNodes, this.audioCtx);
  }

  setMode(mode) {
    this.currentMode = mode || "default";
    if (!this.audioCtx || !this.modeFilter) return;
    this._applyModeFilter(this.modeFilter, this.audioCtx);
  }

  _applyModeFilter(node, ctx) {
    if (!node || !ctx) return;

    try {
      node.gain.setValueAtTime(0, ctx.currentTime);
    } catch {}

    if (this.currentMode === "voice") {
      node.type = "peaking";
      node.frequency.setValueAtTime(3000, ctx.currentTime);
      node.Q.setValueAtTime(1, ctx.currentTime);
      node.gain.setValueAtTime(10, ctx.currentTime);
    } else if (this.currentMode === "bass") {
      node.type = "lowshelf";
      node.frequency.setValueAtTime(90, ctx.currentTime);
      node.gain.setValueAtTime(12, ctx.currentTime);
    } else {
      node.type = "peaking";
      node.frequency.setValueAtTime(1000, ctx.currentTime);
      node.Q.setValueAtTime(1, ctx.currentTime);
      node.gain.setValueAtTime(0, ctx.currentTime);
    }
  }

  _applyEqFilters(nodes, ctx) {
    if (!nodes || !ctx) return;

    const freqs = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
    const gains =
      this.currentEq.length === 10 ? this.currentEq : new Array(10).fill(0);

    nodes.forEach((node, index) => {
      const freq = freqs[index] || 1000;
      const gain = typeof gains[index] === "number" ? gains[index] : 0;

      node.type = "peaking";
      node.frequency.setValueAtTime(freq, ctx.currentTime);
      node.Q.setValueAtTime(1, ctx.currentTime);
      node.gain.setValueAtTime(gain, ctx.currentTime);
    });
  }

  dispose() {
    try {
      if (this.stream) {
        this.stream.getTracks().forEach(track => track.stop());
      }
      if (this.audioCtx) {
        this.audioCtx.close();
      }
    } catch (error) {
      console.debug("SoundSphere tabCapture dispose issue:", error);
    } finally {
      this.audioCtx = null;
      this.gainNode = null;
      this.modeFilter = null;
      this.eqNodes = [];
      this.stream = null;
      this.tabId = null;
    }
  }
}

const engineController = new TabAudioController();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== "engine") {
    return;
  }

  const { type, tabId, volume, gains, mode } = message;

  (async () => {
    try {
      if (type === "SET_GAIN") {
        await engineController.setGainPercent(tabId, volume);
      } else if (type === "SET_EQ") {
        engineController.setEqGains(gains);
      } else if (type === "SET_MODE") {
        engineController.setMode(mode);
      } else if (type === "DISPOSE") {
        engineController.dispose();
      }

      sendResponse({ ok: true });
    } catch (error) {
      console.error("SoundSphere engine error:", error);
      sendResponse({
        ok: false,
        error: error && error.message ? error.message : String(error)
      });
    }
  })();

  // Indicate we will respond asynchronously
  return true;
});
