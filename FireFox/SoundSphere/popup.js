let activeTabId = null;
let currentMode = "default";

const slider = document.getElementById("volumeSlider");
const display = document.querySelector(".volume-display");
const warningEl = document.getElementById("volumeWarning");
const muteBtn = document.getElementById("muteBtn");
const resetBtn = document.getElementById("resetBtn");
const defaultBtn = document.getElementById("defaultBtn");
const voiceBtn = document.getElementById("voiceBtn");
const bassBtn = document.getElementById("bassBtn");
const tabsList = document.getElementById("tabsList");
const tabCount = document.getElementById("tabCount");

const gearBtn = document.getElementById("gearBtn");
const panel = document.getElementById("settingsPanel");
const closePanel = document.getElementById("closePanel");
const savePanel = document.getElementById("savePanel");
const showBadgeEl = document.getElementById("showBadge");
const rememberVolumeEl = document.getElementById("rememberVolume");
const startAt100El = document.getElementById("startAt100");
const overdriveEl = document.getElementById("overdrive");

let settings = {
  showBadge: true,
  rememberVolume: true,
  startAt100: false,
  overdrive: false
};

function loadSettings() {
  return browser.storage.sync.get(settings).then(stored => {
    settings = { ...settings, ...stored };
    showBadgeEl.checked = settings.showBadge;
    rememberVolumeEl.checked = settings.rememberVolume;
    startAt100El.checked = settings.startAt100;
    overdriveEl.checked = settings.overdrive;
  });
}

function updateModeButtons() {
  defaultBtn.classList.toggle("active", currentMode === "default");
  voiceBtn.classList.toggle("active", currentMode === "voice");
  bassBtn.classList.toggle("active", currentMode === "bass");
}

function updateWarning(volume) {
  if (!warningEl) return;

  if (volume > 600) {
    warningEl.textContent =
      "Warning: volumes above 600% are experimental – use at your own risk.";
  } else if (volume === 600) {
    warningEl.textContent =
      "600% is the recommended upper limit. Going higher is at your own risk.";
  } else {
    warningEl.textContent = "";
  }
}

function applyVolume(volume) {
  slider.value = volume;
  display.textContent = volume + "%";
  muteBtn.textContent = volume === 0 ? "Unmute" : "Mute";
  updateWarning(volume);

  if (activeTabId == null) return;

  browser.tabs
    .sendMessage(activeTabId, { action: "setVolume", volume })
    .catch(() => {});
}

function saveVolume(volume) {
  if (activeTabId == null) return;

  const key = String(activeTabId);
  const data = settings.rememberVolume
    ? { [key]: volume }
    : { globalVolume: volume };

  return browser.storage.sync.set(data);
}

function applyMode(mode) {
  currentMode = mode;
  updateModeButtons();

  if (activeTabId != null) {
    browser.tabs
      .sendMessage(activeTabId, { action: "setMode", mode: currentMode })
      .catch(() => {});
  }

  browser.storage.sync.set({ mode: currentMode });
}

function sendOverdrive() {
  if (activeTabId == null) return;
  browser.tabs
    .sendMessage(activeTabId, {
      action: "setOverdrive",
      enabled: settings.overdrive
    })
    .catch(() => {});
}

function loadState() {
  if (activeTabId == null) return Promise.resolve();

  const key = String(activeTabId);
  const defaults = {
    [key]: 100,
    mode: "default",
    globalVolume: 100
  };

  return browser.storage.sync.get(defaults).then(data => {
    let volume;

    if (settings.rememberVolume) {
      volume = data[key];
    } else if (settings.startAt100) {
      volume = 100;
    } else {
      volume = data.globalVolume;
    }

    currentMode = data.mode || "default";

    applyVolume(volume);
    updateModeButtons();

    if (activeTabId != null) {
      browser.tabs
        .sendMessage(activeTabId, { action: "setMode", mode: currentMode })
        .catch(() => {});
    }
  });
}

function renderTabs() {
  browser.tabs.query({ audible: true }).then(tabs => {
    tabCount.textContent = String(tabs.length);

    if (!tabs.length) {
      tabsList.innerHTML =
        '<div class="no-tabs">No tabs playing audio right now</div>';
      return;
    }

    tabsList.innerHTML = "";

    for (const tab of tabs) {
      const item = document.createElement("div");
      item.className = "tab-item" + (tab.active ? " active" : "");
      item.dataset.id = tab.id;

      if (tab.favIconUrl) {
        const icon = document.createElement("img");
        icon.src = tab.favIconUrl;
        icon.className = "tab-favicon";
        item.appendChild(icon);
      }

      const title = document.createElement("span");
      title.className = "tab-title";
      const text =
        tab.title && tab.title.length > 40
          ? tab.title.slice(0, 40) + "…"
          : tab.title || "Untitled";
      title.textContent = text;
      item.appendChild(title);

      item.addEventListener("click", () => {
        browser.tabs.update(tab.id, { active: true });
      });

      tabsList.appendChild(item);
    }
  });
}

slider.addEventListener("input", () => {
  const volume = Number(slider.value);
  applyVolume(volume);
  saveVolume(volume);
});

muteBtn.addEventListener("click", () => {
  const isMuted = Number(slider.value) === 0;
  const nextVolume = isMuted ? 100 : 0;
  applyVolume(nextVolume);
  saveVolume(nextVolume);
});

resetBtn.addEventListener("click", () => {
  applyVolume(100);
  saveVolume(100);
});

defaultBtn.addEventListener("click", () => applyMode("default"));
voiceBtn.addEventListener("click", () => applyMode("voice"));
bassBtn.addEventListener("click", () => applyMode("bass"));

gearBtn.addEventListener("click", event => {
  event.stopPropagation();
  panel.classList.toggle("open");
});

closePanel.addEventListener("click", () => {
  panel.classList.remove("open");
});

savePanel.addEventListener("click", () => {
  settings.showBadge = showBadgeEl.checked;
  settings.rememberVolume = rememberVolumeEl.checked;
  settings.startAt100 = startAt100El.checked;
  settings.overdrive = overdriveEl.checked;

  browser.storage.sync
    .set({
      showBadge: settings.showBadge,
      rememberVolume: settings.rememberVolume,
      startAt100: settings.startAt100,
      overdrive: settings.overdrive
    })
    .then(() => {
      return loadState();
    })
    .then(() => {
      sendOverdrive();
    });

  panel.classList.remove("open");
});

if (browser.tabs.onActivated) {
  browser.tabs.onActivated.addListener(() => {
    browser.tabs
      .query({ active: true, currentWindow: true })
      .then(tabs => {
        if (!tabs.length) return;
        activeTabId = tabs[0].id;
        return loadState();
      })
      .then(() => {
        renderTabs();
        sendOverdrive();
      })
      .catch(() => {});
  });
}

browser.tabs
  .query({ active: true, currentWindow: true })
  .then(tabs => {
    if (!tabs.length) return;
    activeTabId = tabs[0].id;
    return loadSettings();
  })
  .then(() => Promise.all([loadState(), renderTabs()]))
  .then(() => {
    sendOverdrive();
  })
  .catch(console.error);

setInterval(renderTabs, 2000);
