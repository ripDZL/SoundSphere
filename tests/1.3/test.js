"use strict";
// Behavioural regression tests for SoundSphere-1.3 (Node, no browser).
// Runs background/offscreen/content/popup/tap scripts in vm contexts with
// minimal WebAudio + extension API mocks.
// Usage: node tests/1.3/test.js [path-to-SoundSphere-1.3]   (exit 1 on failure)
const path = require("path");
const vm = require("vm");
const { tick, makeAudioWorld, makeEvent, makeStorageArea, loadScript } = require("./mocks");

const DIR = path.resolve(process.argv[2] || path.join(__dirname, "../../SoundSphere-1.3"));
const results = [];
async function test(name, fn) {
  try { await fn(); results.push([name, "PASS", ""]); }
  catch (e) { results.push([name, "FAIL", e.message]); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// ---------------------------------------------------------------- Chrome env
function makeChromeEnv(opts = {}) {
  const env = {
    world: makeAudioWorld(),
    offscreenCtx: null,
    offscreenExists: false,
    createDocCalls: 0,
    closeDocCalls: 0,
    streamIdCalls: 0,
    activeStreams: new Set(),
    tabMessages: [],
    invokedTabs: new Set(opts.invokedTabs || [1]),
    tabs: new Map((opts.tabs || [{ id: 1, url: "https://www.youtube.com/watch?v=x", audible: true }]).map(t => [t.id, t])),
    contentListener: opts.contentListener || null,
    gumDelay: opts.gumDelay ?? 60
  };
  const sync = makeStorageArea(opts.sync || {});
  const local = makeStorageArea(opts.local || {});
  const bgListeners = makeEvent();
  const offListeners = makeEvent();

  function deliver(listeners, message, sender, cb, chromeObj) {
    let responded = false;
    let pending = false;
    const sendResponse = r => { if (responded) return; responded = true; setTimeout(() => cb && cb(r), 0); };
    for (const fn of listeners.listeners) {
      const ret = fn(message, sender, sendResponse);
      if (ret === true) pending = true;
      if (responded) return;
    }
    if (!pending && !responded) {
      setTimeout(() => {
        chromeObj.runtime.lastError = { message: "The message port closed before a response was received." };
        cb && cb(undefined);
        chromeObj.runtime.lastError = undefined;
      }, 0);
    }
  }

  function makeChrome(role) {
    const c = {};
    c.runtime = {
      id: "ext",
      lastError: undefined,
      getURL: p => "chrome-extension://ext/" + p,
      onMessage: role === "bg" ? bgListeners : offListeners,
      onInstalled: makeEvent(),
      onStartup: makeEvent(),
      getContexts: async () => (env.offscreenExists ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
      sendMessage(message, cb) {
        const sender = { id: "ext", url: role === "bg" ? "chrome-extension://ext/background.js" : "chrome-extension://ext/offscreen.html" };
        if (role === "bg") {
          if (!env.offscreenExists || !env.offscreenCtx) {
            setTimeout(() => {
              c.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
              cb && cb(undefined);
              c.runtime.lastError = undefined;
            }, 0);
            return;
          }
          deliver(offListeners, message, sender, cb, c);
        }
      }
    };
    if (role === "bg") {
      c.tabs = {
        query: (q, cb) => setTimeout(() => cb([...env.tabs.values()].filter(t => !q.audible || t.audible)), 0),
        get: (id, cb) => setTimeout(() => {
          const t = env.tabs.get(id);
          if (!t) { c.runtime.lastError = { message: "No tab" }; cb(undefined); c.runtime.lastError = undefined; }
          else cb(t);
        }, 0),
        sendMessage: (tabId, message, a, b) => {
          const cb = typeof a === "function" ? a : b;
          env.tabMessages.push({ tabId, message });
          setTimeout(() => {
            if (env.contentListener) { cb(env.contentListener(message)); return; }
            c.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
            cb(undefined);
            c.runtime.lastError = undefined;
          }, 0);
        },
        onUpdated: makeEvent(), onActivated: makeEvent(), onRemoved: makeEvent()
      };
      c.storage = { sync, local, onChanged: makeEvent() };
      c.action = { setBadgeText() {}, setBadgeBackgroundColor() {} };
      c.offscreen = {
        createDocument: async () => {
          env.createDocCalls++;
          if (env.offscreenExists) throw new Error("Only a single offscreen document may be created.");
          env.offscreenExists = true;
          await tick(10);
          env.offscreenCtx = loadOffscreen();
        },
        closeDocument: async () => {
          env.closeDocCalls++;
          env.offscreenExists = false;
          env.offscreenCtx = null;
          env.world.contexts.forEach(ctx => { if (!ctx.closed) ctx.close(); });
          offListeners.listeners.length = 0;
        },
        hasDocument: async () => env.offscreenExists
      };
      c.tabCapture = {
        getMediaStreamId: async ({ targetTabId }) => {
          env.streamIdCalls++;
          await tick(5);
          if (!env.invokedTabs.has(targetTabId)) throw new Error("Extension has not been invoked for the current page (see activeTab permission).");
          if (env.activeStreams.has(targetTabId)) throw new Error("Cannot capture a tab with an active stream.");
          return "sid-" + targetTabId + "-" + env.streamIdCalls;
        }
      };
    }
    return c;
  }

  function loadOffscreen() {
    const chromeOff = makeChrome("off");
    const sandbox = {
      chrome: chromeOff,
      console, setTimeout, clearTimeout, Promise, Float32Array, Math, Number, Array, Object, Map, Set, Symbol, Error, Date,
      AudioContext: env.world.AudioContext,
      navigator: {
        mediaDevices: {
          getUserMedia: async constraints => {
            const sid = constraints.audio.mandatory.chromeMediaSourceId;
            const tabId = Number(sid.split("-")[1]);
            await tick(env.gumDelay);
            env.activeStreams.add(tabId);
            const listeners = [];
            const track = {
              stopped: false,
              stop() { this.stopped = true; env.activeStreams.delete(tabId); },
              addEventListener(t, fn) { if (t === "ended") listeners.push(fn); },
              set onended(fn) { listeners.push(fn); }
            };
            return { tabId, track, getTracks: () => [track], getAudioTracks: () => [track] };
          }
        }
      }
    };
    return loadScript(path.join(DIR, "offscreen.js"), sandbox);
  }

  const chromeBg = makeChrome("bg");
  const bgSandbox = {
    chrome: chromeBg, console, clearTimeout, Promise, Math, Number, Array, Object, Map, Set, Error, String, Boolean, JSON,
    // Compress long idle timers so lifecycle tests run fast.
    setTimeout: (fn, ms) => setTimeout(fn, ms > 1000 ? 10 : ms)
  };
  loadScript(path.join(DIR, "background.js"), bgSandbox);
  env.chrome = chromeBg;
  env.sync = sync;
  env.local = local;

  env.send = (message, sender = { id: "ext", url: "chrome-extension://ext/popup.html" }) =>
    new Promise(resolve => {
      let done = false;
      const sendResponse = r => { done = true; resolve(r); };
      let pending = false;
      for (const fn of bgListeners.listeners) { if (fn(message, sender, sendResponse) === true) pending = true; }
      if (!pending && !done) resolve(undefined);
    });
  env.liveContexts = () => env.world.contexts.filter(c => !c.closed);
  return env;
}

// ---------------------------------------------------------------- Content env
function makeElement(tag, props = {}) {
  const listeners = {};
  const attrs = {};
  const el = Object.assign({
    nodeType: 1, tagName: tag, src: "", currentSrc: "", crossOrigin: null, srcObject: null,
    volume: 1, muted: false, paused: false, currentTime: 0, playbackRate: 1, isConnected: true,
    loads: 0, plays: 0,
    addEventListener(t, fn, o) {
      const once = o && o.once;
      const wrapped = once ? function w(e) { el.removeEventListener(t, w); return fn(e); } : fn;
      wrapped.__orig = fn;
      (listeners[t] = listeners[t] || []).push(wrapped);
    },
    removeEventListener(t, fn) { listeners[t] = (listeners[t] || []).filter(f => f !== fn && f.__orig !== fn); },
    _fire(t) { (listeners[t] || []).slice().forEach(fn => fn({ type: t, target: el })); },
    getAttribute(n) { return n === "src" ? (el.src || null) : (attrs[n] ?? null); },
    removeAttribute(n) { delete attrs[n]; if (n === "crossorigin") el.crossOrigin = null; },
    load() { el.loads++; },
    play() { el.plays++; el.paused = false; return Promise.resolve(); },
    querySelectorAll: () => []
  }, props);
  return el;
}

function makeContentEnv(opts = {}) {
  const world = makeAudioWorld({ initialState: opts.initialState, resumeWorks: opts.resumeWorks });
  const elements = opts.elements || [];
  const injected = [];
  const probes = [];
  const docListeners = {};
  const winListeners = {};
  const runtimeListeners = makeEvent();
  const origin = opts.origin || "https://www.youtube.com";
  const document = {
    documentElement: { appendChild: n => injected.push(n) },
    head: { appendChild: n => injected.push(n) },
    baseURI: origin + "/page",
    querySelectorAll: sel => (sel.includes("audio") || sel.includes("video") ? elements.slice() : []),
    querySelector: sel => ((sel.includes("audio") || sel.includes("video")) ? (elements[0] || null) : null),
    createElement: tag => {
      if (/^(audio|video)$/i.test(tag)) {
        const probe = makeElement(tag.toUpperCase(), { isConnected: false });
        probes.push(probe);
        return probe;
      }
      return { tagName: tag.toUpperCase(), addEventListener() {}, remove() {} };
    },
    addEventListener(t, fn) { (docListeners[t] = docListeners[t] || []).push(fn); },
    removeEventListener() {}
  };
  const win = {
    AudioContext: world.AudioContext,
    location: { origin, href: origin + "/page", hostname: new URL(origin).hostname },
    addEventListener(t, fn) { (winListeners[t] = winListeners[t] || []).push(fn); },
    removeEventListener() {},
    postMessage(data) { posted.push(data); }
  };
  const posted = [];
  win.window = win;
  win.top = opts.subframe ? {} : win;
  // Page-side HTMLMediaElement prototype; elements "play" through it.
  const pageProto = { play() { this.paused = false; return "native-play"; } };
  const nativePagePlay = pageProto.play;
  let nativePageCreate = null;
  const extras = {};
  if (opts.firefox) {
    const pageDocProto = { createElement: tag => makeElement(String(tag).toUpperCase(), { isConnected: false }) };
    nativePageCreate = pageDocProto.createElement;
    extras.wrappedJSObject = { HTMLMediaElement: { prototype: pageProto }, Document: { prototype: pageDocProto } };
    extras.exportFunction = (fn, target, o) => { target[o.defineAs] = fn; return fn; };
  }
  const sandbox = Object.assign(win, extras, {
    document,
    chrome: { runtime: { onMessage: runtimeListeners, getURL: p => "moz-extension://uuid/" + p, id: "ext" } },
    MutationObserver: class { observe() {} disconnect() {} },
    URL, console: Object.assign(Object.create(console), { info() {} }), // mute [SoundSphere] diagnostics
    setTimeout, clearTimeout, Promise, Float32Array, Math, Number, Array, Object, Map, Set, WeakMap, WeakSet, WeakRef, Symbol, Error, String, Boolean, Date, JSON
  });
  loadScript(path.join(DIR, "content.js"), sandbox);
  const env = { world, elements, injected, docListeners, sandbox, pageProto, probes, nativePagePlay, nativePageCreate, posted };
  // Page code calling el.play() goes through the (possibly patched) prototype.
  env.pagePlay = el => pageProto.play.call(el);
  env.send = message => new Promise(resolve => {
    let settled = false;
    const sendResponse = r => { settled = true; resolve({ responded: true, value: r }); };
    let pending = false;
    for (const fn of runtimeListeners.listeners) if (fn(message, { id: "ext" }, sendResponse) === true) pending = true;
    if (!pending && !settled) resolve({ responded: false });
    else if (pending) setTimeout(() => { if (!settled) resolve({ responded: false, timedOut: true }); }, 1000);
  });
  env.firePlay = el => (docListeners.play || []).forEach(fn => fn({ type: "play", target: el }));
  const innerWindow = vm.runInContext("window", sandbox); // vm global proxy, not `win`
  env.postFromPage = data => (winListeners.message || []).forEach(fn => fn({ source: innerWindow, data }));
  return env;
}

// ---------------------------------------------------------------- Page MAIN-world env (inject/media_main.js)
function makeMainWorldEnv(opts = {}) {
  const world = makeAudioWorld({ initialState: opts.initialState });
  const origin = opts.origin || "https://soundcloud.com";
  const listeners = [];
  const out = [];
  class HTMLMediaElement {}
  const nativePlay = function play() { this.paused = false; return "native-play"; };
  HTMLMediaElement.prototype.play = nativePlay;
  // Browser-like accessor: actual output level lives in _out.
  Object.defineProperty(HTMLMediaElement.prototype, "volume", {
    configurable: true, enumerable: true,
    get() { return this._out ?? 1; },
    set(v) {
      const n = Number(v);
      if (!(n >= 0 && n <= 1)) throw new RangeError("IndexSizeError");
      this._out = n;
    }
  });
  const document = { baseURI: origin + "/" };
  const win = {
    AudioContext: world.AudioContext, HTMLMediaElement, document,
    location: { origin, hostname: new URL(origin).hostname },
    addEventListener(t, fn) { if (t === "message") listeners.push(fn); },
    postMessage(data) { out.push(data); }
  };
  win.window = win;
  const sandbox = Object.assign(win, {
    console: Object.assign(Object.create(console), { info() {} }),
    URL, setTimeout, clearTimeout, Promise, Float32Array, Math, Number, Array, Object, WeakMap, WeakSet, Map, Set, String, Boolean, JSON
  });
  loadScript(path.join(DIR, "inject/media_main.js"), sandbox);
  const inner = vm.runInContext("window", sandbox);
  const env = { world, out, HTMLMediaElement, nativePlay, sandbox };
  env.el = (props = {}) => {
    const { volume = 1, ...rest } = props;
    return Object.assign(new HTMLMediaElement(), {
      _out: volume, muted: false, paused: true, currentSrc: "", src: "", crossOrigin: null, srcObject: null, mediaKeys: null,
      tagName: "AUDIO", isConnected: false, getRootNode() { return this.isConnected ? document : this; }
    }, rest);
  };
  env.play = el => HTMLMediaElement.prototype.play.call(el);
  env.settings = settings => listeners.forEach(fn => fn({ source: inner, data: { source: "SoundSphere", type: "SS_MAIN_SETTINGS", payload: settings } }));
  env.lastStatus = () => [...out].reverse().find(m => m.type === "SS_MAIN_STATUS");
  return env;
}

// ---------------------------------------------------------------- Firefox background env
function makeFirefoxBgEnv(opts = {}) {
  const listeners = makeEvent();
  const onRemoved = makeEvent();
  const env = { ruleCalls: [], tabMessages: [] };
  const chromeFx = {
    runtime: { id: "ext", lastError: undefined, getURL: p => "moz-extension://uuid/" + p, onMessage: listeners, onInstalled: makeEvent(), onStartup: makeEvent() },
    tabs: {
      query: (q, cb) => setTimeout(() => cb([]), 0),
      sendMessage: (tabId, message, cb) => {
        env.tabMessages.push({ tabId, message });
        setTimeout(() => cb(opts.content ? opts.content(message) : undefined), 0);
      },
      onUpdated: makeEvent(), onActivated: makeEvent(), onRemoved
    },
    storage: { sync: makeStorageArea(), local: makeStorageArea(), onChanged: makeEvent() },
    action: { setBadgeText() {}, setBadgeBackgroundColor() {} }
  };
  const browserFx = {
    declarativeNetRequest: {
      updateSessionRules: async info => { env.ruleCalls.push(JSON.parse(JSON.stringify(info))); }
    }
  };
  loadScript(path.join(DIR, "background.firefox.js"), {
    chrome: chromeFx, browser: browserFx, console, setTimeout, clearTimeout, Promise, Math, Number, Array, Object, Map, Set, Error, String, Boolean, JSON
  });
  env.onRemoved = onRemoved;
  env.send = (message, sender = { id: "ext", url: "moz-extension://uuid/popup.html" }) => new Promise(resolve => {
    let pending = false;
    for (const fn of listeners.listeners) if (fn(message, sender, resolve) === true) pending = true;
    if (!pending) resolve(undefined);
  });
  return env;
}

// ---------------------------------------------------------------- Popup env
function makePopupEnv(opts = {}) {
  const sent = [];
  const els = {};
  const mkEl = id => ({
    id, value: "100", max: "800", textContent: "", style: {}, dataset: {}, checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, getAttribute: () => null, addEventListener() {}, appendChild() {}, append() {},
    querySelector: () => null, querySelectorAll: () => [], focus() {}, closest: () => null, hidden: false
  });
  const document = {
    getElementById: id => (els[id] = els[id] || mkEl(id)),
    createElement: t => mkEl(t),
    addEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null
  };
  const chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(message, cb) {
        sent.push(message);
        const reply = message.type === "SS_GET_STATUS"
          ? (opts.status || { ok: true, mode: "ready", canBoost: true, captureActive: false, engaged: false })
          : { ok: true, mode: "whole-tab", canBoost: true };
        setTimeout(() => cb && cb(reply), 0);
      },
      getURL: p => "chrome-extension://ext/" + p
    },
    storage: { sync: makeStorageArea(opts.sync || {}), local: makeStorageArea(opts.local || {}), onChanged: makeEvent() },
    tabs: {
      query: (q, cb) => setTimeout(() => cb([]), 0),
      update: (id, info, cb) => cb && cb(), onUpdated: makeEvent(), onRemoved: makeEvent(), onActivated: makeEvent()
    },
    windows: { update: (id, info, cb) => cb && cb() }
  };
  const sandbox = { document, chrome, window: {}, console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Promise, Math, Number, Array, Object, String, Boolean, JSON };
  sandbox.window = sandbox;
  loadScript(path.join(DIR, "popup.js"), sandbox);
  return { sandbox, sent, run: code => vm.runInContext(code, sandbox) };
}

// ---------------------------------------------------------------- helpers
function chainTransfer(world, amplitude) {
  // Walk the single linear chain from the newest stream source to destination,
  // applying gain values and waveshaper curves (domain [-1,1], linear interp).
  let node = world.streamSources[world.streamSources.length - 1];
  let x = amplitude;
  const seen = new Set();
  while (node && node.kind !== "destination" && !seen.has(node)) {
    seen.add(node);
    if (node.kind === "gain") x *= node.gain.value;
    if (node.kind === "shaper" && node.curve) {
      const c = node.curve; const n = c.length;
      const u = Math.max(-1, Math.min(1, x));
      const pos = (u + 1) / 2 * (n - 1);
      const i = Math.floor(pos); const f = pos - i;
      x = i >= n - 1 ? c[n - 1] : c[i] * (1 - f) + c[i + 1] * f;
    }
    node = [...node.outputs][0];
  }
  return x;
}
function findNode(world, kind) {
  for (const ctx of world.contexts) if (!ctx.closed) {
    let node = world.streamSources.find(s => s.context === ctx);
    const seen = new Set();
    while (node && !seen.has(node)) { seen.add(node); if (node.kind === kind) return node; node = [...node.outputs][0]; }
  }
  return null;
}

// ---------------------------------------------------------------- tests
(async () => {
  const popupSender = { id: "ext", url: "chrome-extension://ext/popup.html" };
  const neutral = { volume: 100, muted: false, mode: "default", eqGains: new Array(10).fill(0) };
  const boost = { volume: 150, muted: false, mode: "default", eqGains: new Array(10).fill(0) };

  await test("chrome: concurrent applies start exactly one capture (no leak/double audio)", async () => {
    // Offscreen doc already alive (another tab captured earlier) -> real-world timing.
    const env = makeChromeEnv({
      invokedTabs: [1, 2],
      tabs: [{ id: 1, url: "https://www.youtube.com/watch?v=x", audible: true }, { id: 2, url: "https://twitch.tv/x", audible: true }]
    });
    await env.send({ type: "SS_APPLY_SETTINGS", tabId: 2, settings: boost }, popupSender);
    env.streamIdCalls = 0;
    const before = env.world.contexts.length;
    const r = await Promise.all([
      env.send({ type: "SS_APPLY_SETTINGS", tabId: 1, settings: boost }, popupSender),
      env.send({ type: "SS_APPLY_SETTINGS", tabId: 1, settings: { ...boost, volume: 160 } }, popupSender),
      env.send({ type: "SS_APPLY_SETTINGS", tabId: 1, settings: { ...boost, volume: 170 } }, popupSender)
    ]);
    await tick(150);
    const live = env.liveContexts().length;
    const fallbacks = env.tabMessages.filter(m => m.message.type === "SS_CONTENT_APPLY").length;
    assert(env.streamIdCalls === 1, `getMediaStreamId called ${env.streamIdCalls}x, graphs built ${env.world.contexts.length - before}`);
    assert(live === 2, `live AudioContexts=${live} (expected 2: one per tab)`);
    assert(fallbacks === 0, `content fallback triggered ${fallbacks}x`);
    assert(r.every(x => x && x.mode === "whole-tab"), "modes=" + r.map(x => x && x.mode).join(","));
  });

  await test("chrome: closing an unrelated tab does not create offscreen doc", async () => {
    const env = makeChromeEnv();
    env.chrome.tabs.onRemoved.fire(42, {});
    await tick(60);
    assert(env.createDocCalls === 0, `createDocument called ${env.createDocCalls}x`);
  });

  await test("chrome: browser restart clears tab-id volume memory", async () => {
    const env = makeChromeEnv({ local: { vol_tabs: { "7": 600 } } });
    env.chrome.runtime.onStartup.fire();
    await tick(30);
    const left = env.local.data.vol_tabs ? Object.keys(env.local.data.vol_tabs).length : 0;
    assert(left === 0, `stale vol_tabs entries=${left}`);
  });

  await test("chrome: content fallback reset once whole-tab capture succeeds", async () => {
    const env = makeChromeEnv({ invokedTabs: [], contentListener: () => ({ ok: true, backend: "media-element", canBoost: true }) });
    await env.send({ type: "SS_APPLY_SETTINGS", tabId: 1, settings: boost }, popupSender);
    env.invokedTabs.add(1);
    const r = await env.send({ type: "SS_APPLY_SETTINGS", tabId: 1, settings: boost }, popupSender);
    await tick(20);
    assert(r && r.mode === "whole-tab", "second apply mode=" + (r && r.mode));
    const resets = env.tabMessages.filter(m => m.message.type === "SS_CONTENT_RESET").length;
    assert(resets >= 1, "no SS_CONTENT_RESET after capture took over");
  });

  await test("chrome: restricted page reports unsupported", async () => {
    const env = makeChromeEnv({ tabs: [{ id: 1, url: "chrome://settings", audible: false }] });
    const s = await env.send({ type: "SS_GET_STATUS", tabId: 1 }, popupSender);
    assert(s && s.mode === "unsupported" && !s.canBoost, "status=" + JSON.stringify(s));
  });

  await test("chrome: control messages from content scripts are ignored", async () => {
    const env = makeChromeEnv();
    await env.send({ type: "SS_APPLY_SETTINGS", tabId: 1, settings: boost }, { id: "ext", tab: { id: 9 }, url: "https://evil.example/" });
    await tick(120);
    assert(env.streamIdCalls === 0, "capture started from content-script sender");
  });

  await test("chrome: closing captured tab releases offscreen document", async () => {
    const env = makeChromeEnv();
    await env.send({ type: "SS_APPLY_SETTINGS", tabId: 1, settings: boost }, popupSender);
    env.tabs.delete(1);
    env.chrome.tabs.onRemoved.fire(1, {});
    await tick(200);
    assert(env.liveContexts().length === 0, "AudioContext still live");
    assert(!env.offscreenExists, "offscreen doc still open");
  });

  await test("dsp: neutral settings are transparent (offscreen)", async () => {
    const env = makeChromeEnv();
    await env.send({ type: "SS_APPLY_SETTINGS", tabId: 1, settings: neutral }, popupSender);
    await tick(20);
    for (const a of [0.1, 0.5, 0.8]) {
      const y = chainTransfer(env.world, a);
      assert(Math.abs(y - a) < 1e-3, `amp ${a} -> ${y.toFixed(4)}`);
    }
    const comp = findNode(env.world, "compressor");
    assert(comp && comp.ratio.value <= 1.01, "compressor ratio at neutral=" + (comp && comp.ratio.value));
  });

  await test("dsp: 800% boost output stays bounded <= 1.0", async () => {
    const env = makeChromeEnv();
    await env.send({ type: "SS_APPLY_SETTINGS", tabId: 1, settings: { ...neutral, volume: 800 } }, popupSender);
    await tick(20);
    // compressor ignored by walker (mock), so this checks the clipper alone
    const y = chainTransfer(env.world, 0.9);
    assert(y <= 1.0001 && y > 0.9, "800% * 0.9 -> " + y.toFixed(4));
  });

  await test("dsp: no idle AnalyserNode in offscreen chain", async () => {
    const env = makeChromeEnv();
    await env.send({ type: "SS_APPLY_SETTINGS", tabId: 1, settings: boost }, popupSender);
    await tick(20);
    assert(!findNode(env.world, "analyser"), "analyser present but never read");
  });

  // ---------------- content / Firefox path
  await test("content: STATUS is passive (no AudioContext, no hook, no inject)", async () => {
    const el = makeElement("VIDEO", { currentSrc: "blob:https://www.youtube.com/abc" });
    const env = makeContentEnv({ elements: [el] });
    await env.send({ type: "SS_CONTENT_STATUS" });
    assert(env.world.contexts.length === 0, "AudioContext created by status");
    assert(env.world.mediaSources.length === 0, "media hooked by status");
    assert(env.injected.length === 0, "tap injected by status");
  });

  await test("content: cross-origin media without CORS is not rerouted (would be silent)", async () => {
    const el = makeElement("AUDIO", { currentSrc: "https://t4.bcbits.com/stream/abc.mp3", volume: 0.6 });
    const env = makeContentEnv({ origin: "https://artist.bandcamp.com", elements: [el] });
    await env.send({ type: "SS_CONTENT_APPLY", settings: boost });
    await tick(20);
    assert(env.world.mediaSources.length === 0, "cross-origin element rerouted -> silence");
  });

  await test("content: same-origin/blob media hooked without forcing element volume", async () => {
    const el = makeElement("VIDEO", { currentSrc: "blob:https://www.youtube.com/abc", volume: 0.3 });
    const env = makeContentEnv({ elements: [el] });
    const r = await env.send({ type: "SS_CONTENT_APPLY", settings: boost });
    await tick(20);
    assert(env.world.mediaSources.length === 1, "not hooked");
    assert(Math.abs(el.volume - 0.3) < 1e-9, "player volume forced to " + el.volume);
    assert(r.value && r.value.canBoost, "canBoost false");
  });

  await test("content: never reroute into a suspended AudioContext", async () => {
    const el = makeElement("VIDEO", { currentSrc: "blob:https://www.youtube.com/abc" });
    const env = makeContentEnv({ elements: [el], initialState: "suspended", resumeWorks: false });
    await env.send({ type: "SS_CONTENT_APPLY", settings: boost });
    await tick(400);
    assert(env.world.mediaSources.length === 0, "hooked into suspended context -> silence");
    // page gesture later resumes the context -> should hook then
    env.world.contexts.forEach(c => c._setState("running"));
    await tick(20);
    assert(env.world.mediaSources.length === 1, "did not hook after context started");
  });

  await test("content: media-less subframe stays silent (top/media frame answers)", async () => {
    const env = makeContentEnv({ subframe: true, elements: [] });
    const r = await env.send({ type: "SS_CONTENT_APPLY", settings: boost });
    assert(!r.responded, "ad/empty iframe answered the broadcast");
  });

  await test("content: RESET before any apply is a no-op", async () => {
    const el = makeElement("VIDEO", { currentSrc: "blob:https://www.youtube.com/abc", volume: 0.4 });
    const env = makeContentEnv({ elements: [el] });
    await env.send({ type: "SS_CONTENT_RESET" });
    assert(env.injected.length === 0 && env.world.contexts.length === 0, "reset engaged processing");
    assert(el.volume === 0.4, "reset changed volume to " + el.volume);
  });

  await test("content: basic mode never louder than player volume; reset restores", async () => {
    const el = makeElement("AUDIO", { currentSrc: "https://cdn.example.net/a.mp3", volume: 0.5 });
    const env = makeContentEnv({ origin: "https://site.example", elements: [el] });
    await env.send({ type: "SS_CONTENT_APPLY", settings: { ...boost, volume: 50 } });
    assert(Math.abs(el.volume - 0.25) < 1e-9, "50% of 0.5 expected 0.25, got " + el.volume);
    await env.send({ type: "SS_CONTENT_RESET" });
    assert(Math.abs(el.volume - 0.5) < 1e-9, "reset volume=" + el.volume);
  });

  await test("content: media added later is hooked when it plays (no DOM observer)", async () => {
    const env = makeContentEnv({ elements: [] });
    await env.send({ type: "SS_CONTENT_APPLY", settings: boost });
    const late = makeElement("VIDEO", { currentSrc: "blob:https://www.youtube.com/late" });
    env.elements.push(late);
    env.firePlay(late);
    assert(env.world.mediaSources.length === 1, "late element not hooked on play");
  });

  await test("content: tap injected but no rerouted context => no fake boost", async () => {
    const env = makeContentEnv({ elements: [] });
    const r = await env.send({ type: "SS_CONTENT_APPLY", settings: boost });
    // page tap announces readiness without having rerouted anything
    env.postFromPage({ source: "SoundSphereTap", type: "SS_TAP_READY", payload: { ok: true } });
    env.postFromPage({ source: "SoundSphereTap", type: "SS_TAP_APPLIED", payload: { contexts: 0 } });
    const st = await env.send({ type: "SS_CONTENT_STATUS" });
    assert(st.value && st.value.canBoost === false, "canBoost reported without any processed audio");
  });

  await test("content: protected playback clamps to 0-100, no EQ", async () => {
    const el = makeElement("VIDEO", { currentSrc: "blob:https://www.netflix.com/x", mediaKeys: {} , volume: 0.8 });
    const env = makeContentEnv({ origin: "https://www.netflix.com", elements: [el] });
    const r = await env.send({ type: "SS_CONTENT_APPLY", settings: { ...boost, volume: 400 } });
    assert(r.value && r.value.backend === "protected-basic" && !r.value.canBoost, JSON.stringify(r.value));
    assert(env.world.mediaSources.length === 0, "DRM element rerouted");
    assert(Math.abs(el.volume - 0.8) < 1e-9, "DRM volume changed to " + el.volume);
  });

  await test("offscreen: stop during pending start leaves no graph", async () => {
    const env = makeChromeEnv({ gumDelay: 80 });
    const p = env.send({ type: "SS_APPLY_SETTINGS", tabId: 1, settings: boost }, popupSender);
    await tick(40);
    // tab closes while getUserMedia is still pending
    env.chrome.tabs.onRemoved.fire(1, {});
    await p;
    await tick(150);
    assert(env.liveContexts().length === 0, "graph built for a stopped tab");
    assert(env.activeStreams.size === 0, "capture stream left running");
  });

  // ---------------- Firefox: off-DOM media (Spotify-style)
  // 1.3.3 wrapped page prototypes (play/createElement) via exportFunction and
  // pages stopped loading in Firefox. Page-load-time code must not patch the page.
  await test("firefox: content script leaves page prototypes untouched", async () => {
    for (const origin of ["https://www.youtube.com", "https://open.spotify.com", "https://artist.bandcamp.com"]) {
      const env = makeContentEnv({ firefox: true, origin, elements: [] });
      const page = env.sandbox.wrappedJSObject;
      await env.send({ type: "SS_CONTENT_APPLY", settings: boost, corsUnlock: true });
      assert(env.pageProto.play === env.nativePagePlay, origin + ": HTMLMediaElement.prototype.play replaced");
      assert(page.Document.prototype.createElement === env.nativePageCreate, origin + ": Document.prototype.createElement replaced");
    }
  });

  await test("firefox: page play() behaves natively", async () => {
    const env = makeContentEnv({ firefox: true, elements: [] });
    const el = makeElement("AUDIO", { isConnected: false, paused: true });
    const ret = env.pagePlay(el);
    assert(ret === "native-play" && el.paused === false, "native play not called / value lost");
  });

  // ---------------- Firefox: CORS unlock (Bandcamp-style)
  const bandcamp = () => makeElement("AUDIO", { src: "https://t4.bcbits.com/stream/a.mp3", currentSrc: "https://t4.bcbits.com/stream/a.mp3", currentTime: 42, paused: false });

  await test("cors: cross-origin media counts as boostable when unlock available", async () => {
    const el = bandcamp();
    const env = makeContentEnv({ firefox: true, origin: "https://artist.bandcamp.com", elements: [el] });
    const st = await env.send({ type: "SS_CONTENT_STATUS", corsUnlock: true });
    assert(st.value && st.value.canBoost, "slider would be capped at 100%");
    const noFlag = makeContentEnv({ origin: "https://artist.bandcamp.com", elements: [bandcamp()] });
    const st2 = await noFlag.send({ type: "SS_CONTENT_STATUS" });
    assert(st2.value && !st2.value.canBoost, "claims boost without unlock support");
  });

  await test("cors: volume cut / mute never reloads media", async () => {
    const el = bandcamp();
    const env = makeContentEnv({ firefox: true, origin: "https://artist.bandcamp.com", elements: [el] });
    const r = await env.send({ type: "SS_CONTENT_APPLY", settings: { ...boost, volume: 60 }, corsUnlock: true });
    assert(r.value && !r.value.corsUnlockNeeded, "asked to unlock for a plain volume cut");
    assert(el.crossOrigin === null, "element touched");
  });

  await test("cors: boost reloads in CORS mode, restores position, then hooks", async () => {
    const el = bandcamp();
    const env = makeContentEnv({ firefox: true, origin: "https://artist.bandcamp.com", elements: [el] });
    const r = await env.send({ type: "SS_CONTENT_APPLY", settings: boost, corsUnlock: true });
    assert(r.value && r.value.corsUnlockNeeded, "unlock not requested for boost");
    const p = env.send({ type: "SS_CONTENT_CORS_RELOAD", corsUnlock: true });
    await tick(5);
    assert(env.probes.length === 1 && env.probes[0].crossOrigin === "anonymous", "no CORS probe");
    assert(el.crossOrigin === null, "player touched before probe passed");
    env.probes[0]._fire("loadedmetadata");
    await tick(5);
    assert(el.crossOrigin === "anonymous", "crossOrigin not set");
    assert(env.world.mediaSources.length === 0, "hooked before CORS load finished");
    el.currentTime = 0; el.paused = true; // reload resets the element
    el._fire("loadedmetadata");
    const done = await p;
    assert(el.currentTime === 42 && el.plays >= 1, "position/play not restored");
    assert(env.world.mediaSources.length === 1, "not hooked after unlock");
    assert(done.value && done.value.backend === "media-element" && done.value.canBoost, JSON.stringify(done.value));
  });

  await test("cors: probe fails -> player never touched (no error event for the site)", async () => {
    const el = bandcamp();
    let siteSawError = false;
    el.addEventListener("error", () => { siteSawError = true; });
    const env = makeContentEnv({ firefox: true, origin: "https://artist.bandcamp.com", elements: [el] });
    await env.send({ type: "SS_CONTENT_APPLY", settings: boost, corsUnlock: true });
    const p = env.send({ type: "SS_CONTENT_CORS_RELOAD", corsUnlock: true });
    await tick(5);
    env.probes[0]._fire("error"); // CORS headers did not take effect
    const r = await p;
    assert(el.crossOrigin === null && el.loads === 0 && el.src.endsWith("a.mp3"), "player was modified");
    assert(!siteSawError, "site's player saw an error event");
    assert(env.world.mediaSources.length === 0, "hooked a non-CORS element");
    const again = await env.send({ type: "SS_CONTENT_APPLY", settings: boost, corsUnlock: true });
    assert(again.value && !again.value.corsUnlockNeeded, "retries unlock forever");
  });

  await test("cors: probe ok but player reload fails reverts to original playback", async () => {
    const el = bandcamp();
    const env = makeContentEnv({ firefox: true, origin: "https://artist.bandcamp.com", elements: [el] });
    await env.send({ type: "SS_CONTENT_APPLY", settings: boost, corsUnlock: true });
    const p = env.send({ type: "SS_CONTENT_CORS_RELOAD", corsUnlock: true });
    await tick(5);
    env.probes[0]._fire("loadedmetadata");
    await tick(5);
    el._fire("error");
    await tick(5);
    assert(el.crossOrigin === null, "crossorigin left set after failure");
    el._fire("loadedmetadata"); // original source loads again
    await p;
    assert(el.currentTime === 42 && el.plays >= 1, "playback not restored after revert");
    assert(env.world.mediaSources.length === 0, "hooked a non-CORS element");
    const again = await env.send({ type: "SS_CONTENT_APPLY", settings: boost, corsUnlock: true });
    assert(again.value && !again.value.corsUnlockNeeded, "retries unlock forever");
  });

  await test("firefox bg: boost on CORS-blocked tab installs tab-scoped media rule", async () => {
    const env = makeFirefoxBgEnv({
      content: m => m.type === "SS_CONTENT_APPLY"
        ? { ok: true, backend: "basic", canBoost: true, corsUnlockNeeded: true }
        : { ok: true, backend: "media-element", canBoost: true }
    });
    const r = await env.send({ type: "SS_APPLY_SETTINGS", tabId: 7, settings: boost });
    const add = env.ruleCalls.find(c => c.addRules);
    assert(add, "no session rule added");
    const rule = add.addRules[0];
    assert(rule.id === 7 && rule.condition.tabIds[0] === 7 && rule.condition.resourceTypes.join() === "media", JSON.stringify(rule));
    assert(rule.action.responseHeaders[0].header === "Access-Control-Allow-Origin", "wrong header");
    assert(env.tabMessages.some(m => m.message.type === "SS_CONTENT_CORS_RELOAD"), "content not told to reload");
    assert(r && r.mode === "media-element", "result=" + JSON.stringify(r));
    assert(!/not available in Firefox/.test(r.reason || ""), "noise reason: " + r.reason);
    env.onRemoved.fire(7, {});
    await tick(5);
    assert(env.ruleCalls.some(c => c.removeRuleIds && c.removeRuleIds[0] === 7 && !c.addRules), "rule not removed on tab close");
  });

  await test("firefox bg: no rule when content needs no unlock", async () => {
    const env = makeFirefoxBgEnv({ content: () => ({ ok: true, backend: "media-element", canBoost: true }) });
    await env.send({ type: "SS_APPLY_SETTINGS", tabId: 3, settings: boost });
    assert(!env.ruleCalls.some(c => c.addRules), "rule added without need");
  });

  // ---------------- Firefox MAIN-world hidden players (Spotify / SoundCloud)
  await test("main: play() unchanged; visible players left to the content script", async () => {
    const env = makeMainWorldEnv();
    const visible = env.el({ isConnected: true, currentSrc: "blob:https://soundcloud.com/x", volume: 0.5 });
    assert(env.play(visible) === "native-play" && visible.paused === false, "native play behaviour changed");
    env.settings({ ...boost, volume: 300 });
    assert(visible._out === 0.5 && env.world.mediaSources.length === 0, "visible element touched");
  });

  await test("main: nothing touched before SoundSphere is used", async () => {
    const env = makeMainWorldEnv();
    const el = env.el({ currentSrc: "blob:https://soundcloud.com/x", volume: 0.7 });
    env.play(el);
    assert(el._out === 0.7 && env.world.contexts.length === 0, "acted without settings");
  });

  await test("main: Spotify-style hidden DRM player gets volume + mute, never rerouted", async () => {
    const env = makeMainWorldEnv({ origin: "https://open.spotify.com" });
    const el = env.el({ tagName: "VIDEO", currentSrc: "blob:https://open.spotify.com/x", mediaKeys: {}, volume: 0.8 });
    env.play(el);
    env.settings({ ...boost, volume: 50 });
    assert(Math.abs(el._out - 0.4) < 1e-9, "output " + el._out);
    assert(Math.abs(el.volume - 0.8) < 1e-9, "page reads " + el.volume + " instead of its own 0.8");
    env.settings({ ...boost, volume: 400 });
    assert(Math.abs(el._out - 0.8) < 1e-9, "DRM player boosted above its own volume: " + el._out);
    assert(env.world.mediaSources.length === 0, "DRM player rerouted (would be silent)");
    env.settings({ ...boost, volume: 0, muted: true });
    assert(el.muted === true, "mute failed");
    const st = env.lastStatus();
    assert(st && st.payload.drm === true && st.payload.media === 1, JSON.stringify(st));
  });

  await test("main: player re-applying its own volume keeps SoundSphere's level (Spotify)", async () => {
    const env = makeMainWorldEnv({ origin: "https://open.spotify.com" });
    const el = env.el({ tagName: "VIDEO", currentSrc: "blob:https://open.spotify.com/x", mediaKeys: {}, volume: 0.8 });
    env.play(el);
    env.settings({ ...boost, volume: 50 });
    el.volume = 0.8; // Spotify re-asserts its stored volume
    assert(Math.abs(el._out - 0.4) < 1e-9, "page write undid SoundSphere: output " + el._out);
    el.volume = 0.6; // user moves Spotify's own slider
    assert(Math.abs(el._out - 0.3) < 1e-9 && Math.abs(el.volume - 0.6) < 1e-9, "own slider not combined: " + el._out);
    let threw = false;
    try { el.volume = 2; } catch (e) { threw = e instanceof RangeError || e.name === "RangeError"; }
    assert(threw, "out-of-range volume no longer throws like native");
    env.settings({ ...boost, volume: 100 });
    assert(Math.abs(el._out - 0.6) < 1e-9, "100% does not give back the page's volume: " + el._out);
  });

  await test("main: unmanaged players use the native volume path", async () => {
    const env = makeMainWorldEnv();
    const el = env.el({ isConnected: true, volume: 0.5 });
    env.settings({ ...boost, volume: 30 });
    el.volume = 0.9;
    assert(el._out === 0.9 && el.volume === 0.9, "visible player's volume altered");
  });

  await test("main: SoundCloud-style hidden readable player boosts via WebAudio", async () => {
    const env = makeMainWorldEnv();
    const el = env.el({ currentSrc: "blob:https://soundcloud.com/hls", volume: 0.6 });
    env.play(el);
    env.settings({ ...boost, volume: 80 });
    assert(env.world.mediaSources.length === 0 && Math.abs(el._out - 0.48) < 1e-9, "volume cut should stay on the element");
    env.settings({ ...boost, volume: 250 });
    assert(env.world.mediaSources.length === 1, "not rerouted for boost");
    assert(Math.abs(el._out - 0.6) < 1e-9, "player volume not restored after hook: " + el._out);
    const gain = env.world.contexts[0] && [...env.world.mediaSources[0].outputs][0];
    assert(gain && [...gain.outputs][0].gain.value === 2.5, "bus gain not 2.5");
    assert(env.lastStatus().payload.hooked === 1, "status not reporting hook");
  });

  await test("main: hidden cross-origin non-CORS player stays basic (no silent reroute)", async () => {
    const env = makeMainWorldEnv();
    const el = env.el({ currentSrc: "https://cf-media.sndcdn.com/a.mp3", volume: 1 });
    env.play(el);
    env.settings({ ...boost, volume: 300 });
    assert(env.world.mediaSources.length === 0, "rerouted unreadable audio");
  });

  await test("bridge: content status reflects hidden players", async () => {
    const spotify = makeContentEnv({ origin: "https://open.spotify.com", elements: [] });
    spotify.postFromPage({ source: "SoundSphereMain", type: "SS_MAIN_STATUS", payload: { media: 1, hooked: 0, readable: 0, drm: true } });
    let st = await spotify.send({ type: "SS_CONTENT_STATUS" });
    assert(st.responded && st.value.backend === "protected-basic" && !st.value.canBoost, "spotify " + JSON.stringify(st.value));
    const sc = makeContentEnv({ origin: "https://soundcloud.com", elements: [] });
    sc.postFromPage({ source: "SoundSphereMain", type: "SS_MAIN_STATUS", payload: { media: 1, hooked: 0, readable: 1, drm: false } });
    st = await sc.send({ type: "SS_CONTENT_STATUS" });
    assert(st.responded && st.value.canBoost, "soundcloud " + JSON.stringify(st.value));
    await sc.send({ type: "SS_CONTENT_APPLY", settings: { ...boost, volume: 300 } });
    assert(sc.posted.some(m => m.type === "SS_MAIN_SETTINGS" && m.payload.volume === 300), "settings not sent to page script");
    const yt = makeContentEnv({ elements: [] });
    await yt.send({ type: "SS_CONTENT_APPLY", settings: boost });
    assert(!yt.posted.some(m => m.type === "SS_MAIN_SETTINGS"), "page-script messages sent on unrelated site");
  });

  await test("manifest: page-world script only on Spotify/SoundCloud, Firefox only", async () => {
    const fs = require("fs");
    const ff = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.firefox.json"), "utf8"));
    const main = ff.content_scripts.filter(c => c.world === "MAIN");
    const allowed = ["*://open.spotify.com/*", "*://soundcloud.com/*", "*://*.soundcloud.com/*"];
    assert(main.length === 1 && main[0].matches.every(m => allowed.includes(m)), JSON.stringify(main));
    const cr = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
    assert(!(cr.content_scripts || []).some(c => c.world === "MAIN"), "MAIN world script in Chrome manifest");
  });

  // ---------------- popup
  await test("popup: remembered tab volume wins over 'start new tabs at 100%'", async () => {
    const p = makePopupEnv();
    const v = p.run(`prefs.rememberVolume = true; prefs.startAt100 = true; currentTabId = 5; tabVolumes = {"5": 150}; chooseInitialVolume()`);
    assert(v === 150, "got " + v);
  });

  await test("popup: opening at neutral does not start capture", async () => {
    const p = makePopupEnv();
    await p.run(`loadTab({ id: 3 })`);
    await tick(80);
    const applies = p.sent.filter(m => m.type === "SS_APPLY_SETTINGS").length;
    assert(applies === 0, `apply sent ${applies}x at neutral`);
  });

  await test("popup: non-neutral remembered volume still applies on open", async () => {
    const p = makePopupEnv({ local: { vol_tabs: { "3": 150 } } });
    await p.run(`(async () => { await loadPrefs(); await loadTab({ id: 3 }); })()`);
    await tick(80);
    const applies = p.sent.filter(m => m.type === "SS_APPLY_SETTINGS");
    assert(applies.length === 1 && applies[0].settings.volume === 150, "applies=" + JSON.stringify(applies));
  });

  // ---------------- tap
  await test("tap: page disconnect(destination) after reroute does not throw", async () => {
    const world = makeAudioWorld();
    const win = { AudioNode: world.AudioNode, addEventListener() {}, postMessage() {} };
    win.window = win;
    loadScript(path.join(DIR, "inject/webaudio_tap.js"), Object.assign(win, { console, Symbol, WeakMap, WeakSet, Set, Map, Math, Number, Array, Float32Array, Object }));
    const ctx = new world.AudioContext();
    const osc = ctx.createGain();
    osc.connect(ctx.destination);
    let threw = null;
    try { osc.disconnect(ctx.destination); } catch (e) { threw = e; }
    assert(!threw, "page got " + (threw && threw.name));
  });

  const w = Math.max(...results.map(r => r[0].length));
  for (const [n, s, m] of results) console.log(`${s === "PASS" ? "PASS" : "FAIL"}  ${n.padEnd(w)}  ${m}`);
  const failed = results.filter(r => r[1] !== "PASS").length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
