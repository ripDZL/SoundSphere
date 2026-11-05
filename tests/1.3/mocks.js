"use strict";
// Minimal browser/extension mocks for running SoundSphere scripts in Node vm contexts.
const vm = require("vm");
const fs = require("fs");
const path = require("path");

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

function makeParam(value = 0) {
  return {
    value,
    setValueAtTime(v) { this.value = v; },
    setTargetAtTime(v) { this.value = v; },
    linearRampToValueAtTime(v) { this.value = v; },
    cancelScheduledValues() {}
  };
}

function makeAudioWorld(opts = {}) {
  const world = { contexts: [], mediaSources: [], streamSources: [] };
  class AudioNodeBase {
    constructor(ctx, kind) { this.context = ctx; this.kind = kind; this.outputs = new Set(); }
    connect(dest) { this.outputs.add(dest); return dest; }
    disconnect(dest) {
      if (dest === undefined) { this.outputs.clear(); return; }
      if (!this.outputs.has(dest)) { const e = new Error("not connected"); e.name = "InvalidAccessError"; throw e; }
      this.outputs.delete(dest);
    }
  }
  class AudioContext {
    constructor() {
      this.closed = false;
      this.state = opts.initialState || "running";
      this.currentTime = 0;
      this.onstatechange = null;
      this._listeners = [];
      this.destination = new AudioNodeBase(this, "destination");
      world.contexts.push(this);
    }
    addEventListener(type, fn) { if (type === "statechange") this._listeners.push(fn); }
    removeEventListener(type, fn) { this._listeners = this._listeners.filter(f => f !== fn); }
    _setState(s) {
      this.state = s;
      if (this.onstatechange) this.onstatechange();
      this._listeners.slice().forEach(f => f());
    }
    resume() {
      if (opts.resumeWorks !== false && this.state === "suspended") this._setState("running");
      return Promise.resolve();
    }
    close() { this.closed = true; this._setState("closed"); return Promise.resolve(); }
    createGain() { const n = new AudioNodeBase(this, "gain"); n.gain = makeParam(1); return n; }
    createBiquadFilter() {
      const n = new AudioNodeBase(this, "biquad");
      n.type = "lowpass"; n.frequency = makeParam(350); n.Q = makeParam(1); n.gain = makeParam(0);
      return n;
    }
    createDynamicsCompressor() {
      const n = new AudioNodeBase(this, "compressor");
      n.threshold = makeParam(-24); n.knee = makeParam(30); n.ratio = makeParam(12);
      n.attack = makeParam(0.003); n.release = makeParam(0.25);
      return n;
    }
    createWaveShaper() { const n = new AudioNodeBase(this, "shaper"); n.curve = null; n.oversample = "none"; return n; }
    createAnalyser() { const n = new AudioNodeBase(this, "analyser"); n.fftSize = 2048; n.smoothingTimeConstant = 0.8; return n; }
    createMediaStreamSource(stream) { const n = new AudioNodeBase(this, "streamSource"); n.stream = stream; world.streamSources.push(n); return n; }
    createMediaElementSource(el) {
      if (el.__ssSourced) throw new Error("already connected");
      el.__ssSourced = true;
      const n = new AudioNodeBase(this, "elementSource"); n.mediaElement = el; world.mediaSources.push(n); return n;
    }
  }
  world.AudioContext = AudioContext;
  world.AudioNode = AudioNodeBase;
  return world;
}

function makeEvent(name) {
  const listeners = [];
  return {
    listeners,
    addListener(fn) { listeners.push(fn); },
    removeListener(fn) { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); },
    fire(...args) { return listeners.map(fn => fn(...args)); }
  };
}

function makeStorageArea(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  return {
    data,
    get(defaults, cb) {
      let out;
      if (defaults === null || defaults === undefined) out = JSON.parse(JSON.stringify(data));
      else if (typeof defaults === "string") out = defaults in data ? { [defaults]: data[defaults] } : {};
      else if (Array.isArray(defaults)) { out = {}; defaults.forEach(k => { if (k in data) out[k] = data[k]; }); }
      else { out = {}; for (const k of Object.keys(defaults)) out[k] = k in data ? JSON.parse(JSON.stringify(data[k])) : defaults[k]; }
      setTimeout(() => cb && cb(out), 0);
    },
    set(values, cb) { Object.assign(data, JSON.parse(JSON.stringify(values))); setTimeout(() => cb && cb(), 0); },
    remove(keys, cb) { [].concat(keys).forEach(k => delete data[k]); setTimeout(() => cb && cb(), 0); }
  };
}

function loadScript(file, sandbox) {
  const src = fs.readFileSync(file, "utf8");
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: path.basename(file) });
  return sandbox;
}

module.exports = { tick, makeParam, makeAudioWorld, makeEvent, makeStorageArea, loadScript };
