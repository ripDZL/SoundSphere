/*
  SoundSphere — popup controller

  The popup is short-lived. It loads preferences, reflects the current tab
  state, and sends updates to the content script running in the active tab.
*/

// ---------------------------------------------------------------------
// Small async helpers
// ---------------------------------------------------------------------

function storageGet(defaults) {
  return new Promise(resolve => {
    chrome.storage.sync.get(defaults || {}, resolve);
  });
}

function storageSet(values) {
  return new Promise(resolve => {
    chrome.storage.sync.set(values || {}, resolve);
  });
}

function queryTabs(info) {
  return new Promise(resolve => {
    chrome.tabs.query(info, resolve);
  });
}

function sendTabMessage(tabId, message) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, message, response => {
        const err = chrome.runtime.lastError;
        if (err && err.message) {
          const msg = err.message;
          const benign =
            msg.includes("Receiving end does not exist") ||
            msg.includes("The message port closed") ||
            msg.includes("No matching message handler");

          if (!benign) {
            // console.debug("SoundSphere tab query message issue:", msg);
          }
        }
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function updateTab(tabId, info) {
  return new Promise(resolve => {
    chrome.tabs.update(tabId, info, resolve);
  });
}

// ---------------------------------------------------------------------
// DOM elements
// ---------------------------------------------------------------------

const slider = document.getElementById("volumeSlider");
const display = document.querySelector(".volume-display");
const warningEl = document.getElementById("volumeWarning");

const muteBtn = document.getElementById("muteBtn");
const resetBtn = document.getElementById("resetBtn");
const defaultBtn = document.getElementById("defaultBtn");
const voiceBtn = document.getElementById("voiceBtn");
const bassBtn = document.getElementById("bassBtn");
const siteNotice = document.getElementById("siteNotice");

const tabsList = document.getElementById("tabsList");
const tabCount = document.getElementById("tabCount");

const gearBtn = document.getElementById("gearBtn");
const panel = document.getElementById("settingsPanel");
const closePanel = document.getElementById("closePanel");
const savePanel = document.getElementById("savePanel");

const eqBtn = document.getElementById("eqBtn");
const eqPanel = document.getElementById("eqPanel");
const closeEqPanel = document.getElementById("closeEqPanel");
const eqResetBtn = document.getElementById("eqReset");

const showBadgeEl = document.getElementById("showBadge");
const rememberVolEl = document.getElementById("rememberVol");
const start100El = document.getElementById("start100");
const overdriveEl = document.getElementById("overdrive");

const eqInputs = Array.from(
  document.querySelectorAll(".eq-band input[type='range']")
);
const eqValueEls = Array.from(
  document.querySelectorAll(".eq-band .eq-value")
);
const eqPresetSelect = document.getElementById("eqPresetSelect");

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------

let currentTabId = null;
let currentMode = "default";
let currentHost = "";

// Whether the current page has an active WebAudio hook (content script)
// that can support >100% boost and EQ.
let pageCanBoost = false;

// Whether advanced DSP controls (EQ / modes / overdrive) are enabled for the current site.
let effectsEnabled = true;
let effectsBlockReason = "";

let eqGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
let eqCustomGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

let lastSentVolume = null;

const prefs = {
  showBadge: true,
  remember: true,
  start100: false,
  overdrive: true,
  eqPreset: "flat"
};

// ---------------------------------------------------------------------
// Classic EQ presets + Live Clean (Streams)
// ---------------------------------------------------------------------
//
// Order: Flat, Rock, Pop, Hip-Hop, Jazz, Classical, Electronic, Vocal Boost,
// Live Clean (Streams). “Custom” is handled separately.

const EQ_PRESETS = {
  // Reference curve
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],

  // Rock: strong lows + highs, slight mid scoop
  rock: [4, 3, 2, 0, -1, -2, 1, 3, 4, 4],

  // Pop: gentle bass/treble lift, mild mid scoop
  pop: [3, 2, 1, 0, -1, 0, 1, 2, 3, 3],

  // Hip-Hop: heavy sub / low-mid weight, controlled top
  hipHop: [6, 5, 4, 2, 0, -1, 1, 2, 3, 2],

  // Jazz: warm, mid-focused, smooth highs
  jazz: [2, 2, 1, 1, 1, 1, 0, 1, 1, 0],

  // Classical: slightly lean lows, open top
  classical: [-2, -1, 0, 0, 1, 1, 2, 3, 3, 3],

  // Electronic / EDM: deep lows, bright detailed highs
  electronic: [6, 5, 3, 1, 0, 1, 3, 4, 5, 4],

  // Vocal Boost: cut rumble, emphasize presence / intelligibility
  vocalBoost: [-6, -4, -2, 0, 2, 4, 4, 3, 1, -2],

  // Live Clean (Streams): more aggressive cleanup for live audio / VOIP.
  // Strong low cut, reduced mud, boosted presence, slightly tamed air.
  liveClean: [-12, -8, -4, -2, 0, 2, 4, 4, 2, -2],

  // Additional presets mapped to UI labels
  // Speech: presence boost, reduced rumble
  speech: [-6, -4, -2, 0, 2, 4, 4, 3, 1, -2],

  // Bass boost: strong low-end emphasis, slightly reduced upper highs
  bassBoost: [8, 7, 6, 4, 2, 0, -1, -2, -3, -4],

  // Treble boost: brighter top end, controlled lows
  trebleBoost: [0, -1, -2, -2, 0, 2, 4, 6, 7, 8],

  // V-shape: boosted lows and highs, scooped mids
  vShape: [6, 4, 2, 0, -4, -4, 0, 2, 4, 6]
};

