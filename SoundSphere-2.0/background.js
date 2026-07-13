"use strict";

/*
  SoundSphere 2.0 background coordinator.

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

function sendTabMessage(tabId, message) {
  return withCallback(chrome.tabs.sendMessage, chrome.tabs, tabId, message)
    .catch(error => ({ ok: false, error: error.message || String(error) }));
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

  return sendToOffscreen({
    type: "SS_OFFSCREEN_START",
    tabId,
    streamId,
    settings
  });
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

async function applySettings(tabId, settings) {
  if (!tabId) {
    return { ok: false, mode: "unsupported", canBoost: false, reason: "No active tab" };
  }

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
    const offscreen = (await hasOffscreenDocument())
      ? await sendToOffscreen({ type: "SS_OFFSCREEN_STATUS", tabId }).catch(() => null)
      : null;
    return {
      ok: true,
      mode: offscreen && offscreen.active ? "whole-tab" : "ready",
      canBoost: true,
      advanced: true,
      captureActive: !!(offscreen && offscreen.active),
      reason: ""
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

async function stopTab(tabId) {
  if (canUseChromeTabCapture()) {
    await sendToOffscreen({ type: "SS_OFFSCREEN_STOP", tabId }).catch(() => {});
  }
  await sendTabMessage(tabId, { type: "SS_CONTENT_RESET" }).catch(() => {});
  return { ok: true };
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

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === "install" || details.reason === "update") {
    purgeLegacyTabVolumeKeys();
  }
});

chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if ("audible" in changeInfo) refreshBadge();
});

chrome.tabs.onActivated.addListener(() => refreshBadge());

chrome.tabs.onRemoved.addListener(tabId => {
  refreshBadge();
  cleanupStoredTabVolume(tabId);
  if (canUseChromeTabCapture()) {
    sendToOffscreen({ type: "SS_OFFSCREEN_STOP", tabId }).catch(() => {});
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.showBadge) {
    showBadge = changes.showBadge.newValue !== false;
    refreshBadge();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return undefined;

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
