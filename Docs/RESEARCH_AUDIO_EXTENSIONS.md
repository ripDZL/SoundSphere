# Research: Audio-Control Extensions

Date: 2026-07-13

## Primary API Findings

- Chrome `tabCapture` is the most reliable Chrome-only path for whole-tab audio processing: it requires the `tabCapture` permission and must be initiated after a user extension gesture, similar to `activeTab`. Source: https://developer.chrome.com/docs/extensions/reference/api/tabCapture
- Capturing tab audio mutes the tab's normal playback unless the extension replays the captured stream through an `AudioContext` to `audioContext.destination`. Source: https://developer.chrome.com/docs/extensions/reference/api/tabCapture#preserve_system_audio
- In Chrome 116+, a service worker can call `chrome.tabCapture.getMediaStreamId({ targetTabId })` after the user gesture, then pass the ID to an offscreen document, where `getUserMedia({ chromeMediaSource: "tab", chromeMediaSourceId })` consumes it. Source: https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture#record_audio_and_video_in_the_background
- `getMediaStreamId()` stream IDs are one-use and expire after a few seconds; design the flow as an immediate handoff, not a durable capability. Source: https://developer.chrome.com/docs/extensions/reference/api/tabCapture#getMediaStreamId
- Offscreen documents are the right MV3 home for Web Audio because service workers lack DOM/window and are ephemeral. Chrome explicitly recommends moving DOM/window work into offscreen documents. Source: https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers#move_dom_and_window_calls_to_an_offscreen_document
- Only one offscreen document can be open per extension profile, its URL must be bundled static HTML, and `AUDIO_PLAYBACK` offscreen documents close after 30 seconds without audio. Source: https://developer.chrome.com/docs/extensions/reference/api/offscreen
- MV3 service workers terminate when idle; do not keep audio graph state only in service-worker globals. Persist settings in `chrome.storage`, and let the offscreen document own live media tracks/nodes. Source: https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers#persist_states

## Chrome Architecture Implications

- Use a three-context model:
  - Popup/side panel: user controls and user gesture.
  - Service worker: active-tab lookup, offscreen lifecycle, stream ID handoff, settings persistence.
  - Offscreen document: `getUserMedia`, `AudioContext`, EQ/gain/compressor chain, replay to destination, cleanup.
- Minimum Chrome target should be `116+` if background tab capture via service worker/offscreen is core. Pre-116 required opening an extension page/tab to consume the stream ID. Source: https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture#record_audio_and_video_in_a_new_tab
- Treat capture as tab-scoped and stateful:
  - Stop tracks on tab close/switch.
  - Recreate the stream when the offscreen document disappears.
  - Handle `chrome.runtime.lastError` and offscreen "single document" races.
  - Surface Chrome's sharing/capture indicator as expected behavior; it cannot be hidden by extension UX.
- Audio graph pattern:
  - `MediaStreamAudioSourceNode -> EQ filters -> gain/compressor/limiter -> destination`.
  - Keep references to source/filter/gain nodes while active; older source examples note losing references can kill audio via garbage collection.
  - Use dB-to-linear conversion for UI values: `10 ** (db / 20)`.

## Firefox Constraints

- Firefox's WebExtension API surface differs from Chrome; MDN's browser API support list has no `tabCapture` entry, so a Chrome `tabCapture` design is not portable. Source: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Browser_support_for_JavaScript_APIs
- Firefox supports both `browser.*` and `chrome.*`, but promises/namespace behavior differs; use `browser.*` plus `webextension-polyfill` only for shared APIs. Source: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities
- Practical Firefox audio-control extensions use content-script/page media-element processing rather than whole-tab capture:
  - Find `video, audio`.
  - Use `AudioContext.createMediaElementSource(element)`.
  - Attach gain/pan/EQ nodes.
  - Expect failures on some sites because of cross-origin/media security boundaries.
- Firefox architecture should be a separate capability tier:
  - Tier 1: per-media-element Web Audio injection where allowed.
  - Tier 2: site-specific adapters for known pages with accessible media elements.
  - No promise of full-tab/DRM/system audio parity with Chrome.

## DRM / Protected Content Fallbacks

- Do not advertise DRM/protected-content boosting as guaranteed. The screen-capture spec allows user agents to omit audio, reject access for security/platform reasons, and mute/end tracks when surfaces become inaccessible. Source: https://www.w3.org/TR/screen-capture/#dom-mediadevices-getdisplaymedia
- `getDisplayMedia({ audio: true, video: true })` is a possible user-prompt fallback, but the spec allows returning video-only even when audio was requested and rejects audio-only display capture. Source: https://www.w3.org/TR/screen-capture/#dom-mediadevices-getdisplaymedia
- Product fallback order:
  - Chrome: `tabCapture` whole-tab processing.
  - Chrome fallback: `getDisplayMedia` with explicit user picker when `tabCapture` fails or policy blocks it.
  - Firefox: media-element injection where possible.
  - All browsers: clear "site/browser blocks processing here" state with unchanged pass-through audio.
- Never try to bypass DRM, EME, HDCP, site CSP, or cross-origin media restrictions. Treat silence, missing tracks, `NotAllowedError`, `NotReadableError`, `AbortError`, and inaccessible media elements as expected capability limits.

## Open-Source Source Patterns

- `chr108/chrome-tab-equalizer` is a recent MV3 example using `tabCapture` + offscreen:
  - Manifest requests `tabCapture`, `offscreen`, `storage`, `tabs`.
  - Service worker creates/locates `offscreen.html`, gets stream ID, sends `OFFSCREEN_START`.
  - Offscreen document consumes stream ID with `getUserMedia`, builds `AudioContext`, `BiquadFilterNode` EQ, `WaveShaperNode`, gain nodes, then connects to destination.
  - Last inspected commit: `805d404`, 2026-06-14.
  - Source: https://github.com/chr108/chrome-tab-equalizer
- `valpackett/soundfixer` is a Firefox-recommended open-source media-element approach:
  - Manifest V2, minimal permissions: `activeTab`, `webNavigation`.
  - Popup enumerates frames and injects code against `video, audio`.
  - Uses `AudioContext`, `createMediaElementSource`, `GainNode`, `StereoPannerNode`, channel splitter/merger.
  - UI explicitly reports "some websites do not work because of cross-domain security restrictions."
  - Source: https://github.com/valpackett/soundfixer/blob/e6ef72645c6b885866b97bc196092b7193572087/popup.js
- `piousdeer/chrome-volume-manager` is an older MV2 tab-capture pattern still useful as a reliability lesson:
  - Stores captured-tab promises to avoid races.
  - Keeps `streamSource` references to prevent audio graph collection.
  - Cleans up on `tabs.onRemoved`.
  - Source: https://github.com/piousdeer/chrome-volume-manager/blob/cf667e336fe4d15ea3519319a24f8718916794e2/src/background.ts

## Recommended Rewrite Direction

- Build Chrome first around MV3 `tabCapture` + offscreen Web Audio; this is the only researched path that supports full-tab audio processing reliably.
- Build Firefox as a constrained media-element processor, not as a feature-parity port.
- Model capture capability explicitly:
  - `wholeTabCapture`
  - `displayMediaCapture`
  - `mediaElementInjection`
  - `unsupportedProtectedContent`
- Keep processing graph browser-independent where possible: pure Web Audio graph builder accepts a source node and returns controls/cleanup.
- Keep browser adapters thin and separate:
  - `chromeTabCaptureAdapter`
  - `chromeDisplayMediaAdapter`
  - `firefoxMediaElementAdapter`
- UX must show current processing mode and blocked/fallback state. Avoid silent no-op sliders.