// ---------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------

function keyForTab(tabId) {
  return `vol_tab_${tabId}`;
}

function maxVolume() {
  // Firefox build: we allow >100% only when the content script reports
  // that it is successfully processing audio via WebAudio.
  if (!pageCanBoost) return 100;
  return prefs.overdrive ? 800 : 600;
}

function setSiteNotice(text) {
  if (!siteNotice) return;

  const msg = (text || "").trim();
  if (!msg) {
    siteNotice.textContent = "";
    siteNotice.classList.add("hidden");
    return;
  }

  siteNotice.textContent = msg;
  siteNotice.classList.remove("hidden");
}

function setEffectsEnabledForPage(enabled, reason) {
  effectsEnabled = !!enabled;
  effectsBlockReason = reason || "";

  if (!effectsEnabled) {
    // Force basic mode in UI.
    pageCanBoost = false;
  }

  // Mode buttons and EQ controls.
  const disable = !effectsEnabled;

  try { if (eqBtn) eqBtn.disabled = disable; } catch {}
  try { if (defaultBtn) defaultBtn.disabled = disable; } catch {}
  try { if (voiceBtn) voiceBtn.disabled = disable; } catch {}
  try { if (bassBtn) bassBtn.disabled = disable; } catch {}
  try { if (eqPresetSelect) eqPresetSelect.disabled = disable; } catch {}

  for (const el of eqInputs) {
    try { el.disabled = disable; } catch {}
  }

  // If we just disabled, close any open EQ panel to avoid confusion.
  if (disable && eqPanel) {
    try { eqPanel.classList.remove("open"); } catch {}
  }

  document.body.classList.toggle("effects-disabled", disable);

  if (disable) {
    setSiteNotice(effectsBlockReason);
  } else {
    setSiteNotice("");
  }
}

function showWarning(percent) {
  if (!warningEl) return;
  warningEl.style.opacity = percent > 600 ? "1" : "0";
}

function showDisplay(percent) {
  if (!display) return;
  const value = Math.round(percent);
  display.textContent = `${value}%`;
  showWarning(value);
}

