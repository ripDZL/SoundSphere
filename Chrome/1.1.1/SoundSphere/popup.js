// SoundSphere popup
//
// This is the small UI you see when you click the extension icon.
// It lets you:
//   - boost or cut the volume for the current tab,
//   - toggle mute / reset,
//   - pick an EQ preset or shape a 10‑band EQ by hand,
//   - switch between Default / Voice / Bass modes,
//   - tweak a few quality‑of‑life options.
//
// The popup is short‑lived. It reads your saved settings, sends the new
// values to the content script or engine tab, and then disappears when
// you close it.
//

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
    chrome.storage.sync.set(values || {}, () => {
      const err = chrome.runtime.lastError;
      if (err && err.message) {
        // Surfaces quota / write-rate failures that were previously silent.
        console.debug("SoundSphere storage write issue:", err.message);
      }
      resolve();
    });
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
// Tab-wide audio controller (tabCapture-based)
// ---------------------------------------------------------------------
//
// Used on hosts where direct element control is unreliable or opaque
// (Bandcamp, SoundCloud, Spotify Web, Amazon Music, Twitch, Jellyfin, etc.).
// Instead of touching the page directly, we send high‑level instructions
// to the pinned engine tab and let it handle tabCapture + WebAudio.
//
// This client only worries about:
//   - making sure the engine tab exists
//   - routing messages by tabId
//   - keeping track of which tab the popup is currently controlling
class TabAudioController {
  constructor() {
    this.engineUrl = chrome.runtime.getURL("engine.html");
    this.engineReady = false;
    this.engineTabId = null;
    this._ensurePromise = null;
  }

  async ensureEngineTab() {
    // Ensure the engine tab exists, but avoid creating duplicates if multiple
    // calls race each other.
    if (this.engineReady && this.engineTabId != null) return;

    if (this._ensurePromise) {
      return this._ensurePromise;
    }

    this._ensurePromise = (async () => {
      const tabs = await queryTabs({ url: this.engineUrl });
      if (tabs && tabs.length) {
        this.engineReady = true;
        this.engineTabId = tabs[0].id;
        this._ensurePromise = null;
        return;
      }

      await new Promise(resolve => {
        chrome.tabs.create(
          {
            url: this.engineUrl,
            pinned: true,
            active: false
          },
          tab => {
            if (tab && typeof tab.id === "number") {
              this.engineTabId = tab.id;
            }
            resolve();
          }
        );
      });

      this.engineReady = true;
      this._ensurePromise = null;
    })();

    return this._ensurePromise;
  }

  async sendToEngine(message) {
    try {
      await this.ensureEngineTab();
    } catch (error) {
      // In the release build we keep this quiet. If the engine tab cannot
      // be created, the controls simply have no effect on that site.
      return null;
    }

    return new Promise(resolve => {
      chrome.runtime.sendMessage(
        Object.assign({ target: "engine" }, message),
        response => {
          const err = chrome.runtime.lastError;
          if (err && err.message) {
            const msg = err.message;
            const benign =
              msg.includes("Receiving end does not exist") ||
              msg.includes("The message port closed") ||
              msg.includes("No matching message handler");

            if (!benign) {
              // For debugging you can temporarily enable:
              // console.debug("SoundSphere engine message issue:", msg);
            }
          }
          resolve(response || null);
        }
      );
    });
  }

  async setGainPercent(tabId, percent) {
    const id =
      typeof tabId === "number" ? tabId : typeof currentTabId === "number" ? currentTabId : null;
    if (id == null) return;
    await this.sendToEngine({
      type: "SET_GAIN",
      tabId: id,
      volume: percent
    });
  }

  async setEqGains(gains) {
    const id = typeof currentTabId === "number" ? currentTabId : null;
    if (id == null) return;
    await this.sendToEngine({
      type: "SET_EQ",
      tabId: id,
      gains
    });
  }

  async setMode(mode) {
    const id = typeof currentTabId === "number" ? currentTabId : null;
    if (id == null) return;
    await this.sendToEngine({
      type: "SET_MODE",
      tabId: id,
      mode
    });
  }

  async dispose() {
    const id = typeof currentTabId === "number" ? currentTabId : null;
    await this.sendToEngine({
      type: "DISPOSE",
      tabId: id
    });
  }
}

