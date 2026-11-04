"use strict";

/*
  SoundSphere 1.3 background coordinator.

  Chrome path:
    popup -> service worker -> tabCapture stream id -> offscreen WebAudio engine

  Firefox / fallback path:
    popup -> background/event page -> content script media-element processor

  The service worker is intentionally stateless for live audio. Chrome may stop
  it after idle time, so the offscreen document owns active streams and nodes.
*/

const ACTION = chrome.action || chrome.browserAction;
const OFFSCREEN_PATH = "offscreen.html";
const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PATH);

let showBadge = true;
let creatingOffscreen = null;
let closingOffscreen = null;
let idleCloseTimer = null;

// Close the offscreen document this long after the last capture ends, so an
// idle browser holds no hidden audio renderer.
const OFFSCREEN_IDLE_CLOSE_MS = 15000;

// Per-tab task queue. The popup can fire several applies while the first
// capture is still starting (getUserMedia takes ~50-300 ms). Without ordering,
// each one saw "no capture yet" and requested its own stream, which built
// duplicate graphs (double audio) or failed into the content fallback.
const tabQueues = new Map();

function runForTab(tabId, task) {
  const key = String(tabId);
  const previous = tabQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(task);
  tabQueues.set(key, next);
  next.finally(() => {
    if (tabQueues.get(key) === next) tabQueues.delete(key);
  }).catch(() => {});
  return next;
}

// Control messages must come from SoundSphere's own pages (popup/options),
// never from a content script running inside a web page.
function isExtensionPageSender(sender) {
  const base = chrome.runtime.getURL("");
  return Boolean(sender && sender.url && sender.url.startsWith(base));
}

function runtimeLastError() {
  const err = chrome.runtime && chrome.runtime.lastError;
  return err && err.message ? new Error(err.message) : null;
}

function withCallback(fn, thisArg, ...args) {
  return new Promise((resolve, reject) => {
    try {
      fn.call(thisArg, ...args, result => {
        const err = runtimeLastError();
        if (err) reject(err);
        else resolve(result);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function tabsQuery(queryInfo) {
  return withCallback(chrome.tabs.query, chrome.tabs, queryInfo).catch(() => []);
}

function tabsGet(tabId) {
  return withCallback(chrome.tabs.get, chrome.tabs, tabId).catch(() => null);
}

const TAB_MESSAGE_TIMEOUT_MS = 2000;

// Bounded so a page that never answers can't stall the per-tab queue.
function sendTabMessage(tabId, message) {
  const reply = withCallback(chrome.tabs.sendMessage, chrome.tabs, tabId, message)
    .catch(error => ({ ok: false, error: error.message || String(error) }));
  const timeout = new Promise(resolve => {
    setTimeout(() => resolve({ ok: false, error: "Page did not respond" }), TAB_MESSAGE_TIMEOUT_MS);
  });
  return Promise.race([reply, timeout]);
}

function runtimeSendMessage(message) {
  return withCallback(chrome.runtime.sendMessage, chrome.runtime, message);
}

function storageGet(defaults) {
  return withCallback(chrome.storage.sync.get, chrome.storage.sync, defaults)
    .catch(() => ({ ...defaults }));
}

function storageRemove(keys) {
  return withCallback(chrome.storage.sync.remove, chrome.storage.sync, keys).catch(() => {});
}

function storageLocalGet(defaults) {
  return withCallback(chrome.storage.local.get, chrome.storage.local, defaults)
    .catch(() => ({ ...defaults }));
}

function storageLocalSet(values) {
  return withCallback(chrome.storage.local.set, chrome.storage.local, values).catch(() => {});
}

function canUseChromeTabCapture() {
  return Boolean(
    chrome.tabCapture &&
    typeof chrome.tabCapture.getMediaStreamId === "function" &&
    chrome.offscreen &&
    typeof chrome.offscreen.createDocument === "function"
  );
}

function isRestrictedUrl(url) {
  if (!url) return true;
  return /^(chrome|edge|brave|vivaldi|opera|about|devtools|chrome-extension|moz-extension):/i.test(url);
}

async function hasOffscreenDocument() {
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [OFFSCREEN_URL]
    });
    return contexts.length > 0;
  }

  if (chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }

  if (typeof clients !== "undefined" && clients.matchAll) {
    const matched = await clients.matchAll();
    return matched.some(client => client.url === OFFSCREEN_URL);
  }

  return false;
}

async function ensureOffscreenDocument() {
  if (!canUseChromeTabCapture()) {
    throw new Error("tabCapture/offscreen is unavailable in this browser");
  }

  clearTimeout(idleCloseTimer);
  if (closingOffscreen) await closingOffscreen;
  if (await hasOffscreenDocument()) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_PATH,
      reasons: ["USER_MEDIA"],
      justification: "Process captured tab audio for SoundSphere volume and EQ controls."
    }).catch(error => {
      const message = error && error.message ? error.message : String(error);
      if (!/single offscreen|Only a single offscreen/i.test(message)) {
        throw error;
      }
    }).finally(() => {
      creatingOffscreen = null;
    });
  }

  await creatingOffscreen;
}

