"use strict";

const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  rock: [4, 3, 2, 0, -1, -2, 1, 3, 4, 4],
  pop: [3, 2, 1, 0, -1, 0, 1, 2, 3, 3],
  hipHop: [6, 5, 4, 2, 0, -1, 1, 2, 3, 2],
  jazz: [2, 2, 1, 1, 1, 1, 0, 1, 1, 0],
  classical: [-2, -1, 0, 0, 1, 1, 2, 3, 3, 3],
  electronic: [6, 5, 3, 1, 0, 1, 3, 4, 5, 4],
  vocalBoost: [-6, -4, -2, 0, 2, 4, 4, 3, 1, -2],
  liveClean: [-12, -8, -4, -2, 0, 2, 4, 4, 2, -2],
  bassBoost: [8, 7, 6, 4, 2, 0, -1, -2, -3, -4],
  trebleBoost: [0, -1, -2, -2, 0, 2, 4, 6, 7, 8],
  vShape: [6, 4, 2, 0, -4, -4, 0, 2, 4, 6]
};

const EQ_LABELS = ["31", "62", "125", "250", "500", "1k", "2k", "4k", "8k", "16k"];

const els = {
  status: document.getElementById("engineStatus"),
  slider: document.getElementById("volumeSlider"),
  display: document.getElementById("volumeDisplay"),
  warning: document.getElementById("volumeWarning"),
  mute: document.getElementById("muteBtn"),
  reset: document.getElementById("resetBtn"),
  defaultMode: document.getElementById("defaultBtn"),
  voiceMode: document.getElementById("voiceBtn"),
  bassMode: document.getElementById("bassBtn"),
  tabsList: document.getElementById("tabsList"),
  tabCount: document.getElementById("tabCount"),
  settingsBtn: document.getElementById("settingsBtn"),
  settingsPanel: document.getElementById("settingsPanel"),
  closeSettings: document.getElementById("closeSettings"),
  saveSettings: document.getElementById("saveSettings"),
  eqBtn: document.getElementById("eqBtn"),
  eqPanel: document.getElementById("eqPanel"),
  closeEq: document.getElementById("closeEq"),
  eqGrid: document.getElementById("eqGrid"),
  eqPreset: document.getElementById("eqPreset"),
  eqReset: document.getElementById("eqReset"),
  showBadge: document.getElementById("showBadge"),
  rememberVolume: document.getElementById("rememberVolume"),
  startAt100: document.getElementById("startAt100"),
  overdrive: document.getElementById("overdrive")
};

let currentTabId = null;
let tabVolumes = {};
let globalVolume = 100;
let lastNonZeroVolume = 100;
let applyTimer = null;
let applySeq = 0;

const prefs = {
  showBadge: true,
  rememberVolume: true,
  startAt100: false,
  overdrive: true,
  eqPreset: "flat"
};

const settings = {
  volume: 100,
  muted: false,
  mode: "default",
  eqGains: EQ_PRESETS.flat.slice()
};

const capability = {
  mode: "ready",
  canBoost: true,
  reason: ""
};

function storageGet(defaults) {
  return new Promise(resolve => chrome.storage.sync.get(defaults, resolve));
}

function storageSet(values) {
  return new Promise(resolve => {
    chrome.storage.sync.set(values, () => {
      if (chrome.runtime.lastError) console.debug(chrome.runtime.lastError.message);
      resolve();
    });
  });
}

function storageLocalGet(defaults) {
  return new Promise(resolve => chrome.storage.local.get(defaults, resolve));
}

function storageLocalSet(values) {
  return new Promise(resolve => chrome.storage.local.set(values, resolve));
}

function queryTabs(queryInfo) {
  return new Promise(resolve => chrome.tabs.query(queryInfo, tabs => resolve(tabs || [])));
}

function updateTab(tabId, updateInfo) {
  return new Promise(resolve => chrome.tabs.update(tabId, updateInfo, resolve));
}

function updateWindow(windowId, updateInfo) {
  return new Promise(resolve => chrome.windows.update(windowId, updateInfo, resolve));
}

function sendRuntime(message) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError;
      if (error) resolve({ ok: false, error: error.message });
      else resolve(response || { ok: true });
    });
  });
}

