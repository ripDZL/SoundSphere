// SoundSphere options.js — cross-browser (Firefox + Chrome)

const API = typeof browser !== 'undefined' ? browser : chrome;

document.addEventListener('DOMContentLoaded', () => {
  const showBadge = document.getElementById('showBadge');
  const rememberVolume = document.getElementById('rememberVolume');
  const startAt100 = document.getElementById('startAt100');
  const saveBtn = document.getElementById('save');
  const status = document.getElementById('status');

  function getAll(callback) {
    if (!API.storage || !API.storage.sync) {
      callback({});
      return;
    }
    API.storage.sync.get(null, (data) => callback(data || {}));
  }

  function setAll(obj, callback) {
    if (!API.storage || !API.storage.sync) {
      if (callback) callback();
      return;
    }
    API.storage.sync.set(obj, () => {
      if (callback) callback();
    });
  }

  getAll((data) => {
    const sb = data.prefs_showBadge;
    const rv = data.prefs_rememberVol;
    const s100 = data.prefs_start100;

    showBadge.checked = sb === undefined ? true : !!sb;
    rememberVolume.checked = rv === undefined ? true : !!rv;
    startAt100.checked = s100 === undefined ? false : !!s100;
  });

  saveBtn.addEventListener('click', () => {
    setAll({
      prefs_showBadge: !!showBadge.checked,
      prefs_rememberVol: !!rememberVolume.checked,
      prefs_start100: !!startAt100.checked
    }, () => {
      status.textContent = 'Settings saved!';
      setTimeout(() => {
        status.textContent = '';
      }, 2000);
    });
  });
});
