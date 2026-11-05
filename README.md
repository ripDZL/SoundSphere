<p align="center">
  <img src="logo.png" alt="SoundSphere logo" width="300">
</p>

# SoundSphere
**Per-tab volume booster + EQ for Chrome and Firefox.**  
Boost quiet tabs up to **800%**, shape sound with **Voice/Bass** modes and a **10-band EQ**, and see which tabs are playing audio. Everything is processed locally, with **no tracking**.

Current version: **1.3.1**

---

## Install
- **Firefox (AMO):** https://addons.mozilla.org/en-US/firefox/addon/soundsphere/
- **Chrome (Web Store):** https://chromewebstore.google.com/detail/soundsphere/bmdclfobmjbikodcmbdhmfoadboimaln

---

## Features
### 🔊 Volume boost (up to 800%)
- **0%** = mute
- **100%** = original volume (SoundSphere is transparent at 100% with a flat EQ)
- **100–600%** = strong boost, generally usable
- **600–800%** = overdrive, can distort (can be turned off in Settings)

A soft limiter keeps boosted audio from hard-clipping.

### 🎛️ 10-band EQ + quick modes
- **Default**: neutral
- **Voice**: helps speech cut through videos and streams
- **Bass**: adds low end for music and games
- 12 EQ presets plus custom bands; works at any volume, including 100%

### 🔔 Playing-tab list + badge
- Popup lists tabs that are playing audio; click one to jump to it
- Optional toolbar badge with the number of playing tabs

### 💾 Settings
- Remember volume per tab, or use one global volume
- Start new tabs at 100%
- Allow or block 800% overdrive

---

## How it works
- **Chrome:** captures the tab you're on (after you use the popup) and processes it in a hidden audio page. Works on any site that plays audio, including protected services such as Spotify, without any access to website data. To adjust a tab from the playing-tabs list, switch to it and click the SoundSphere icon.
- **Firefox:** Firefox has no tab capture for extensions, so SoundSphere processes the page's own `<audio>`/`<video>` elements. When a site serves audio from another domain without CORS headers (e.g. Bandcamp), SoundSphere briefly reloads the track with CORS allowed for that tab so it can be boosted.

### Protected (DRM) audio in Firefox
Firefox does not let extensions process DRM-protected audio (Widevine/EME, e.g. Spotify Web). On those sites SoundSphere offers **volume 0–100% and mute**; boost, EQ and Voice/Bass are greyed out in the popup with a short explanation. In Chrome, these sites work fully.

---

## Permissions & privacy
| Permission | Why |
|---|---|
| `activeTab`, `tabs` | Control the tab you pick; list tabs playing audio |
| `storage` | Save your settings |
| Access to all websites (Firefox) | Adjust the page's audio and video players on whichever site you use it on |
| `tabCapture`, `offscreen` (Chrome) | Process the tab's audio locally; Chrome needs no website access |
| `declarativeNetRequestWithHostAccess` (Firefox) | Add a CORS header to media in a boosted tab only, so cross-domain audio can be processed; removed when the tab closes |

- No analytics, telemetry, ads or remote code
- Audio never leaves your browser
- Full policy: [privacy.html](privacy.html)

---

## Development
```
SoundSphere-1.3/          extension source (shared by both browsers)
  manifest.json           Chrome (MV3, Chrome 116+)
  manifest.firefox.json   Firefox (MV3, Firefox 140+, Android 142+)
tests/1.3/                regression harness (Node, no dependencies)
tools/package-1.3.sh      builds the store packages
beta/                     latest CI build (Chrome .zip + Firefox .xpi)
store-assets/             icons for store listings (not packaged)
Docs/                     project notes and store submission notes
```

- **Test:** `node tests/1.3/test.js`
- **Package:** `bash tools/package-1.3.sh <out-dir>` → `SoundSphere-<version>-chrome.zip` and `SoundSphere-<version>-firefox.xpi`
- **Load in Chrome:** `chrome://extensions` → Developer mode → Load unpacked → `SoundSphere-1.3/`
- **Load in Firefox:** `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → the `.xpi` from `beta/`

CI runs the tests and publishes fresh builds to `beta/` on every push to `main`.

---

## License
MIT — see `LICENSE`. JetBrains Mono font: SIL Open Font License 1.1 (`SoundSphere-1.3/fonts/OFL.txt`).