async function sendToOffscreen(message, retries = 2) {
  await ensureOffscreenDocument();

  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await runtimeSendMessage({ ...message, target: "offscreen" });
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 100 + attempt * 150));
      await ensureOffscreenDocument();
    }
  }

  throw lastError || new Error("Offscreen document did not respond");
}

// Query/stop helpers must not spin up an offscreen document just to learn that
// nothing is playing (e.g. on every tab close).
async function sendToOffscreenIfPresent(message) {
  if (!canUseChromeTabCapture()) return null;
  if (closingOffscreen) return null;
  if (!(await hasOffscreenDocument())) return null;
  try {
    return await runtimeSendMessage({ ...message, target: "offscreen" });
  } catch {
    return null;
  }
}

function scheduleOffscreenIdleClose() {
  clearTimeout(idleCloseTimer);
  idleCloseTimer = setTimeout(closeOffscreenIfIdle, OFFSCREEN_IDLE_CLOSE_MS);
}

async function closeOffscreenIfIdle() {
  if (tabQueues.size > 0 || creatingOffscreen || closingOffscreen) return;
  if (!chrome.offscreen || typeof chrome.offscreen.closeDocument !== "function") return;

  const info = await sendToOffscreenIfPresent({ type: "SS_OFFSCREEN_COUNT" });
  if (!info || !info.ok || info.count !== 0) return;
  if (tabQueues.size > 0 || creatingOffscreen) return;

  closingOffscreen = chrome.offscreen.closeDocument()
    .catch(() => {})
    .finally(() => { closingOffscreen = null; });
  await closingOffscreen;
}

async function getMediaStreamId(tabId) {
  if (!chrome.tabCapture || typeof chrome.tabCapture.getMediaStreamId !== "function") {
    throw new Error("tabCapture is unavailable");
  }

  const result = chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  if (result && typeof result.then === "function") return result;

  // Old callback-shaped Chromium builds.
  return withCallback(chrome.tabCapture.getMediaStreamId, chrome.tabCapture, { targetTabId: tabId });
}

async function startOrUpdateChromeCapture(tabId, settings) {
  const tab = await tabsGet(tabId);
  if (!tab || isRestrictedUrl(tab.url)) {
    throw new Error("This browser page cannot be captured");
  }

  const existing = await sendToOffscreen({ type: "SS_OFFSCREEN_STATUS", tabId }).catch(() => null);
  if (existing && existing.ok && existing.active) {
    return sendToOffscreen({ type: "SS_OFFSCREEN_APPLY", tabId, settings });
  }

  const streamId = await getMediaStreamId(tabId);
  if (!streamId) throw new Error("Chrome did not grant a tab audio stream");

  const started = await sendToOffscreen({
    type: "SS_OFFSCREEN_START",
    tabId,
    streamId,
    settings
  });

  // If this tab was previously handled by the content fallback, neutralize it
  // now that whole-tab capture owns the audio; otherwise boost/EQ stack twice.
  if (started && started.ok) {
    await sendTabMessage(tabId, { type: "SS_CONTENT_RESET" });
  }
  return started;
}

async function applyContentFallback(tabId, settings, reason) {
  const response = await sendTabMessage(tabId, {
    type: "SS_CONTENT_APPLY",
    settings,
    reason: reason || ""
  });

  if (!response || response.ok === false) {
    return {
      ok: false,
      mode: "unsupported",
      canBoost: false,
      advanced: false,
      reason: reason || (response && response.error) || "No content-script audio processor on this page"
    };
  }

  return {
    ok: true,
    mode: response.backend || "basic",
    canBoost: !!response.canBoost,
    advanced: !!response.canBoost,
    reason: reason || response.reason || ""
  };
}

function applySettings(tabId, settings) {
  if (!tabId) {
    return Promise.resolve({ ok: false, mode: "unsupported", canBoost: false, reason: "No active tab" });
  }
  return runForTab(tabId, () => applySettingsNow(tabId, settings));
}

async function applySettingsNow(tabId, settings) {
  if (canUseChromeTabCapture()) {
    try {
      const response = await startOrUpdateChromeCapture(tabId, settings);
      if (response && response.ok) {
        return { ok: true, mode: "whole-tab", canBoost: true, advanced: true };
      }
      throw new Error((response && response.error) || "Offscreen audio engine failed");
    } catch (error) {
      const reason = error && error.message ? error.message : String(error);
      return applyContentFallback(tabId, settings, reason);
    }
  }

  return applyContentFallback(tabId, settings, "Whole-tab capture is not available in this browser");
}

