# Session Summary

- Decision: Chrome reliability depends on MV3 `tabCapture` + offscreen document.
- Decision: Firefox remains content-script based because Chrome offscreen/tabCapture is not portable.
- Decision: Firefox minimum is 140.0 to satisfy AMO data-consent manifest lint.
- Decision: keep legacy folders intact and add clean `SoundSphere-1.3/`.
- Constraint: DRM/protected playback is fallback-only; no bypass attempts.
- Deliverable: complete unpacked extension package at `SoundSphere-1.3/`.
- Deliverable: Chrome archive `SoundSphere-1.3-chrome.zip`.
- Deliverable: Firefox archive `SoundSphere-1.3-firefox.zip`.
- Fix: Bandcamp exposed an eager media-element hook; content fallback now starts only after background requests fallback control.
- Audit: Firefox package passes AMO `web-ext lint` cleanly.
- Audit: package scan found no remote-code or dynamic string-execution patterns.

## 1.3.1 bug-fix pass (2026-11-04)

- State: fixes in `SoundSphere-1.3/`, version 1.3.1; not yet committed (owner commits via GitHub Desktop).
- Root causes fixed: concurrent capture starts, stacked fallback + capture, CORS/suspended-context silencing, non-transparent neutral DSP, stale tab-id volumes.
- Build/test: `node tests/1.3/test.js` 25/25; Firefox `web-ext lint` clean; packages via `tools/package-1.3.sh`.
- Unverified: real-browser audio (harness mocks WebAudio); needs manual ear test.
- Open decision: per-tab volume memory (1.3) vs earlier per-site `vol_hosts` design (1.1.1/1.2.1).
- Open tradeoff: Chrome keeps `<all_urls>` host permission + content script so list-switched tabs get fallback (tabCapture needs per-tab activeTab invocation).
- Next step: manual test matrix in `Docs/TODO.md`.

## 1.3.2 (2026-11-04)

- Report on 1.3.1 (Firefox): YouTube OK; Bandcamp mute only, no boost; Spotify no effect.
- Cause: Bandcamp media cross-origin without CORS (guard drops to basic); Spotify element not in DOM.
- Fix: CORS unlock (DNR session rule per tab + reload) and off-DOM tracking via `exportFunction` play() hook.
- Reference add-on studied only by listing (no public source, GPLv3); implementation is SoundSphere's own.
- Unverified in real Firefox: DNR header + CORS reload on Bandcamp; exportFunction hook on Spotify.
- Next step: manual Firefox test (Bandcamp boost, Spotify volume/mute, YouTube regression).

## 1.3.3 (2026-11-04)

- Bandcamp break hypothesis: failed CORS-mode reload fired `error` on the site's `<audio>`; player treated track as dead.
- Fix: probe first; real player only reloaded after probe loads metadata in CORS mode.
- Spotify: player created via `document.createElement`, kept detached (per spotitySpeedExtension, KDE D13878); now hooked at creation.
- Evidence needed if still failing: page console `[SoundSphere]` lines on Bandcamp/Spotify + background console (about:debugging > Inspect).

## 1.3.4 (2026-11-05)

- 1.3.3 report: plugin broken, websites did not load (Firefox).
- Only page-load-time change vs 1.3.1 was `installMediaHooks` (exportFunction wrappers on page prototypes); removed.
- Lost: Spotify detached-player support (back to no control on Spotify in Firefox).
- Kept: Bandcamp CORS probe + unlock (runs only after boost/EQ on cross-origin media).
- Failed approach: patching page `play()`/`createElement` from content script in Firefox. Do not retry without real-browser testing.
- Next step: real-Firefox verification (logs or live session) before any further Spotify work.

## 1.3.5 (2026-11-05)

- 1.3.4 confirmed: YouTube + Bandcamp work in Firefox; Spotify + SoundCloud no effect (players not in DOM).
- Approach: Firefox 128+ `world: "MAIN"` content script (no exportFunction bridge), limited to the two sites.
- Expected: Spotify 0-100% + mute (DRM); SoundCloud boost/EQ if its player uses blob:/CORS audio.
- Unverified in real Firefox. If Spotify/SoundCloud pages misbehave, remove the MAIN entry from manifest.firefox.json.
- Evidence if still no effect: page console line `[SoundSphere] hidden player found: ... | drm: ... | readable: ...`.
