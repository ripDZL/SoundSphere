# SoundSphere 1.3 source

One source folder, two manifests. Build store packages with `tools/package-1.3.sh` (repo root); see the root `README.md` for install, test and permissions.

## Chrome (`manifest.json`, Chrome 116+; no host permissions or content scripts)
- `background.js`: service worker; per-tab apply queue, tab capture, offscreen lifecycle (closes 15 s after the last capture).
- `offscreen.html`, `offscreen.js`: WebAudio engine, one graph per captured tab: gain, mode, 10-band EQ, compressor, soft clip.
- Capture needs the activeTab grant from opening the popup on that tab; other tabs get "Click the SoundSphere icon while on this tab".

## Firefox (`manifest.firefox.json` → packaged as `manifest.json`, Firefox 140+)
- `background.firefox.js`: event page; per-tab apply queue, CORS header session rule (tab-scoped, media only).
- `content.js`: page media processor; hooks only CORS-readable media into a running AudioContext, otherwise 0-100% element volume.
- `inject/media_main.js`: page-world script on Spotify/SoundCloud for players kept off the page (detached or in shadow DOM).
- `inject/webaudio_tap.js`: best-effort tap for sites that play through their own WebAudio graph.

## Shared
- `popup.*`, `options.*`: UI. Voice/Bass/EQ are disabled when the page reports no processing path (e.g. DRM in Firefox).
- Storage: `vol_tabs` (storage.local, cleared at browser start), `vol_global`, `mode`, `eqGains`, `eqPreset`, `eqCustomGains`, `showBadge`, `rememberVolume`, `startAt100`, `overdrive` (storage.sync).

## Rules
- Neutral settings (100%, flat, Default) stay transparent.
- Opening the popup alone never captures or reroutes audio.
- Never reroute cross-origin media without CORS, or into a suspended AudioContext (both play silence).
- `content.js` never patches page prototypes; page-world code lives only in `inject/`.