function sendToTab(message) {
  if (!currentTabId) return;
  try {
    chrome.tabs.sendMessage(currentTabId, message, () => {
      // Touch runtime.lastError so Chrome considers it handled.
      const err = chrome.runtime.lastError;
      if (!err || !err.message) return;

      const msg = err.message || "";
      const benign =
        msg.includes("Receiving end does not exist") ||
        msg.includes("The message port closed") ||
        msg.includes("No matching message handler");

      if (!benign) {
        // For release we stay quiet; switch to console.debug if you
        // ever need to inspect non-benign cases.
        // console.debug("SoundSphere tab message issue:", msg);
      }
    });
  } catch {
    // Ignore – some sites (like Jellyfin) may not have a content script
  }
}

// ---------------------------------------------------------------------
// Volume and mode handling
// ---------------------------------------------------------------------

function applyVolume(percentRaw) {
  const limit = maxVolume();
  const value = Math.max(0, Math.min(percentRaw, limit));

  // Skip redundant updates if the effective value hasn't changed.
  if (lastSentVolume === value) {
    return;
  }
  lastSentVolume = value;
  sendToTab({ action: "setVolume", volume: value });
}

function setSlider(percentRaw) {
  if (!slider) return;

  const limit = maxVolume();
  const value = Math.max(0, Math.min(percentRaw, limit));

  slider.max = String(limit);
  slider.value = String(value);
  showDisplay(value);
  applyVolume(value);
}

function setMode(mode) {
  currentMode = mode;

  [defaultBtn, voiceBtn, bassBtn].forEach(btn => {
    if (!btn) return;
    btn.classList.remove("active");
  });

  if (mode === "default" && defaultBtn) defaultBtn.classList.add("active");
  if (mode === "voice" && voiceBtn) voiceBtn.classList.add("active");
  if (mode === "bass" && bassBtn) bassBtn.classList.add("active");

  if (effectsEnabled) {
    sendToTab({ action: "setMode", mode });
    storageSet({ mode });
  }
}

// ---------------------------------------------------------------------
// EQ utilities
// ---------------------------------------------------------------------

function formatDb(val) {
  const n = Number(val) || 0;
  const sign = n > 0 ? "+" : "";
  return `${sign}${n} dB`;
}

function applyEqToUi() {
  eqInputs.forEach(input => {
    const idx = Number(input.dataset.band);
    const val = typeof eqGains[idx] === "number" ? eqGains[idx] : 0;

    input.value = String(val);

    const label = eqValueEls[idx];
    if (label) {
      label.textContent = formatDb(val);
    }
  });
}

function sendEqToContent() {
  if (!effectsEnabled) return;
  sendToTab({ action: "setEqGains", gains: eqGains });
}

function setPresetValue(name) {
  prefs.eqPreset = name;
  if (eqPresetSelect) {
    eqPresetSelect.value = name;
  }
}

function applyPreset(name) {
  const preset = EQ_PRESETS[name];
  if (!preset) return;

  eqGains = preset.slice(0, 10);
  while (eqGains.length < 10) eqGains.push(0);

  setPresetValue(name);
  applyEqToUi();
  sendEqToContent();

  storageSet({
    eqGains,
    eqPreset: prefs.eqPreset,
    eqCustomGains
  });
}

/**
 * Ensure the EQ preset dropdown contains all preset options
 * plus a "Custom" entry.
 */
function ensurePresetOptions() {
  if (!eqPresetSelect) return;

  const existing = Array.from(eqPresetSelect.options).map(o => o.value);

  const friendlyName = key => {
    switch (key) {
      case "flat":
        return "Flat";
      case "rock":
        return "Rock";
      case "pop":
        return "Pop";
      case "hipHop":
        return "Hip-Hop";
      case "jazz":
        return "Jazz";
      case "classical":
        return "Classical";
      case "electronic":
        return "Electronic / EDM";
      case "vocalBoost":
        return "Vocal Boost";
      case "liveClean":
        return "Live Clean (Streams)";
      default:
        return key
          .replace(/([A-Z])/g, " $1")
          .replace(/^./, c => c.toUpperCase());
    }
  };

  Object.keys(EQ_PRESETS).forEach(key => {
    if (!existing.includes(key)) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = friendlyName(key);
      eqPresetSelect.appendChild(opt);
    }
  });

  if (!existing.includes("custom")) {
    const opt = document.createElement("option");
    opt.value = "custom";
    opt.textContent = "Custom";
    eqPresetSelect.appendChild(opt);
  }
}

