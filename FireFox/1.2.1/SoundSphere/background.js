/*
  SoundSphere — background script (Firefox MV2)

  Responsibilities:
  - Keeps the toolbar badge in sync with "audible" tabs (simple activity indicator).
  - Stores a small set of global preferences used by the popup/options UI.

  Policy notes:
  - No network interception.
  - No remote code loading.
*/

(() => {
  const actionApi = chrome.action || chrome.browserAction;

  const DEFAULTS = {
    showBadge: true
  };

  let prefs = { ...DEFAULTS };

  function setBadgeText(text) {
    try {
      actionApi.setBadgeText({ text });
    } catch {
      // Ignore – badge isn't critical.
    }
  }

  function setBadgeColor() {
    try {
      actionApi.setBadgeBackgroundColor({ color: "#22c55e" });
    } catch {}
  }

  function loadPrefs() {
    chrome.storage.sync.get(DEFAULTS, data => {
      prefs = { ...DEFAULTS, ...(data || {}) };
      refreshBadge();
    });
  }

  function countAudibleTabs(done) {
    try {
      chrome.tabs.query({ audible: true }, tabs => done((tabs || []).length));
    } catch {
      done(0);
    }
  }

  function refreshBadge() {
    if (!prefs.showBadge) {
      setBadgeText("");
      return;
    }

    countAudibleTabs(count => {
      setBadgeColor();
      setBadgeText(count > 0 ? String(count) : "");
    });
  }

  // Refresh on typical tab events. This is cheap and avoids timers.
  try {
    chrome.tabs.onUpdated.addListener(() => refreshBadge());
    chrome.tabs.onActivated.addListener(() => refreshBadge());
    chrome.tabs.onRemoved.addListener(() => refreshBadge());
    chrome.tabs.onReplaced?.addListener?.(() => refreshBadge());
  } catch {}

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes.showBadge) prefs.showBadge = !!changes.showBadge.newValue;
    refreshBadge();
  });

  loadPrefs();
})();

// One-time cleanup: older builds wrote per-tab `vol_tab_<id>` keys and never
// removed them, which could exhaust storage.sync's 512-item quota.
function purgeLegacyTabVolumeKeys() {
  chrome.storage.sync.get(null, all => {
    if (chrome.runtime.lastError || !all) return;
    const stale = Object.keys(all).filter(k => k.startsWith("vol_tab_"));
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