const tabAudioController = new TabAudioController();


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
let captureStarted = false; // offscreen tabCapture engaged for the current tab
let captureRetries = 0;
const MAX_CAPTURE_RETRIES = 2;

function ssLog(...args) {
  console.log("[SS popup]", ...args);
}

let eqGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
let eqCustomGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

let lastSentVolume = null;

// Loaded once at popup open; updated in memory and persisted on change.
let hostVolumes = []; // MRU array of [host, percent]
let globalVolume = 100; // fallback when "remember per site" is off

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

// Per-site volumes live in a SINGLE sync key ("vol_hosts") as an MRU array:
//   [[host, percent], ...]
// This avoids the old `vol_tab_<id>` scheme, which created one key per tab,
// never cleaned them up, and eventually hit chrome.storage.sync's 512-item
// cap (after which all writes failed silently). Tab IDs are also ephemeral,
// so per-tab memory never survived a restart anyway. Keying by host fixes
// both: it's bounded, and "remember volume" now actually persists per site.
const HOST_VOL_CAP = 200;        // hard ceiling on remembered sites
const HOST_VOL_MAX_BYTES = 7000; // stay safely under sync's 8192 bytes/item

function getHostVolume(list, host) {
  if (!Array.isArray(list) || !host) return undefined;
  const entry = list.find(e => Array.isArray(e) && e[0] === host);
  return entry && typeof entry[1] === "number" ? entry[1] : undefined;
}

function setHostVolume(list, host, value) {
  const arr = Array.isArray(list)
    ? list.filter(e => Array.isArray(e) && e[0] !== host)
    : [];
  arr.unshift([host, value]);
  if (arr.length > HOST_VOL_CAP) arr.length = HOST_VOL_CAP;
  // Drop least-recently-set entries (from the tail) until the serialized map
  // fits the per-item quota, so a write can never silently fail on overflow,
  // regardless of hostname lengths. The just-set entry (front) is preserved.
  while (
    arr.length > 1 &&
    new TextEncoder().encode(JSON.stringify(arr)).length > HOST_VOL_MAX_BYTES
  ) {
    arr.pop();
  }
  return arr;
}

/**
 * Decide whether a given URL should use the tabCapture audio path.
 * This covers:
 * - Bandcamp / SoundCloud
 * - Spotify Web
 * - Amazon Music
 * - Twitch
 * - Jellyfin (by hostname or common ports 8096 / 8920 with /web path)
 */
function isTabCaptureUrl(url) {
  if (!url) return false;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const host = (parsed.hostname || "").toLowerCase();
  const path = (parsed.pathname || "").toLowerCase();
  const port = parsed.port || "";

  if (host.endsWith("bandcamp.com")) return true;
  if (host.endsWith("soundcloud.com")) return true;
  if (host === "open.spotify.com") return true;
  if (host === "music.amazon.com" || host.endsWith(".music.amazon.com"))
    return true;
  if (host === "www.twitch.tv" || host.endsWith(".twitch.tv")) return true;

  // Jellyfin: hostname contains "jellyfin" (e.g. jellyfin.local, jellyfin.domain)
  if (host.includes("jellyfin")) return true;

  // Jellyfin common ports with /web UI (e.g. http://192.168.x.x:8096/web)
  if ((port === "8096" || port === "8920") && path.startsWith("/web")) {
    return true;
  }

  return false;
}