function getTabVolume(tabId) {
  if (tabId == null || !tabVolumes || typeof tabVolumes !== "object") return undefined;
  const value = tabVolumes[String(tabId)];
  return typeof value === "number" ? value : undefined;
}

function setTabVolume(tabId, value) {
  if (tabId == null) return;
  tabVolumes = { ...(tabVolumes || {}), [String(tabId)]: value };
}

function currentMax() {
  if (!capability.canBoost) return 100;
  return prefs.overdrive ? 800 : 600;
}

function clampVolume(value) {
  return Math.max(0, Math.min(Number(value) || 0, currentMax()));
}

function formatDb(value) {
  const number = Number(value) || 0;
  return `${number > 0 ? "+" : ""}${number}`;
}

function renderSlider() {
  const max = currentMax();
  if (settings.volume > max) settings.volume = max;

  els.slider.max = String(max);
  els.slider.value = String(settings.volume);
  els.display.textContent = `${Math.round(settings.volume)}%`;
  els.mute.textContent = settings.volume <= 0 || settings.muted ? "Unmute" : "Mute";
  els.warning.style.opacity = settings.volume > 600 ? "1" : "0";

  const fill = max > 0 ? (settings.volume / max) * 100 : 0;
  els.slider.style.background =
    `linear-gradient(to right, var(--accent) 0%, var(--accent) ${fill}%, var(--surface-2) ${fill}%)`;
}

function renderMode() {
  const pairs = [
    [els.defaultMode, "default"],
    [els.voiceMode, "voice"],
    [els.bassMode, "bass"]
  ];

  for (const [button, mode] of pairs) {
    const active = settings.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  }
}

function renderEq() {
  for (const input of els.eqGrid.querySelectorAll(".eq-slider")) {
    const index = Number(input.dataset.band);
    input.value = String(settings.eqGains[index] || 0);
    const value = input.closest(".eq-band").querySelector(".eq-value");
    value.textContent = formatDb(settings.eqGains[index] || 0);
  }
  els.eqPreset.value = prefs.eqPreset;
}

function renderStatus() {
  const labels = {
    "ready": "Chrome whole-tab ready",
    "whole-tab": "Whole-tab audio",
    "media-element": "Media element audio",
    "page-webaudio": "Page WebAudio",
    "protected-basic": "Protected basic mode",
    "basic": "Basic mode",
    "unsupported": "Unsupported page"
  };

  const label = labels[capability.mode] || labels.ready;
  els.status.textContent = capability.reason ? `${label}: ${capability.reason}` : label;
}

function renderAll() {
  renderSlider();
  renderMode();
  renderEq();
  renderStatus();
}

function persistVolume() {
  if (prefs.rememberVolume && currentTabId != null) {
    setTabVolume(currentTabId, settings.volume);
    storageLocalSet({ vol_tabs: tabVolumes });
  } else {
    globalVolume = settings.volume;
    storageSet({ vol_global: globalVolume });
  }
}

function normalizeEq(list) {
  const eq = Array.isArray(list) ? list.slice(0, 10) : [];
  while (eq.length < 10) eq.push(0);
  return eq.map(value => Math.max(-24, Math.min(24, Number(value) || 0)));
}

function updateCapability(response) {
  if (!response) return;
  capability.mode = response.mode || "unsupported";
  capability.canBoost = !!response.canBoost;
  capability.reason = response.reason || response.error || "";

  if (!capability.canBoost && settings.volume > 100) {
    settings.volume = 100;
  }
  renderAll();
}

async function applySettingsNow() {
  if (!currentTabId) return;
  const seq = ++applySeq;
  const response = await sendRuntime({
    type: "SS_APPLY_SETTINGS",
    tabId: currentTabId,
    settings: {
      volume: settings.volume,
      muted: settings.muted || settings.volume <= 0,
      mode: settings.mode,
      eqGains: settings.eqGains.slice()
    }
  });

  if (seq === applySeq) updateCapability(response);
}

function scheduleApply(delay = 40) {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(() => applySettingsNow(), delay);
}

function setVolume(value, persist) {
  settings.volume = clampVolume(value);
  settings.muted = settings.volume <= 0;
  if (settings.volume > 0) lastNonZeroVolume = settings.volume;
  renderSlider();
  scheduleApply();
  if (persist) persistVolume();
}

