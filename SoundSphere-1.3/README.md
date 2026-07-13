# SoundSphere 1.3

## Architecture

- Chrome 116+:
  - MV3 service worker coordinates capture.
  - `chrome.tabCapture.getMediaStreamId()` captures the active tab after the extension popup gesture.
  - `offscreen.html` owns `getUserMedia()`, WebAudio nodes, active streams, and cleanup.
  - Each captured tab gets an independent graph: gain, quick mode, 10-band EQ, compressor, soft clip, output.
- Firefox:
  - Use `manifest.firefox.json` as `manifest.json` when packaging.
  - Firefox uses `content.js` because Firefox does not support Chrome's offscreen tab-capture path.
  - The content script tries media-element WebAudio, then page WebAudio tap, then basic 0-100 element volume.
- Fallback:
  - Protected or blocked playback stays stable.
  - If boost/EQ cannot attach, SoundSphere reports basic mode and clamps to 0-100 volume.

## Files

- `manifest.json` - Chrome MV3 package.
- `manifest.firefox.json` - Firefox MV3 package manifest.
- `background.js` - badge state, capture orchestration, backend selection.
- `offscreen.html`, `offscreen.js` - Chrome tab-capture WebAudio engine.
- `content.js` - Firefox and fallback page audio processor.
- `inject/webaudio_tap.js` - best-effort page WebAudio destination tap.
- `popup.html`, `popup.css`, `popup.js` - extension popup.
- `options.html`, `options.css`, `options.js` - persistent defaults.
- Per-tab remembered volume is stored in `storage.local` as `vol_tabs`; global fallback volume is stored in `storage.sync` as `vol_global`.

## Install

### Chrome

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose Load unpacked.
4. Select `SoundSphere-1.3`.

### Firefox

1. Copy `manifest.firefox.json` to `manifest.json` in a Firefox package copy.
2. Open `about:debugging#/runtime/this-firefox`.
3. Choose Load Temporary Add-on.
4. Select the copied `manifest.json`.

## Test

- YouTube: apply 200% volume, switch Voice/Bass, adjust EQ.
- Twitch: apply boost while a live stream is playing.
- Spotify Web: verify either whole-tab capture in Chrome or basic/protected mode in Firefox.
- Netflix/DRM: verify playback remains stable and the popup reports fallback/basic mode if processing is blocked.
- Multiple audible tabs: apply different volumes by selecting each tab in the popup list.
