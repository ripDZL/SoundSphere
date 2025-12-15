// SoundSphere popup.js — Chrome version
// Slider uses 0–600 normally, 0–800 when Experimental Overdrive is enabled.

let currentTabId = null;
let currentMode = 'default';

const slider     = document.getElementById('volumeSlider');
const display    = document.querySelector('.volume-display');
const warningEl  = document.getElementById('volumeWarning');

const muteBtn    = document.getElementById('muteBtn');
const resetBtn   = document.getElementById('resetBtn');
const defaultBtn = document.getElementById('defaultBtn');
const voiceBtn   = document.getElementById('voiceBtn');
const bassBtn    = document.getElementById('bassBtn');

const tabsList   = document.getElementById('tabsList');
const tabCount   = document.getElementById('tabCount');

const gearBtn       = document.getElementById('gearBtn');
const panel         = document.getElementById('settingsPanel');
const closePanelBtn = document.getElementById('closePanel');
const savePanel     = document.getElementById('savePanel');

const showBadgeInput   = document.getElementById('showBadge');
const rememberVolInput = document.getElementById('rememberVol');
const start100Input    = document.getElementById('start100');
const overdriveInput   = document.getElementById('overdrive');

let prefs = {
  showBadge: true,
  rememberVol: true,
  start100: false,
  overdrive: true       // ON by default so behavior matches what you have now
};

function storageGet(defaults, cb) {
  if (!chrome.storage || !chrome.storage.sync) {
    cb(defaults || {});
    return;
  }
  chrome.storage.sync.get(defaults || {}, (data) => cb(data || {}));
}

function storageSet(obj, cb) {
  if (!chrome.storage || !chrome.storage.sync) {
    if (cb) cb();
    return;
  }
  chrome.storage.sync.set(obj, () => { if (cb) cb(); });
}

function storageKeyForTab(tabId) {
  return `vol_tab_${tabId}`;
}

function maxAllowedVolume() {
  return prefs.overdrive ? 800 : 600;
}

function updateWarning(percent) {
  if (!warningEl) return;
  if (percent > 600) {
    warningEl.style.opacity = '1';
    warningEl.style.maxHeight = '40px';
  } else {
    warningEl.style.opacity = '0';
    warningEl.style.maxHeight = '0';
  }
}

function updateDisplay(percent) {
  if (display) {
    display.textContent = `${percent}%`;
  }
  updateWarning(percent);
}

function sendToCurrentTab(message) {
  if (!currentTabId || !chrome.tabs || !chrome.tabs.sendMessage) return;
  chrome.tabs.sendMessage(currentTabId, message, () => void 0);
}

function applyVolume(percentRaw) {
  const max = maxAllowedVolume();
  const percent = Math.max(0, Math.min(percentRaw, max));
  sendToCurrentTab({ action: 'setVolume', volume: percent });
}

function setSlider(percentRaw) {
  if (!slider) return;
  const max = maxAllowedVolume();
  const clamped = Math.max(0, Math.min(percentRaw, max));
  slider.max = String(max);
  slider.value = String(clamped);
  updateDisplay(clamped);
  applyVolume(clamped);
}

function setMode(mode) {
  currentMode = mode;

  [defaultBtn, voiceBtn, bassBtn].forEach((btn) => {
    if (!btn) return;
    btn.classList.remove('active');
  });

  if (mode === 'default' && defaultBtn) defaultBtn.classList.add('active');
  if (mode === 'voice'   && voiceBtn)   voiceBtn.classList.add('active');
  if (mode === 'bass'    && bassBtn)    bassBtn.classList.add('active');

  sendToCurrentTab({ action: 'setMode', mode });
  storageSet({ mode });
}

function loadPrefsAndActiveTab() {
  storageGet(
    {
      showBadge: true,
      rememberVol: true,
      start100: false,
      overdrive: true,
      mode: 'default'
    },
    (data) => {
      prefs.showBadge   = !!data.showBadge;
      prefs.rememberVol = !!data.rememberVol;
      prefs.start100    = !!data.start100;
      prefs.overdrive   = data.overdrive === undefined ? true : !!data.overdrive;
      currentMode       = data.mode || 'default';

      if (showBadgeInput)   showBadgeInput.checked   = prefs.showBadge;
      if (rememberVolInput) rememberVolInput.checked = prefs.rememberVol;
      if (start100Input)    start100Input.checked    = prefs.start100;
      if (overdriveInput)   overdriveInput.checked   = prefs.overdrive;

      setMode(currentMode);

      if (!chrome.tabs || !chrome.tabs.query) return;

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const tab = tabs && tabs[0];
        if (!tab) return;
        currentTabId = tab.id;

        storageGet({}, (all) => {
          let percent = 100;
          const key = storageKeyForTab(currentTabId);

          if (prefs.rememberVol && typeof all[key] === 'number') {
            percent = all[key];
          } else if (!prefs.rememberVol && typeof all.volumeGlobal === 'number') {
            percent = all.volumeGlobal;
          } else if (prefs.start100) {
            percent = 100;
          }

          setSlider(percent);
        });
      });
    }
  );
}