function setMode(mode) {
  settings.mode = mode === "voice" || mode === "bass" ? mode : "default";
  renderMode();
  storageSet({ mode: settings.mode });
  scheduleApply(0);
}

function setEqGains(next, preset) {
  settings.eqGains = normalizeEq(next);
  prefs.eqPreset = preset || "custom";
  renderEq();
  const saved = {
    eqGains: settings.eqGains.slice(),
    eqPreset: prefs.eqPreset
  };
  if (prefs.eqPreset === "custom") saved.eqCustomGains = settings.eqGains.slice();
  storageSet(saved);
  scheduleApply(0);
}

function createEqGrid() {
  els.eqGrid.textContent = "";
  EQ_LABELS.forEach((label, index) => {
    const wrap = document.createElement("label");
    wrap.className = "eq-band";

    const labelEl = document.createElement("span");
    labelEl.className = "eq-label";
    labelEl.textContent = label;

    const input = document.createElement("input");
    input.className = "eq-slider";
    input.type = "range";
    input.min = "-12";
    input.max = "12";
    input.step = "1";
    input.value = "0";
    input.dataset.band = String(index);
    input.setAttribute("aria-label", `${label} Hz`);

    const valueEl = document.createElement("span");
    valueEl.className = "eq-value";
    valueEl.textContent = "0";

    wrap.append(labelEl, input, valueEl);
    els.eqGrid.appendChild(wrap);

    input.addEventListener("input", () => {
      settings.eqGains[index] = Number(input.value) || 0;
      valueEl.textContent = formatDb(settings.eqGains[index]);
      prefs.eqPreset = "custom";
      els.eqPreset.value = "custom";
      scheduleApply(0);
    });

    input.addEventListener("change", () => {
      storageSet({
        eqGains: settings.eqGains.slice(),
        eqPreset: "custom",
        eqCustomGains: settings.eqGains.slice()
      });
    });
  });
}

function openPanel(panel, opener) {
  panel.classList.add("open");
  opener.setAttribute("aria-expanded", "true");
}

function closePanel(panel, opener) {
  panel.classList.remove("open");
  opener.setAttribute("aria-expanded", "false");
  opener.focus();
}

async function loadPrefs() {
  const data = await storageGet({
    showBadge: true,
    rememberVolume: true,
    startAt100: false,
    overdrive: true,
    mode: "default",
    eqGains: EQ_PRESETS.flat,
    eqCustomGains: EQ_PRESETS.flat,
    eqPreset: "flat",
    vol_global: 100
  });
  const localData = await storageLocalGet({ vol_tabs: {} });

  prefs.showBadge = data.showBadge !== false;
  prefs.rememberVolume = data.rememberVolume !== false;
  prefs.startAt100 = !!data.startAt100;
  prefs.overdrive = data.overdrive !== false;
  prefs.eqPreset = data.eqPreset || "flat";
  settings.mode = data.mode || "default";
  tabVolumes = localData.vol_tabs && typeof localData.vol_tabs === "object"
    ? localData.vol_tabs
    : {};
  globalVolume = typeof data.vol_global === "number" ? data.vol_global : 100;

  if (prefs.eqPreset === "custom") {
    settings.eqGains = normalizeEq(data.eqCustomGains);
  } else {
    settings.eqGains = normalizeEq(EQ_PRESETS[prefs.eqPreset] || data.eqGains);
  }

  els.showBadge.checked = prefs.showBadge;
  els.rememberVolume.checked = prefs.rememberVolume;
  els.startAt100.checked = prefs.startAt100;
  els.overdrive.checked = prefs.overdrive;
}

function chooseInitialVolume() {
  if (prefs.startAt100) return 100;
  const remembered = getTabVolume(currentTabId);
  if (prefs.rememberVolume && typeof remembered === "number") return remembered;
  if (!prefs.rememberVolume && typeof globalVolume === "number") return globalVolume;
  return 100;
}

