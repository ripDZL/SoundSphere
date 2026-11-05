# Store submission — 1.3.1

Packages: `beta/SoundSphere-1.3.1-chrome.zip`, `beta/SoundSphere-1.3.1-firefox.xpi` (CI), or `bash tools/package-1.3.sh <dir>`.
Previous store version: 1.3.0 (both stores).

## Pre-submit checks (done 2026-11-04)
- Harness 49/49 (`node tests/1.3/test.js`).
- `web-ext lint` on the .xpi: 0 errors / 0 warnings / 0 notices.
- Chrome .zip loaded unpacked in Chromium: service worker starts, popup + options open with no errors.
- No remote code, eval, `new Function`, `innerHTML`, or network requests in any source file.
- Debug logging off (`DEBUG_LOG = false` in content.js and inject/media_main.js).
- Font license shipped: `fonts/OFL.txt` (JetBrains Mono, SIL OFL 1.1).
- Permission changes vs 1.3.0: Chrome none; Firefox adds `declarativeNetRequestWithHostAccess` (no extra install prompt; covered by existing host access).

## Release notes (both stores)
- Fixed: boost could double up or briefly play audio twice when moving the slider quickly (Chrome).
- Fixed: 100% with a flat EQ now sounds exactly like SoundSphere being off.
- Fixed: opening the popup no longer starts capturing the tab on its own.
- Fixed: hidden audio engine now closes when nothing is boosted (lower memory use, Chrome).
- Firefox: boost and EQ now work on Bandcamp, SoundCloud and other sites that stream audio from another domain.
- Firefox: Spotify volume and mute now work; EQ, Voice and Bass are greyed out there with an explanation (Firefox blocks extensions from processing DRM-protected audio).
- Remembered per-tab volumes no longer carry over to unrelated tabs after a browser restart.
- Accessibility: status updates announced to screen readers, keyboard focus kept in the tab list.

## Chrome Web Store dashboard
**Single purpose:** SoundSphere lets users control the audio of their browser tabs from the toolbar: see which tabs are playing audio and adjust a tab's volume (including boosting above 100%), mute and EQ.

**Permission justifications** (pasted into the dashboard for 1.3.1)
- `activeTab`: When the user opens the SoundSphere popup on a tab and changes a setting, activeTab grants access to that tab only, which chrome.tabCapture requires in order to capture the tab's audio for local volume and EQ processing. SoundSphere does nothing to the tab until the user moves a control.
- `offscreen`: SoundSphere uses an offscreen document to host a Web Audio graph that processes the captured tab audio (gain/boost, 10-band EQ, and dynamics compression). A service worker cannot run Web Audio or hold a MediaStream, so the offscreen document is required to apply the user's volume and EQ settings to the audio via chrome.tabCapture. It is closed automatically when no tab is being processed.
- `storage`: Saves the user's SoundSphere preferences: volume per tab, mode, EQ settings and options (badge, overdrive, remember volume). Stored with chrome.storage; if the user has Chrome sync turned on, Chrome may sync these preferences between the user's own devices. Nothing is sent to the developer or any third party.
- `tabCapture`: tabCapture is SoundSphere's main audio path in Chrome. After the user changes the volume, mode or EQ in the popup, it captures that tab's audio so the volume boost and 10-band EQ can be applied locally. This works on any site, including players where in-page volume control is unreliable or protected (for example Spotify Web). Audio is only processed and played back in real time; it is never recorded, saved or sent anywhere. No video or page content is captured, and capture ends when the tab is closed.
- `tabs`: Lists the tabs that are currently playing audio (title and favicon) in the popup and switches to a tab when the user clicks it, so the user can find and adjust a noisy tab.
- Host permission (`<all_urls>`, also the content script match): Users can play audio on any website, so no fixed list of sites is possible. The content script is SoundSphere's fallback audio controller for tabs where tab capture isn't available, for example a tab picked from SoundSphere's playing-tabs list instead of the tab the popup was opened on (activeTab covers only that tab). It stays passive until the user changes a setting in the popup, then adjusts only the page's own audio and video elements (volume, mute, and local Web Audio boost/EQ). It does not read page text or user data, makes no network requests, and nothing leaves the device.

**Remote code:** No, all code is in the package.

**Data usage:** collects none of the listed data types. Certify: not sold, not used for unrelated purposes, not used for creditworthiness.

**Privacy policy URL:** GitHub Pages URL of `privacy.html`.