function maxVolume() {
  return prefs.overdrive ? 800 : 600;
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

// Volume for every site runs through the offscreen tab-capture engine.
// Capture starts on the first apply (opening the popup is the activeTab
// gesture tabCapture requires); later changes just adjust the gain.
function applyEngineVolume(value) {
  if (currentTabId == null) return;
  if (!captureStarted) {
    captureStarted = true;
    ssLog("requesting capture: tab", currentTabId, "vol", value);
    chrome.runtime.sendMessage(
      { type: "ss-start-capture", tabId: currentTabId, volume: value,
        mode: currentMode, gains: eqGains },
      resp => {
        const err = (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
          (resp && resp.error);
        if (err || !resp || !resp.ok) {
          captureStarted = false; // re-arm so the next attempt can start
          ssLog("capture FAILED:", err);
          if (captureRetries < MAX_CAPTURE_RETRIES) {
            captureRetries++;
            ssLog("auto-retry " + captureRetries + " in 400ms");
            setTimeout(() => {
              const v = Number(slider && slider.value) || value;
              applyEngineVolume(v);
            }, 400);
          } else {
            ssLog("capture gave up after " + MAX_CAPTURE_RETRIES + " retries");
          }
        } else {
          ssLog("capture OK: tab", currentTabId);
          captureRetries = 0;
        }
      }
    );
  } else {
    chrome.runtime.sendMessage({ type: "ss-set-volume", volume: value }, resp => {
      if (chrome.runtime.lastError) return;
      if (resp && resp.needsStart) {
        ssLog("capture gone; re-hooking");
        captureStarted = false;
        applyEngineVolume(value);
      }
    });
  }
}

function applyVolume(percentRaw) {
  const limit = maxVolume();
  const value = Math.max(0, Math.min(percentRaw, limit));

  // Skip redundant updates if the effective value hasn't changed.
  if (lastSentVolume === value) {
    return;
  }
  lastSentVolume = value;

  // Every site is now controlled by the offscreen tabCapture engine.
  applyEngineVolume(value);
}

function setSlider(percentRaw) {
  if (!slider) return;

  const limit = maxVolume();
  const value = Math.max(0, Math.min(percentRaw, limit));

  slider.max = String(limit);
  slider.value = String(value);
  updateSliderFill(value, limit);
  showDisplay(value);
  applyVolume(value);
}

function updateSliderFill(value, limit) {
  if (!slider) return;
  const pct = (value / (limit || 800)) * 100;
  slider.style.background =
    `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--surface-2) ${pct}%)`;
}

// Saves the given volume for the current context: per-site when "remember"
// is on (and we have a host), otherwise as the single global fallback.
function persistVolume(value) {
  if (prefs.remember && currentHost) {
    hostVolumes = setHostVolume(hostVolumes, currentHost, value);
    storageSet({ vol_hosts: hostVolumes });
  } else {
    globalVolume = value;
    storageSet({ vol_global: value });
  }
}

function setMode(mode) {
  currentMode = mode;

  [defaultBtn, voiceBtn, bassBtn].forEach(btn => {
    if (!btn) return;
    btn.classList.remove("active");
  });

  [defaultBtn, voiceBtn, bassBtn].forEach(btn => {
    if (btn) btn.setAttribute("aria-pressed", "false");
  });
  const activeBtn =
    mode === "voice" ? voiceBtn : mode === "bass" ? bassBtn : defaultBtn;
  if (activeBtn) {
    activeBtn.classList.add("active");
    activeBtn.setAttribute("aria-pressed", "true");
  }

  storageSet({ mode });
  chrome.runtime.sendMessage({ type: "ss-set-mode", mode });
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
  chrome.runtime.sendMessage({ type: "ss-set-eq", gains: eqGains });
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
    vol_global: 100,
    vol_hosts: []
  });

  hostVolumes = Array.isArray(data.vol_hosts) ? data.vol_hosts : [];
  globalVolume = typeof data.vol_global === "number" ? data.vol_global : 100;

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

  if (prefs.eqPreset === "speech") prefs.eqPreset = "vocalBoost";

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
  captureStarted = false;
  captureRetries = 0;
  ssLog("tab resolved:", currentTabId, currentHost || "(no host)");
  // Mode and EQ travel in the capture-start payload, so there's nothing
  // extra to push to the engine on load.

  let state = null;
  try {
    state = await sendTabMessage(currentTabId, { action: "getState" });
  } catch {
    state = null;
  }

  if (state && typeof state.volume === "number") {
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

  const remembered = getHostVolume(hostVolumes, currentHost);
  if (prefs.remember && typeof remembered === "number") {
    percent = remembered;
  } else if (!prefs.remember) {
    percent = globalVolume;
  }
  // Otherwise (remember on, no stored value, or start100) defaults to 100.

  setSlider(percent);
  sendEqToContent();
}

// ---------------------------------------------------------------------
// Audible tabs list
// ---------------------------------------------------------------------

async function loadTabsList() {
  if (!tabsList || !tabCount) return;

  const tabs = await queryTabs({ audible: true });
  const list = tabs || [];

  tabCount.textContent = String(list.length);

  if (list.length === 0) {
    tabsList.innerHTML =
      '<div class="no-tabs">No tabs playing audio right now</div>';
    return;
  }

  tabsList.textContent = "";
  list.forEach(tab => {
    const title = tab.title || "Audio tab";
    const short = title.length > 40 ? `${title.slice(0, 40)}…` : title;

    const btn = document.createElement("button");
    btn.className = "tab-row" + (tab.active ? " active" : "");
    btn.dataset.tabId = String(tab.id);

    if (tab.favIconUrl) {
      const img = document.createElement("img");
      img.src = tab.favIconUrl;
      img.className = "tab-icon";
      img.alt = "";
      btn.appendChild(img);
    }

    const span = document.createElement("span");
    span.className = "tab-title";
    span.textContent = short;
    btn.appendChild(span);

    tabsList.appendChild(btn);
  });

  tabsList.querySelectorAll(".tab-row").forEach(row => {
    row.addEventListener("click", async () => {
      const id = Number(row.dataset.tabId);
      if (!id) return;

      await updateTab(id, { active: true });
      currentTabId = id;

      const [tab] = await queryTabs({ active: true, currentWindow: true });
      if (tab) {
        const url = tab.url || "";
        let host = "";
        try {
          host = new URL(url).hostname || "";
        } catch {
          host = "";
        }
        currentHost = host;
        captureStarted = false;
        captureRetries = 0;
      }

      let percent = 100;
      const remembered = getHostVolume(hostVolumes, currentHost);
      if (prefs.remember && typeof remembered === "number") {
        percent = remembered;
      } else if (!prefs.remember) {
        percent = globalVolume;
      }

      // Reset the dedupe guard so the newly-focused tab actually receives its
      // volume, even when it equals the previously-controlled tab's value.
      lastSentVolume = null;
      setSlider(percent);
    });
  });
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
      slider.setAttribute("aria-valuetext", value + "%");
      updateSliderFill(value, Number(slider.max) || 800);
      showDisplay(value);
      applyVolume(value);
    });

    slider.addEventListener("change", () => {
      const limit = maxVolume();
      let value = Number(slider.value) || 0;
      value = Math.max(0, Math.min(value, limit));
      persistVolume(value);
    });
  }

  if (muteBtn) {
    muteBtn.addEventListener("click", () => {
      const isMuted = Number(slider.value) === 0;
      const newValue = isMuted ? 100 : 0;

      setSlider(newValue);
      persistVolume(newValue);

      muteBtn.textContent = newValue === 0 ? "Unmute" : "Mute";
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      setSlider(100);
      persistVolume(100);

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
      gearBtn.setAttribute("aria-expanded", "true");
      const first = panel.querySelector("input, select, button");
      if (first) first.focus();
    });
  }

  if (closePanel && panel) {
    closePanel.addEventListener("click", () => {
      panel.classList.remove("open");
      if (gearBtn) {
        gearBtn.setAttribute("aria-expanded", "false");
        gearBtn.focus();
      }
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
      eqBtn.setAttribute("aria-expanded", "true");
      const first = eqPanel.querySelector("select, input, button");
      if (first) first.focus();
    });
  }

  if (closeEqPanel && eqPanel) {
    closeEqPanel.addEventListener("click", () => {
      eqPanel.classList.remove("open");
      if (eqBtn) {
        eqBtn.setAttribute("aria-expanded", "false");
        eqBtn.focus();
      }
    });
  }

  // Escape closes whichever panel is open, returning focus to its opener.
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (eqPanel && eqPanel.classList.contains("open")) {
      eqPanel.classList.remove("open");
      if (eqBtn) { eqBtn.setAttribute("aria-expanded", "false"); eqBtn.focus(); }
    } else if (panel && panel.classList.contains("open")) {
      panel.classList.remove("open");
      if (gearBtn) { gearBtn.setAttribute("aria-expanded", "false"); gearBtn.focus(); }
    }
  });

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
      sendEqToContent(); // audible while dragging; persisted on release
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
  ssLog("popup DOMContentLoaded: initializing");
  ensurePresetOptions();
  initEvents();
  ssLog("popup UI events bound");
  loadPrefsAndTab().catch(e => ssLog("loadPrefsAndTab ERROR:", e && e.message));
  loadTabsList().catch(e => ssLog("loadTabsList ERROR:", e && e.message));

  // Poll audible tabs while popup is open (popup dies when closed).
  setInterval(() => {
    loadTabsList().catch(() => {});
  }, 3000);
});

window.addEventListener("unload", () => {
  // Do not dispose the engine when the popup closes.
  // The pinned engine tab keeps audio processing persistent.
});