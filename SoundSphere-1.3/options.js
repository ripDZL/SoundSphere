"use strict";

const fields = {
  showBadge: document.getElementById("showBadge"),
  rememberVolume: document.getElementById("rememberVolume"),
  startAt100: document.getElementById("startAt100"),
  overdrive: document.getElementById("overdrive"),
  save: document.getElementById("save"),
  status: document.getElementById("status")
};

const defaults = {
  showBadge: true,
  rememberVolume: true,
  startAt100: false,
  overdrive: true
};

function storageGet(defaultValues) {
  return new Promise(resolve => chrome.storage.sync.get(defaultValues, resolve));
}

function storageSet(values) {
  return new Promise(resolve => chrome.storage.sync.set(values, resolve));
}

document.addEventListener("DOMContentLoaded", async () => {
  const prefs = await storageGet(defaults);
  fields.showBadge.checked = prefs.showBadge !== false;
  fields.rememberVolume.checked = prefs.rememberVolume !== false;
  fields.startAt100.checked = !!prefs.startAt100;
  fields.overdrive.checked = prefs.overdrive !== false;
});

fields.save.addEventListener("click", async () => {
  await storageSet({
    showBadge: fields.showBadge.checked,
    rememberVolume: fields.rememberVolume.checked,
    startAt100: fields.startAt100.checked,
    overdrive: fields.overdrive.checked
  });

  fields.status.textContent = "Saved";
  setTimeout(() => {
    fields.status.textContent = "";
  }, 1800);
});