function loadTabsList() {
  if (!tabsList || !tabCount || !chrome.tabs || !chrome.tabs.query) return;

  chrome.tabs.query({ audible: true }, (tabs) => {
    const list = tabs || [];
    tabCount.textContent = String(list.length);

    if (list.length === 0) {
      tabsList.innerHTML = '<div class="no-tabs">No tabs playing audio right now</div>';
      return;
    }

    tabsList.innerHTML = list
      .map((tab) => {
        const title = tab.title || 'Audio tab';
        const short = title.length > 40 ? title.slice(0, 40) + '…' : title;
        const activeClass = tab.id === currentTabId ? 'active' : '';
        const icon = tab.favIconUrl
          ? `<img src="${tab.favIconUrl}" class="tab-favicon">`
          : '';
        return `<button class="tab-item ${activeClass}" data-id="${tab.id}">
          ${icon}<span class="tab-title">${short}</span>
        </button>`;
      })
      .join('');

    tabsList.querySelectorAll('.tab-item').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id);
        chrome.tabs.update(id, { active: true });
        currentTabId = id;
        loadPrefsAndActiveTab();
      });
    });
  });
}

// ---- events ----

function initEvents() {
  if (slider) {
    slider.addEventListener('input', () => {
      const max = maxAllowedVolume();
      let percent = Number(slider.value) || 0;
      percent = Math.max(0, Math.min(percent, max));
      slider.value = String(percent);
      updateDisplay(percent);
      applyVolume(percent);
    });

    slider.addEventListener('change', () => {
      const max = maxAllowedVolume();
      let percent = Number(slider.value) || 0;
      percent = Math.max(0, Math.min(percent, max));

      const data = {};
      if (prefs.rememberVol && currentTabId) {
        data[storageKeyForTab(currentTabId)] = percent;
      } else {
        data.volumeGlobal = percent;
      }
      storageSet(data);
    });
  }

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      const isMuted = Number(slider.value) === 0;
      const newPercent = isMuted ? 100 : 0;
      setSlider(newPercent);

      const data = {};
      if (prefs.rememberVol && currentTabId) {
        data[storageKeyForTab(currentTabId)] = newPercent;
      } else {
        data.volumeGlobal = newPercent;
      }
      storageSet(data);

      muteBtn.textContent = newPercent === 0 ? 'Unmute' : 'Mute';
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      setSlider(100);
      const data = {};
      if (prefs.rememberVol && currentTabId) {
        data[storageKeyForTab(currentTabId)] = 100;
      } else {
        data.volumeGlobal = 100;
      }
      storageSet(data);
      if (muteBtn) muteBtn.textContent = 'Mute';
    });
  }

  if (defaultBtn) defaultBtn.addEventListener('click', () => setMode('default'));
  if (voiceBtn)   voiceBtn.addEventListener('click', () => setMode('voice'));
  if (bassBtn)    bassBtn.addEventListener('click', () => setMode('bass'));

  if (gearBtn && panel) {
    gearBtn.addEventListener('click', () => panel.classList.add('open'));
  }

  if (closePanelBtn && panel) {
    closePanelBtn.addEventListener('click', () => panel.classList.remove('open'));
  }

  if (savePanel && panel) {
    savePanel.addEventListener('click', () => {
      prefs.showBadge   = !!(showBadgeInput && showBadgeInput.checked);
      prefs.rememberVol = !!(rememberVolInput && rememberVolInput.checked);
      prefs.start100    = !!(start100Input && start100Input.checked);
      prefs.overdrive   = !!(overdriveInput && overdriveInput.checked);

      storageSet(
        {
          showBadge: prefs.showBadge,
          rememberVol: prefs.rememberVol,
          start100: prefs.start100,
          overdrive: prefs.overdrive
        },
        () => {
          // apply new overdrive cap immediately
          const current = Number(slider.value) || 0;
          setSlider(current);
          panel.classList.remove('open');
        }
      );
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  initEvents();
  loadPrefsAndActiveTab();
  loadTabsList();
  setInterval(loadTabsList, 2000);
});
