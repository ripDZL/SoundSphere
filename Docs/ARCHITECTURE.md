# Architecture

- Chrome:
  - `manifest.json`
  - `background.js` service worker
  - `offscreen.html` + `offscreen.js`
  - whole-tab audio via `chrome.tabCapture.getMediaStreamId`
  - one WebAudio graph per captured tab: gain -> mode -> 10x EQ -> compressor -> clip pre-gain (1/4) -> soft clip -> destination
  - background serializes apply/stop per tab (`runForTab`); offscreen drops superseded starts (`startTokens`)
  - status/stop never create the offscreen doc; doc closes 15 s after last capture ends
  - after whole-tab START succeeds, background sends `SS_CONTENT_RESET` (prevents double boost)
- Firefox:
  - `manifest.firefox.json`
  - `background.js` as background script
  - `content.js` media-element/page-WebAudio processor
  - passive until `SS_CONTENT_APPLY`; `SS_CONTENT_STATUS` never hooks
  - hooks only CORS-readable media (same-origin, blob:, data:, MediaStream, crossorigin attr) into a running AudioContext
  - late media hooked on capture-phase `play` (no MutationObserver)
  - basic mode scales relative to player volume, never above it; reset restores volume/mute
  - frame replies: media frames answer, top frame answers late, other frames stay silent
  - Firefox CORS unlock: on boost/EQ/mode with cross-origin non-CORS media, background adds DNR session rule
    (id = tabId, tabIds [tabId], resourceTypes media, set `Access-Control-Allow-Origin: *`), content first probes the URL with a
    detached muted CORS `<audio>` (metadata only); only if it loads does it reload the real element with
    `crossOrigin="anonymous"` (position/play kept), hooks after `loadedmetadata`; error/5 s timeout reverts; rule removed on tab close
- Shared UI:
  - `popup.*`
  - Voice/Bass/EQ locked (disabled + note) when status `canBoost` is false
  - `options.*`
- Firefox hidden players (`inject/media_main.js`, MAIN world, Spotify + SoundCloud only):
  - plain same-world wrapper on `HTMLMediaElement.prototype.play` records played elements (max 32)
  - controls only elements content.js cannot see (detached or in shadow DOM)
  - volume cut/mute on element; boost/EQ via page-world WebAudio when readable (not DRM; blob/same-origin/CORS)
  - managed elements: `volume` accessor stores page value, outputs page value x SoundSphere level (Spotify re-applies its own volume)
  - bridge: content -> page `SoundSphere/SS_MAIN_SETTINGS`; page -> content `SoundSphereMain/SS_MAIN_STATUS` {media, hooked, readable, drm}
- Messaging:
  - backgrounds accept control messages only from extension pages (`sender.url`)
  - tab messages time out after 2 s
- DSP (offscreen, content, tap):
  - compressor ratio 1 -> 4 over the first 6 dB of boost (avoids makeup-gain jump)
  - soft clip: identity |x| <= 0.85, tanh knee to 1.0, covers +12 dBFS
- Storage:
  - `vol_tabs`: tab-id volume map in `storage.local`; cleared on `runtime.onStartup` (tab ids reset per session)
  - `vol_global`: global fallback volume
  - `mode`, `eqGains`, `eqPreset`, `eqCustomGains`
  - `showBadge`, `rememberVolume`, `startAt100`, `overdrive`
- Fallback order:
  - Chrome whole-tab capture
  - media-element WebAudio
  - page WebAudio tap
  - basic 0-100 element volume
