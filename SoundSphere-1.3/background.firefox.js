"use strict";

/*
  SoundSphere 1.3 Firefox background coordinator.

  Firefox does not expose Chrome's tabCapture/offscreen audio path, so the
  add-on coordinates popup requests with the content-script audio processor.
*/

const ACTION = chrome.action || chrome.browserAction;

let showBadge = true;

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

function sendTabMessage(tabId, message) {
  return withCallback(chrome.tabs.sendMessage, chrome.tabs, tabId, message)
    .catch(error => ({ ok: false, error: error.message || String(error) }));
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

  return applyContentFallback(tabId, settings, "Whole-tab capture is not available in Firefox");
}

async function getStatus(tabId) {
  if (!tabId) {
    return { ok: false, mode: "unsupported", canBoost: false, reason: "No active tab" };
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