// ---------------------------------------------------------------------
// State loading
// ---------------------------------------------------------------------

async function loadPrefsAndTab() {
  const data = await storageGet({
    showBadge: true,
    rememberVolume: true,
    startAt100: false,
    overdrive: true,
    eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    eqCustomGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    eqPreset: "flat",
    mode: "default",
    vol_global: 100
  });

  prefs.showBadge =
    data.showBadge !== undefined ? !!data.showBadge : prefs.showBadge;
  prefs.remember =
    data.rememberVolume !== undefined
      ? !!data.rememberVolume
      : prefs.remember;
  prefs.start100 = !!data.startAt100;
  prefs.overdrive =
    data.overdrive !== undefined ? !!data.overdrive : prefs.overdrive;
  prefs.eqPreset = data.eqPreset || "flat";
  currentMode = data.mode || "default";

  let storedEq = Array.isArray(data.eqGains) ? data.eqGains.slice(0, 10) : [];
  while (storedEq.length < 10) storedEq.push(0);
  eqGains = storedEq;

  let storedCustom = Array.isArray(data.eqCustomGains)
    ? data.eqCustomGains.slice(0, 10)
    : [];
  while (storedCustom.length < 10) storedCustom.push(0);
  eqCustomGains = storedCustom;

  if (prefs.eqPreset === "custom") {
    eqGains = eqCustomGains.slice();
  }

  if (showBadgeEl) showBadgeEl.checked = prefs.showBadge;
  if (rememberVolEl) rememberVolEl.checked = prefs.remember;
  if (start100El) start100El.checked = prefs.start100;
  if (overdriveEl) overdriveEl.checked = prefs.overdrive;

  if (eqPresetSelect) {
    ensurePresetOptions();

    eqPresetSelect.value =
      prefs.eqPreset in EQ_PRESETS || prefs.eqPreset === "custom"
        ? prefs.eqPreset
        : "custom";
  }

  applyEqToUi();
  setMode(currentMode);

  const tabs = await queryTabs({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) return;

  currentTabId = tab.id;

  const url = tab.url || "";
  let host = "";
  try {
    host = new URL(url).hostname || "";
  } catch {
    host = "";
  }
  currentHost = host;

  const isSpotifyHost = (currentHost === 'open.spotify.com') || currentHost === 'spotify.com' || currentHost.endsWith('.spotify.com');

  let state = null;
  try {
    state = await sendTabMessage(currentTabId, { action: "getState" });
  } catch {
    state = null;
  }

  if (state && typeof state.volume === "number") {
    pageCanBoost = !!state.canBoost;
    // Capability gating (notably Spotify protected playback).
    if (state.blockedEffects) {
      setEffectsEnabledForPage(false, state.blockReason || "Advanced processing is unavailable on this page.");
    } else if (isSpotifyHost && !state.canBoost) {
      const drmDetected = !!state.drm;
      const sig = state.drmSignals || null;
      const sawSignal = !!(sig && (sig.encryptedEvent || sig.mediaKeys));
      const drmStatus = drmDetected || sawSignal
        ? "DRM status: detected."
        : "DRM status: not observed yet.";
      const msg = drmDetected
        ? `Spotify is using protected playback (DRM/Widevine) in this browser session. ${drmStatus} SoundSphere will run in Basic mode: mute and 0–100% volume only.`
        : `Advanced processing is unavailable for Spotify in this browser session. Spotify Web often uses protected playback (DRM/Widevine), which blocks EQ and overdrive in Firefox-family browsers. ${drmStatus} SoundSphere will run in Basic mode: mute and 0–100% volume only.`;
      setEffectsEnabledForPage(false, msg);
    } else {
      setEffectsEnabledForPage(true, "");
    }

    const limit = maxVolume();
    const vol = Math.max(0, Math.min(state.volume, limit));
    setSlider(vol);

    if (state.mode) setMode(state.mode);

    if (Array.isArray(state.eq)) {
      const arr = state.eq.slice(0, 10);
      while (arr.length < 10) arr.push(0);
      eqGains = arr;

      if (prefs.eqPreset === "custom") {
        eqCustomGains = eqGains.slice();
      }

      applyEqToUi();
    }

    sendEqToContent();
    return;
  }

  let percent = 100;
  lastSentVolume = null;
  const key = keyForTab(currentTabId);

  // If the content script isn't responding yet, assume no WebAudio hook.
  pageCanBoost = false;
  if (isSpotifyHost) {
    setEffectsEnabledForPage(false, "Spotify advanced processing status is unavailable right now. If this browser session uses protected playback (DRM/Widevine), EQ and overdrive are blocked. SoundSphere will run in Basic mode: mute and 0–100% volume only.");
  } else {
    setEffectsEnabledForPage(true, "");
  }

  if (prefs.remember && typeof data[key] === "number") {
    percent = data[key];
  } else if (!prefs.remember && typeof data.vol_global === "number") {
    percent = data.vol_global;
  } else if (prefs.start100) {
    percent = 100;
  }

  setSlider(percent);
  sendEqToContent();
}

// ---------------------------------------------------------------------
// Audible tabs list
// ---------------------------------------------------------------------

async function loadTabsList() {
  if (!tabsList || !tabCount) return;

  const list = (await queryTabs({ audible: true })) || [];
  tabCount.textContent = String(list.length);

  // Clear existing rows
  while (tabsList.firstChild) tabsList.removeChild(tabsList.firstChild);

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.className = "no-tabs";
    empty.textContent = "No tabs playing audio right now";
    tabsList.appendChild(empty);
    return;
  }

  for (const tab of list) {
    const title = tab.title || "Audio tab";
    const short = title.length > 40 ? `${title.slice(0, 40)}…` : title;

    const row = document.createElement("button");
    row.type = "button";
    row.className = `tab-row${tab.active ? " active" : ""}`;
    row.dataset.tabId = String(tab.id || "");
    row.title = title;

    if (tab.favIconUrl) {
      const icon = document.createElement("img");
      icon.className = "tab-icon";
      icon.alt = "";
      icon.src = tab.favIconUrl;
      row.appendChild(icon);
    }

    const name = document.createElement("span");
    name.className = "tab-title";
    name.textContent = short;
    row.appendChild(name);

    const url = tab.url || "";
    let domain = "";
    try {
      domain = url ? new URL(url).hostname : "";
    } catch {}
    if (domain) {
      const host = document.createElement("span");
      host.className = "tab-domain";
      host.textContent = domain;
      row.appendChild(host);
    }

    const vol = document.createElement("span");
    vol.className = "tab-vol";
    vol.textContent = `${Math.round(getSlider())}%`;
    row.appendChild(vol);

    row.addEventListener("click", async () => {
      const id = Number(row.dataset.tabId);
      if (!id) return;

      await updateTargetTab(id);

      // After targeting a different tab, refresh the popup state so sliders
      // and labels reflect the newly selected page.
      await refresh();
      await loadTabsList();
    });

    tabsList.appendChild(row);
  }
}

