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