## Firefox AMO — notes to reviewer
- No minified, bundled or generated code; the submitted files are the source. No build step besides copying files (`tools/package-1.3.sh`; Firefox manifest is `manifest.firefox.json` renamed to `manifest.json`).
- `declarativeNetRequestWithHostAccess`: when the user boosts a tab whose media comes from another origin without CORS headers (e.g. Bandcamp's CDN), Web Audio would only read silence. SoundSphere adds one session rule: `Access-Control-Allow-Origin: *` on responses with resourceType `media`, limited to that tab id. The rule is removed when the tab closes and session rules do not persist across restarts. The content script first test-loads the URL in CORS mode with a detached muted element and only reloads the site's player if that succeeds.
- `inject/media_main.js` (content script, `world: "MAIN"`, only on open.spotify.com and soundcloud.com): these players keep their `<audio>`/`<video>` outside the document, where the isolated content script cannot reach them. It wraps `HTMLMediaElement.prototype.play` to note played elements and adjusts volume/mute only on those detached elements; communicates with the content script by `window.postMessage`.
- `inject/webaudio_tap.js` (web-accessible, injected after the user applies settings): routes page Web Audio output through a gain/EQ chain for sites that play via Web Audio.
- `data_collection_permissions`: `none`. No network requests are made by the extension.
- Test: open a YouTube video, open the popup, move the slider above 100% and try Voice/Bass/EQ. Bandcamp: same on any album page (track reloads once, then boosts).

## Chrome Web Store listing — Overview (1.3.1)
Old listing (1.3.0) was wrong: claimed a `scripting` permission (not requested), "does not request broad host permissions" (manifest has `<all_urls>`), and a "Speech" preset (it's "Vocal").

```
SoundSphere: per-tab volume booster and 10-band equalizer

Boost quiet tabs up to 800%, shape the sound with Voice and Bass modes or a 10-band EQ, and see every tab that's playing audio. Each tab is controlled on its own, without touching your system volume, and all processing happens locally in your browser.

NEW IN 1.3.1
• 100% with a flat EQ now sounds exactly like SoundSphere being off
• Opening the popup no longer changes a tab's audio on its own
• Fixed audio that could double up when moving the slider quickly
• The audio engine shuts down when nothing is boosted, saving memory
• Remembered tab volumes no longer carry over to unrelated tabs after a browser restart
• Better screen reader and keyboard support

KEY FEATURES
• Volume from 0% to 800% per tab (600% max if you turn off overdrive)
• A soft limiter keeps boosted audio from clipping harshly
• Quick modes: Default, Voice (clearer speech), Bass (more low end)
• 10-band EQ (31 Hz to 16 kHz) with presets: Flat, Rock, Pop, Hip-Hop, Jazz, Classical, Electronic, Vocal, Live Clean, Bass Boost, Treble Boost, V-Shape, plus your own custom setting
• Keeps working when you switch tabs or windows
• Works on any site that plays audio, including streaming services with protected playback such as Spotify
• List of tabs playing audio with titles and icons; click one to jump to it
• Optional toolbar badge showing how many tabs are playing
• Remember volume per tab or use one global volume; option to start new tabs at 100%

HOW IT WORKS
1. Open the SoundSphere popup on the tab you want to adjust.
2. Move the slider, pick a mode or set the EQ. SoundSphere then captures that tab's audio and processes it locally.
Opening the popup alone changes nothing. If tab capture isn't available for a tab, SoundSphere controls the page's audio and video players directly instead; if a site blocks processing there, you get 0-100% volume and mute. Browser pages (such as chrome:// pages and the Chrome Web Store) can't be controlled.

PERMISSIONS EXPLAINED
• activeTab: works with the tab you open the popup on
• tabCapture: captures that tab's audio so volume and EQ can be applied locally
• offscreen: runs the hidden audio processor that Manifest V3 requires; it closes when no tab is being processed
• tabs: finds tabs that are playing audio and shows their titles and icons
• storage: saves your settings, EQ choices and volume preferences
• Access to all websites ("Read and change all your data on all websites"): lets the fallback audio controller run on whichever site you use SoundSphere on. It only looks at the page's audio and video players; nothing from the page is stored or sent anywhere.

PRIVACY
• All audio processing happens on your device; audio is never recorded or saved
• No analytics, tracking, ads or remote code
• SoundSphere makes no network requests; settings stay in your browser's storage
• Privacy policy: https://ripdzl.github.io/SoundSphere/privacy.html

Also available for Firefox: https://addons.mozilla.org/en-US/firefox/addon/soundsphere/

SAFETY NOTE
High boost levels can distort audio and may damage hearing or speakers. Start low, especially with headphones.
```
