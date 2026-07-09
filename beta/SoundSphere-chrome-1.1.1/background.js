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

// Tab-capture orchestration. The popup asks us to capture the active tab; we
// obtain a media-stream id and hand it to the offscreen document, which does
// the actual capture and audio processing. Only one offscreen doc may exist.

function ssLog(...args) {
  console.log("[SS bg]", ...args);
}

ssLog("service worker started");

// Serialize offscreen creation and tolerate the "already exists" race.
let offscreenCreating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }
  if (!offscreenCreating) {
    ssLog("offscreen: creating document");
    offscreenCreating = chrome.offscreen
      .createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "Boost and adjust the volume of captured tab audio."
      })
      .then(() => ssLog("offscreen: document created"))
      .catch(e => {
        // A concurrent createDocument may have already made it.
        if (String((e && e.message) || e).includes("single offscreen")) {
          ssLog("offscreen: already created by a concurrent call");
          return;
        }
        throw e;
      })
      .finally(() => { offscreenCreating = null; });
  }
  return offscreenCreating;
}

// Send to the offscreen doc, retrying once if it isn't listening yet
// (covers the createDocument-resolved-but-listener-not-ready race).
async function sendToOffscreen(message, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      ssLog("offscreen send failed (attempt " + attempt + "):", e && e.message);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, 200));
        await ensureOffscreen();
      } else {
        throw e;
      }
    }
  }
}

async function startCaptureForTab(tabId, volume, mode, gains) {
  ssLog("startCapture requested: tab", tabId, "vol", volume, "mode", mode);
  await ensureOffscreen();

  let streamId;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      break;
    } catch (e) {
      lastErr = e;
      ssLog("getMediaStreamId attempt " + attempt + " failed:", e && e.message);
      await new Promise(r => setTimeout(r, 200));
    }
  }
  if (!streamId) {
    ssLog("getMediaStreamId FAILED after retries:", lastErr && lastErr.message);
    throw lastErr || new Error("getMediaStreamId failed");
  }
  ssLog("getMediaStreamId ok for tab", tabId);

  activeCaptureTabId = tabId;
  const resp = await sendToOffscreen({
    target: "offscreen",
    type: "start",
    streamId,
    tabId,
    volume,
    mode,
    gains
  });
  if (!resp || !resp.ok) {
    activeCaptureTabId = null;
    throw new Error((resp && resp.error) || "offscreen reported start failure");
  }
  ssLog("startCapture SUCCESS: tab", tabId);
  return resp;
}

function stopCapture() {
  if (activeCaptureTabId === null) return;
  ssLog("stopCapture: releasing tab", activeCaptureTabId);
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
    chrome.runtime.sendMessage({ target: "offscreen", type: "volume", volume: msg.volume })
      .then(resp => sendResponse(resp || { ok: true }))
      .catch(() => sendResponse({ ok: false, needsStart: true }));
    return true; // async
  }

  if (msg.type === "ss-set-mode") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "mode", mode: msg.mode })
      .then(resp => sendResponse(resp || { ok: true }))
      .catch(() => sendResponse({ ok: false, needsStart: true }));
    return true; // async
  }

  if (msg.type === "ss-set-eq") {
    chrome.runtime.sendMessage({ target: "offscreen", type: "eq", gains: msg.gains })
      .then(resp => sendResponse(resp || { ok: true }))
      .catch(() => sendResponse({ ok: false, needsStart: true }));
    return true; // async
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
// Release the capture only when the captured tab is actually CLOSED. We do NOT
// stop on tab "loading" — YouTube fires that during normal use, which tore down
// a live capture and left controls dead. Reload/nav is handled by the capture
// track's "ended" event in the offscreen doc, which lets the next control re-hook.
chrome.tabs.onRemoved.addListener(tabId => {
  if (tabId === activeCaptureTabId) stopCapture();
});

loadBadgePreference();
refreshAudibleTabs();
