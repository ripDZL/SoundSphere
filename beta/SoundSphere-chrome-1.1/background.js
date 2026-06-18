// SoundSphere background script
// Manages badge state and audible tab count.

let audibleTabs = 0;
let showBadge = true;
let activeCaptureTabId = null; // tab currently captured by the offscreen engine

function updateBadge() {
  if (!showBadge) {
    chrome.action.setBadgeText({ text: "" });
    return;
  }

  const text = audibleTabs > 0 ? String(audibleTabs) : "";
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#00ff9d" });
}

function refreshAudibleTabs() {
  chrome.tabs.query({ audible: true }, tabs => {
    audibleTabs = tabs ? tabs.length : 0;
    updateBadge();
  });
}

function loadBadgePreference() {
  chrome.storage.sync.get({ showBadge: true }, data => {
    showBadge = !!data.showBadge;
    updateBadge();
  });
}

// One-time cleanup: older builds wrote a `vol_tab_<id>` key per tab and never
// removed them, which could exhaust chrome.storage.sync's 512-item quota and
// make all settings writes fail silently. We drop those orphaned keys here.
function purgeLegacyTabVolumeKeys() {
  chrome.storage.sync.get(null, all => {
    if (chrome.runtime.lastError || !all) return;
    const stale = Object.keys(all).filter(key => key.startsWith("vol_tab_"));
    if (stale.length) {
      chrome.storage.sync.remove(stale, () => void chrome.runtime.lastError);
    }
  });
}

chrome.runtime.onInstalled.addListener(details => {
  if (details.reason === "install" || details.reason === "update") {
    purgeLegacyTabVolumeKeys();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if ("audible" in changeInfo) {
    refreshAudibleTabs();
  }
});

// Tabs come and go; when one closes we recompute the audible total.
chrome.tabs.onRemoved.addListener(() => {
  refreshAudibleTabs();
});

// Keep the badge in sync if the setting changes from another popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.showBadge) {
    showBadge = !!changes.showBadge.newValue;
    updateBadge();
  }
});

// ---------------------------------------------------------------------------
// Path B: offscreen tabCapture engine orchestration.
// The popup asks the background to capture the active tab; the background gets
// a media-stream id and hands it to the offscreen document, which does the
// actual audio capture + gain. Only one offscreen document may exist.
// ---------------------------------------------------------------------------

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Boost and adjust the volume of captured tab audio."
  });
}

async function startCaptureForTab(tabId, volume, mode, gains) {
  await ensureOffscreen();
  // getMediaStreamId requires that the extension was invoked on the tab
  // (opening the popup counts), and works without broad host permissions.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  activeCaptureTabId = tabId;
  return chrome.runtime.sendMessage({
    target: "offscreen",
    type: "start",
    streamId,
    tabId,
    volume,
    mode,
    gains
  });
}

function stopCapture() {
  if (activeCaptureTabId === null) return;
  activeCaptureTabId = null;
  // No receiver (offscreen already gone) is fine — swallow the rejection.
  chrome.runtime.sendMessage({ target: "offscreen", type: "stop" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === "ss-start-capture") {
    startCaptureForTab(msg.tabId, msg.volume, msg.mode, msg.gains)
      .then(() => sendResponse({ ok: true }))
      .catch(e => {
        console.warn("[SoundSphere] startCapture failed:", e && e.message);
        sendResponse({ ok: false, error: String(e && e.message || e) });
      });
    return true; // async
  }

  if (msg.type === "ss-set-volume") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "volume", volume: msg.volume });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "ss-set-mode") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "mode", mode: msg.mode });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "ss-set-eq") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "eq", gains: msg.gains });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "ss-stop-capture") {
    stopCapture();
    sendResponse({ ok: true });
    return;
  }
});

// Lifecycle: release the capture when the captured tab goes away or reloads /
// cross-navigates, so we never hold a dead capture. (SPA navigations within a
// tab don't fire "loading", so in-page YouTube nav keeps the boost.)
chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === activeCaptureTabId) stopCapture();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (tabId === activeCaptureTabId && changeInfo.status === "loading") {
    stopCapture();
  }
});

loadBadgePreference();
refreshAudibleTabs();