async function getStatus(tabId) {
  if (!tabId) {
    return { ok: false, mode: "unsupported", canBoost: false, reason: "No active tab" };
  }

  if (canUseChromeTabCapture()) {
    const tab = await tabsGet(tabId);
    if (!tab || isRestrictedUrl(tab.url)) {
      return {
        ok: false,
        mode: "unsupported",
        canBoost: false,
        advanced: false,
        captureActive: false,
        engaged: false,
        reason: "Browser pages cannot be controlled"
      };
    }

    const offscreen = await sendToOffscreenIfPresent({ type: "SS_OFFSCREEN_STATUS", tabId });
    const captureActive = !!(offscreen && offscreen.active);
    const content = captureActive ? null : await sendTabMessage(tabId, { type: "SS_CONTENT_STATUS" });
    const fallbackEngaged = !!(content && content.ok !== false && content.engaged);
    return {
      ok: true,
      mode: captureActive ? "whole-tab" : (fallbackEngaged ? (content.backend || "basic") : "ready"),
      canBoost: fallbackEngaged ? !!content.canBoost : true,
      advanced: fallbackEngaged ? !!content.canBoost : true,
      captureActive,
      engaged: captureActive || fallbackEngaged,
      reason: fallbackEngaged ? (content.reason || "") : ""
    };
  }

  const content = await sendTabMessage(tabId, { type: "SS_CONTENT_STATUS" });
  if (content && content.ok !== false) {
    return {
      ok: true,
      mode: content.backend || "basic",
      canBoost: !!content.canBoost,
      advanced: !!content.canBoost,
      captureActive: false,
      engaged: !!content.engaged,
      reason: content.reason || ""
    };
  }

  return {
    ok: false,
    mode: "unsupported",
    canBoost: false,
    advanced: false,
    captureActive: false,
    reason: content && content.error ? content.error : "Cannot control this page"
  };
}

function stopTab(tabId) {
  return runForTab(tabId, async () => {
    await sendToOffscreenIfPresent({ type: "SS_OFFSCREEN_STOP", tabId });
    await sendTabMessage(tabId, { type: "SS_CONTENT_RESET" });
    scheduleOffscreenIdleClose();
    return { ok: true };
  });
}

async function refreshBadge() {
  if (!ACTION) return;
  if (!showBadge) {
    ACTION.setBadgeText({ text: "" });
    return;
  }

  const tabs = await tabsQuery({ audible: true });
  const text = tabs.length > 0 ? String(tabs.length) : "";
  ACTION.setBadgeBackgroundColor({ color: "#00d084" });
  ACTION.setBadgeText({ text });
}

async function loadBadgePreference() {
  const data = await storageGet({ showBadge: true });
  showBadge = data.showBadge !== false;
  refreshBadge();
}

async function purgeLegacyTabVolumeKeys() {
  const all = await storageGet(null);
  const stale = Object.keys(all || {}).filter(key => key.startsWith("vol_tab_"));
  if (stale.length) await storageRemove(stale);
}

async function cleanupStoredTabVolume(tabId) {
  const data = await storageLocalGet({ vol_tabs: {} });
  const volumes = data.vol_tabs && typeof data.vol_tabs === "object" ? data.vol_tabs : {};
  const key = String(tabId);
  if (!(key in volumes)) return;
  delete volumes[key];
  await storageLocalSet({ vol_tabs: volumes });
}

// Tab ids are only unique within one browser session and restart after a
// relaunch, so remembered per-tab volumes from a previous session would land
// on unrelated new tabs. Clear them whenever the browser starts.
function clearSessionTabVolumes() {
  return storageLocalSet({ vol_tabs: {} });
}

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === "install" || details.reason === "update") {
    purgeLegacyTabVolumeKeys();
  }
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => clearSessionTabVolumes());
}

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if ("audible" in changeInfo) refreshBadge();
});

chrome.tabs.onActivated.addListener(() => refreshBadge());

chrome.tabs.onRemoved.addListener(tabId => {
  refreshBadge();
  cleanupStoredTabVolume(tabId);
  runForTab(tabId, async () => {
    const stopped = await sendToOffscreenIfPresent({ type: "SS_OFFSCREEN_STOP", tabId });
    if (stopped) scheduleOffscreenIdleClose();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.showBadge) {
    showBadge = changes.showBadge.newValue !== false;
    refreshBadge();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return undefined;
  if (message.target === "offscreen") return undefined;
  if (!isExtensionPageSender(sender)) return undefined;

  if (message.type === "SS_GET_STATUS") {
    getStatus(message.tabId).then(sendResponse);
    return true;
  }

  if (message.type === "SS_APPLY_SETTINGS") {
    applySettings(message.tabId, message.settings || {}).then(sendResponse);
    return true;
  }

  if (message.type === "SS_STOP_TAB") {
    stopTab(message.tabId).then(sendResponse);
    return true;
  }

  if (message.type === "SS_REFRESH_BADGE") {
    refreshBadge().then(() => sendResponse({ ok: true }));
    return true;
  }

  return undefined;
});

loadBadgePreference();
refreshBadge();
