/*
  SoundSphere — Options page

  Straightforward preferences wiring:
  - Load defaults from storage
  - Reflect them in the UI
  - Save changes back to storage

  All settings are local to the extension. No remote calls.
*/

(() => {
  const DEFAULTS = {
    showBadge: true,
    rememberVolume: true,
    startAt100: false,
    overdrive: false,
    spotifyExperimental: false
  };

  const $ = (id) => document.getElementById(id);

  function setStatus(message) {
    const el = $("status");
    if (!el) return;

    el.textContent = message || "";
    if (!message) return;

    window.setTimeout(() => {
      // Don't clobber a newer message.
      if (el.textContent === message) el.textContent = "";
    }, 1600);
  }

  function readPrefs() {
    chrome.storage.sync.get(DEFAULTS, (data) => {
      const prefs = { ...DEFAULTS, ...(data || {}) };

      const showBadge = $("showBadge");
      const rememberVolume = $("rememberVolume");
      const startAt100 = $("startAt100");
      const overdrive = $("overdrive");
      const spotifyExperimental = $("spotifyExperimental");

      if (showBadge) showBadge.checked = !!prefs.showBadge;
      if (rememberVolume) rememberVolume.checked = !!prefs.rememberVolume;
      if (startAt100) startAt100.checked = !!prefs.startAt100;
      if (overdrive) overdrive.checked = !!prefs.overdrive;
      if (spotifyExperimental)
        spotifyExperimental.checked = !!prefs.spotifyExperimental;
    });
  }

  function writePrefs() {
    const showBadge = $("showBadge");
    const rememberVolume = $("rememberVolume");
    const startAt100 = $("startAt100");
    const overdrive = $("overdrive");
    const spotifyExperimental = $("spotifyExperimental");

    const prefs = {
      showBadge: !!showBadge?.checked,
      rememberVolume: !!rememberVolume?.checked,
      startAt100: !!startAt100?.checked,
      overdrive: !!overdrive?.checked,
      spotifyExperimental: !!spotifyExperimental?.checked
    };

    chrome.storage.sync.set(prefs, () => setStatus("Settings saved"));
  }

  document.addEventListener("DOMContentLoaded", () => {
    readPrefs();
    $("save")?.addEventListener("click", writePrefs);
  });
})();
