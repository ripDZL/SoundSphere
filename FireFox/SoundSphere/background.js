let audibleTabs = 0;
let showBadge = true;

function applyBadge() {
  if (!showBadge) {
    browser.action.setBadgeText({ text: "" });
    return;
  }

  const text = audibleTabs > 0 ? String(audibleTabs) : "";
  browser.action.setBadgeText({ text });
  browser.action.setBadgeBackgroundColor({ color: "#00ff9d" });
}

function updateAudibleTabs() {
  browser.tabs
    .query({ audible: true })
    .then(tabs => {
      audibleTabs = tabs.length;
      applyBadge();
    })
    .catch(console.error);
}

function loadBadgeSetting() {
  browser.storage.sync
    .get({ showBadge: true })
    .then(data => {
      showBadge = !!data.showBadge;
      applyBadge();
    })
    .catch(console.error);
}

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if ("audible" in changeInfo) {
    updateAudibleTabs();
  }
});

browser.tabs.onRemoved.addListener(() => {
  updateAudibleTabs();
});

browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if (changes.showBadge) {
    showBadge = !!changes.showBadge.newValue;
    applyBadge();
  }
});

loadBadgeSetting();
updateAudibleTabs();