async function loadTab(tab) {
  currentTabId = tab && typeof tab.id === "number" ? tab.id : null;
  capability.mode = "ready";
  capability.canBoost = true;
  capability.reason = "";

  settings.volume = chooseInitialVolume();
  settings.muted = settings.volume <= 0;
  if (settings.volume > 0) lastNonZeroVolume = settings.volume;
  renderAll();

  const status = await sendRuntime({ type: "SS_GET_STATUS", tabId: currentTabId });
  updateCapability(status);
  scheduleApply(0);
}

async function loadActiveTab() {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  await loadTab(tabs[0]);
}

async function loadAudibleTabs() {
  const tabs = await queryTabs({ audible: true });
  els.tabCount.textContent = String(tabs.length);
  els.tabsList.textContent = "";

  if (!tabs.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No tabs playing audio";
    els.tabsList.appendChild(empty);
    return;
  }

  for (const tab of tabs) {
    const row = document.createElement("button");
    row.className = `tab-row${tab.id === currentTabId ? " active" : ""}`;
    row.type = "button";
    row.dataset.tabId = String(tab.id);

    if (tab.favIconUrl) {
      const icon = document.createElement("img");
      icon.className = "tab-icon";
      icon.src = tab.favIconUrl;
      icon.alt = "";
      row.appendChild(icon);
    }

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = tab.title || "Audio tab";
    row.appendChild(title);

    row.addEventListener("click", async () => {
      if (typeof tab.windowId === "number") {
        await updateWindow(tab.windowId, { focused: true });
      }
      await updateTab(tab.id, { active: true });
      await loadTab(tab);
      loadAudibleTabs();
    });

    els.tabsList.appendChild(row);
  }
}

function bindEvents() {
  els.slider.addEventListener("input", () => setVolume(els.slider.value, false));
  els.slider.addEventListener("change", () => {
    setVolume(els.slider.value, true);
  });

  els.mute.addEventListener("click", () => {
    if (settings.volume <= 0 || settings.muted) {
      setVolume(lastNonZeroVolume || 100, true);
    } else {
      lastNonZeroVolume = settings.volume;
      setVolume(0, true);
    }
  });

  els.reset.addEventListener("click", () => setVolume(100, true));
  els.defaultMode.addEventListener("click", () => setMode("default"));
  els.voiceMode.addEventListener("click", () => setMode("voice"));
  els.bassMode.addEventListener("click", () => setMode("bass"));

  els.settingsBtn.addEventListener("click", () => openPanel(els.settingsPanel, els.settingsBtn));
  els.closeSettings.addEventListener("click", () => closePanel(els.settingsPanel, els.settingsBtn));
  els.eqBtn.addEventListener("click", () => openPanel(els.eqPanel, els.eqBtn));
  els.closeEq.addEventListener("click", () => closePanel(els.eqPanel, els.eqBtn));

  els.saveSettings.addEventListener("click", async () => {
    prefs.showBadge = els.showBadge.checked;
    prefs.rememberVolume = els.rememberVolume.checked;
    prefs.startAt100 = els.startAt100.checked;
    prefs.overdrive = els.overdrive.checked;

    await storageSet({
      showBadge: prefs.showBadge,
      rememberVolume: prefs.rememberVolume,
      startAt100: prefs.startAt100,
      overdrive: prefs.overdrive
    });

    renderSlider();
    scheduleApply(0);
    closePanel(els.settingsPanel, els.settingsBtn);
    sendRuntime({ type: "SS_REFRESH_BADGE" });
  });

  els.eqPreset.addEventListener("change", () => {
    const preset = els.eqPreset.value;
    if (preset === "custom") {
      prefs.eqPreset = "custom";
      storageSet({ eqPreset: "custom" });
      return;
    }
    setEqGains(EQ_PRESETS[preset] || EQ_PRESETS.flat, preset);
  });

  els.eqReset.addEventListener("click", () => setEqGains(EQ_PRESETS.flat, "flat"));

  document.addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    if (els.eqPanel.classList.contains("open")) closePanel(els.eqPanel, els.eqBtn);
    if (els.settingsPanel.classList.contains("open")) closePanel(els.settingsPanel, els.settingsBtn);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  createEqGrid();
  bindEvents();
  await loadPrefs();
  renderAll();
  await loadActiveTab();
  await loadAudibleTabs();
  setInterval(loadAudibleTabs, 3000);
});