// ---------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------

function initEvents() {
  if (slider) {
    slider.addEventListener("input", () => {
      const limit = maxVolume();
      let value = Number(slider.value) || 0;
      value = Math.max(0, Math.min(value, limit));
      slider.value = String(value);
      showDisplay(value);
      applyVolume(value);
    });

    slider.addEventListener("change", () => {
      const limit = maxVolume();
      let value = Number(slider.value) || 0;
      value = Math.max(0, Math.min(value, limit));

      const data = {};
      if (prefs.remember && currentTabId) {
        data[keyForTab(currentTabId)] = value;
      } else {
        data.vol_global = value;
      }
      storageSet(data);
    });
  }

  if (muteBtn) {
    muteBtn.addEventListener("click", () => {
      const isMuted = Number(slider.value) === 0;
      const newValue = isMuted ? 100 : 0;

      setSlider(newValue);

      const data = {};
      if (prefs.remember && currentTabId) {
        data[keyForTab(currentTabId)] = newValue;
      } else {
        data.vol_global = newValue;
      }
      storageSet(data);

      muteBtn.textContent = newValue === 0 ? "Unmute" : "Mute";
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      setSlider(100);

      const data = {};
      if (prefs.remember && currentTabId) {
        data[keyForTab(currentTabId)] = 100;
      } else {
        data.vol_global = 100;
      }
      storageSet(data);

      if (muteBtn) muteBtn.textContent = "Mute";
    });
  }

  if (defaultBtn)
    defaultBtn.addEventListener("click", () => setMode("default"));
  if (voiceBtn) voiceBtn.addEventListener("click", () => setMode("voice"));
  if (bassBtn) bassBtn.addEventListener("click", () => setMode("bass"));

  if (gearBtn && panel) {
    gearBtn.addEventListener("click", () => {
      panel.classList.add("open");
    });
  }

  if (closePanel && panel) {
    closePanel.addEventListener("click", () => {
      panel.classList.remove("open");
    });
  }

  if (savePanel && panel) {
    savePanel.addEventListener("click", () => {
      prefs.showBadge = !!(showBadgeEl && showBadgeEl.checked);
      prefs.remember = !!(rememberVolEl && rememberVolEl.checked);
      prefs.start100 = !!(start100El && start100El.checked);
      prefs.overdrive = !!(overdriveEl && overdriveEl.checked);

      storageSet({
        showBadge: prefs.showBadge,
        rememberVolume: prefs.remember,
        startAt100: prefs.start100,
        overdrive: prefs.overdrive,
        eqGains,
        eqPreset: prefs.eqPreset,
        eqCustomGains
      }).then(() => {
        const current = Number(slider.value) || 0;
        setSlider(current);
        panel.classList.remove("open");
      });
    });
  }

  if (eqBtn && eqPanel) {
    eqBtn.addEventListener("click", () => {
      eqPanel.classList.add("open");
    });
  }

  if (closeEqPanel && eqPanel) {
    closeEqPanel.addEventListener("click", () => {
      eqPanel.classList.remove("open");
    });
  }

  if (eqResetBtn) {
    eqResetBtn.addEventListener("click", () => {
      applyPreset("flat");
    });
  }

  eqInputs.forEach(input => {
    input.addEventListener("input", () => {
      const idx = Number(input.dataset.band);
      const val = Number(input.value) || 0;
      eqGains[idx] = val;

      const label = eqValueEls[idx];
      if (label) label.textContent = formatDb(val);
    });

    input.addEventListener("change", () => {
      prefs.eqPreset = "custom";
      eqCustomGains = eqGains.slice();
      if (eqPresetSelect) {
        eqPresetSelect.value = "custom";
      }

      sendEqToContent();

      storageSet({
        eqGains,
        eqPreset: prefs.eqPreset,
        eqCustomGains
      });
    });
  });

  if (eqPresetSelect) {
    eqPresetSelect.addEventListener("change", () => {
      const value = eqPresetSelect.value || "custom";

      if (value === "custom") {
        prefs.eqPreset = "custom";
        eqGains = eqCustomGains.slice();
        applyEqToUi();
        sendEqToContent();
        storageSet({
          eqGains,
          eqPreset: prefs.eqPreset,
          eqCustomGains
        });
        return;
      }

      applyPreset(value);
    });
  }
}

// ---------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  ensurePresetOptions();
  initEvents();
  loadPrefsAndTab().catch(() => {});
  loadTabsList().catch(() => {});

  // Poll audible tabs while popup is open (popup dies when closed).
  setInterval(() => {
    loadTabsList().catch(() => {});
  }, 3000);
});
