document.addEventListener("DOMContentLoaded", () => {
  const showBadge = document.getElementById("showBadge");
  const rememberVolume = document.getElementById("rememberVolume");
  const startAt100 = document.getElementById("startAt100");
  const overdrive = document.getElementById("overdrive");
  const saveBtn = document.getElementById("save");
  const status = document.getElementById("status");

  const defaults = {
    showBadge: true,
    rememberVolume: true,
    startAt100: false,
    overdrive: false
  };

  chrome.storage.sync.get(defaults, prefs => {
    showBadge.checked = !!prefs.showBadge;
    rememberVolume.checked = !!prefs.rememberVolume;
    startAt100.checked = !!prefs.startAt100;
    overdrive.checked = !!prefs.overdrive;
  });

  saveBtn.addEventListener("click", () => {
    chrome.storage.sync.set(
      {
        showBadge: showBadge.checked,
        rememberVolume: rememberVolume.checked,
        startAt100: startAt100.checked,
        overdrive: overdrive.checked
      },
      () => {
        status.textContent = "Settings saved";
        setTimeout(() => {
          status.textContent = "";
        }, 2000);
      }
    );
  });
});
