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
**Single purpose:** Adjust the volume (including boost above 100%) and equalization of audio playing in browser tabs.

**Permission justifications**
- `tabCapture`: Captures the audio of the tab the user is controlling so its volume and EQ can be changed. Started only after the user interacts with the popup.
- `offscreen`: Hosts the Web Audio graph that processes the captured tab audio and plays it back (reason USER_MEDIA). Closed automatically when no tab is being processed.
- `activeTab`: Grants capture of the tab the user opened the popup on.
- `tabs`: Lists tabs that are currently playing audio (title and icon in the popup) and switches to a tab when the user clicks it.
- `storage`: Saves the user's volume, EQ and option preferences.
- Host permission `<all_urls>`: Fallback audio control through a content script on pages where tab capture is unavailable; users play audio on arbitrary sites, so no fixed list is possible. No page data is read or transmitted.

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
