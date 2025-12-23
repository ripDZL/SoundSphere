<p align="center">
  <img src="logo.png" alt="SoundSphere logo" width="300">
</p>

# SoundSphere
**Per-tab volume booster + EQ for Firefox and Chrome.**  
Boost quiet tabs (up to **800%** when supported), shape sound with **Voice/Bass** modes and a **10-band EQ**, and quickly see which tabs are playing audio — all processed locally with **no tracking**.

---

## Install
- **Firefox (AMO):** https://addons.mozilla.org/en-US/firefox/addon/soundsphere/
- **Chrome (Web Store):** https://chromewebstore.google.com/detail/soundsphere/bmdclfobmjbikodcmbdhmfoadboimaln

---

---

## Features
### 🔊 Volume boost (up to 800%)
- Slider range: **0% → 800%**
  - **0%** = mute  
  - **100%** = original volume  
  - **100–600%** = strong boost, generally usable  
  - **600–800%** = “use at your own risk” (can clip/distort)

When supported by the site/player, SoundSphere routes audio through the Web Audio API and uses a gain stage to increase loudness.

### 🎛️ 10-band EQ + quick modes
- **Default** – neutral shaping  
- **Voice boost** – helps speech cut through videos/streams  
- **Bass boost** – adds low end for music/games  

The EQ and modes can be used even at 100% volume for tone shaping.

### 🔔 Audible tab list + optional badge
- Toolbar badge (optional) can show how many tabs are currently playing audio.
- Popup lists audible tabs with favicon + title.
- Click a tab to jump to it instantly.

### 💾 Smart settings
- Remember volume **per tab** or use one **global** volume
- Start new tabs at **100%**
- Toggle the audible tab **badge**
- Optional “Overdrive” style processing (if enabled in your build)

Settings are stored locally using Firefox storage (and may sync via `storage.sync` where available).

---

## Protected playback (DRM) note
Some services use **protected playback (DRM/EME/Widevine)** or audio pipelines that don’t allow browser-side processing via Web Audio.

When SoundSphere detects this (or when advanced processing can’t attach), it falls back to **Basic Mode** on that site:
- **Mute / unmute**
- **0–100% volume**
- A notice in the popup explaining why EQ/boost is unavailable

This keeps playback stable and avoids “controls move but nothing changes” behavior.

---

## Permissions & privacy
SoundSphere requests:
- **tabs / activeTab** – to show audible tabs, focus a selected tab, and message the active tab
- **storage** – to save settings and optional per-tab volume
- **Host access (`<all_urls>`)** – so it can run on the pages where *you* play audio (you can use SoundSphere on many different sites)

Privacy:
- No analytics, no telemetry, no tracking
- No remote scripts
- Audio processing happens locally in your browser

---
## License
MIT — see `LICENSE`.
