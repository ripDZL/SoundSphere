// SoundSphere background.js — Chrome MV3 version

let audioTabsCount = 0;
let showBadge = true;

function applyBadge() {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  const text = showBadge && audioTabsCount > 0 ? String(audioTabsCount) : '';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#00ff9d' });
}

function refreshCount() {
  if (!chrome.tabs || !chrome.tabs.query) return;
  chrome.tabs.query({ audible: true }, (tabs) => {
    audioTabsCount = (tabs || []).length;
    applyBadge();
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (typeof changeInfo.audible !== 'undefined') {
    refreshCount();
  }
});

chrome.tabs.onRemoved.addListener(() => {
  refreshCount();
});

// load initial preference + count
chrome.storage.sync.get({ showBadge: true }, (data) => {
  showBadge = !!data.showBadge;
  refreshCount();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes.showBadge) return;
  showBadge = !!changes.showBadge.newValue;
  applyBadge();
});
