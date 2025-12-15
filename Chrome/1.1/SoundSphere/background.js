// SoundSphere background script
// Manages badge state and audible tab count.

let audibleTabs = 0;
let showBadge = true;

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

loadBadgePreference();
refreshAudibleTabs();
