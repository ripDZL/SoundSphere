"use strict";

/*
  SoundSphere 1.3 Firefox background coordinator.

  Firefox does not expose Chrome's tabCapture/offscreen audio path, so the
  add-on coordinates popup requests with the content-script audio processor.
*/

const ACTION = chrome.action || chrome.browserAction;
// Promise-based namespace for APIs used with await (declarativeNetRequest).
const API = typeof browser !== "undefined" ? browser : chrome;

let showBadge = true;

// Per-tab task queue: rapid slider moves must not race each other (e.g. two
// CORS unlocks reloading the same element).
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

// --- CORS unlock -------------------------------------------------------------
// Cross-origin media served without CORS headers (e.g. Bandcamp's CDN) plays
// fine but reads as silence in WebAudio, so boost/EQ cannot apply. When the
// user boosts such a tab, a session rule adds Access-Control-Allow-Origin to
// that tab's media responses only, and the content script reloads the element
// in CORS mode. Rule id = tab id; removed when the tab closes; session rules
// never outlive the browser session.
const CORS_RELOAD_TIMEOUT_MS = 8000;

function canUnlockCors() {
  return Boolean(API.declarativeNetRequest && typeof API.declarativeNetRequest.updateSessionRules === "function");
}

function ensureCorsRule(tabId) {
  return API.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [{
      id: tabId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        responseHeaders: [{ header: "Access-Control-Allow-Origin", operation: "set", value: "*" }]
      },
      condition: { tabIds: [tabId], resourceTypes: ["media"] }
    }]
  });
}

function removeCorsRule(tabId) {
  if (!canUnlockCors()) return Promise.resolve();
  return API.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
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

const TAB_MESSAGE_TIMEOUT_MS = 2000;

// Bounded so a page that never answers can't leave the popup waiting.
function sendTabMessage(tabId, message, timeoutMs = TAB_MESSAGE_TIMEOUT_MS) {
  const reply = withCallback(chrome.tabs.sendMessage, chrome.tabs, tabId, message)
    .catch(error => ({ ok: false, error: error.message || String(error) }));
  const timeout = new Promise(resolve => {
    setTimeout(() => resolve({ ok: false, error: "Page did not respond" }), timeoutMs);
  });
  return Promise.race([reply, timeout]);
}

// Control messages must come from SoundSphere's own pages (popup/options),
// never from a content script running inside a web page.
function isExtensionPageSender(sender) {
  const base = chrome.runtime.getURL("");
  return Boolean(sender && sender.url && sender.url.startsWith(base));
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

function toPopupResult(response) {
  if (!response || response.ok === false) {
    return {
      ok: false,
      mode: "unsupported",
      canBoost: false,
      advanced: false,
      reason: (response && response.error) || "No content-script audio processor on this page"
    };
  }
  return {
    ok: true,
    mode: response.backend || "basic",
    canBoost: !!response.canBoost,
    advanced: !!response.canBoost,
    engaged: !!response.engaged,
    reason: response.reason || ""
  };
}

async function applySettingsNow(tabId, settings) {
  const corsUnlock = canUnlockCors();
  let response = await sendTabMessage(tabId, { type: "SS_CONTENT_APPLY", settings, corsUnlock });

  if (corsUnlock && response && response.corsUnlockNeeded) {
    try {
      await ensureCorsRule(tabId);
      console.info("[SoundSphere] CORS header rule active for tab", tabId);
      const unlocked = await sendTabMessage(
        tabId,
        { type: "SS_CONTENT_CORS_RELOAD", corsUnlock },
        CORS_RELOAD_TIMEOUT_MS
      );
      if (unlocked && unlocked.ok !== false) response = unlocked;
    } catch (error) {
      console.info("[SoundSphere] CORS unlock failed:", error && error.message);
    }
  }
  return toPopupResult(response);
}

function applySettings(tabId, settings) {
  if (!tabId) {
    return Promise.resolve({ ok: false, mode: "unsupported", canBoost: false, reason: "No active tab" });
  }
  return runForTab(tabId, () => applySettingsNow(tabId, settings));
}

async function getStatus(tabId) {
  if (!tabId) {
    return { ok: false, mode: "unsupported", canBoost: false, reason: "No active tab" };
  }

  const content = await sendTabMessage(tabId, { type: "SS_CONTENT_STATUS", corsUnlock: canUnlockCors() });
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
    await sendTabMessage(tabId, { type: "SS_CONTENT_RESET" });
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
  removeCorsRule(tabId);
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
