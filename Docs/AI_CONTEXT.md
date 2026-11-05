# AI Context

- Project: SoundSphere browser extension.
- Current milestone: SoundSphere 1.3.8 (popup locks Voice/Bass/EQ when no processing path; Spotify diagnostics removed).
- New package path: `SoundSphere-1.3/`.
- Chrome target: MV3, Chrome 116+, `tabCapture` + offscreen WebAudio.
- Firefox target: MV3 package manifest with content-script media processing fallback, Firefox 140+ for AMO data-consent support.
- Legacy release folders remain untouched.
- Research notes: `Docs/RESEARCH_AUDIO_EXTENSIONS.md`.
- Package: `tools/package-1.3.sh [outdir]` -> `SoundSphere-<ver>-chrome.zip` + `SoundSphere-<ver>-firefox.xpi`; CI writes to `beta/`.
- Tests: `node tests/1.3/test.js` (vm harness, 46 checks); CI runs it before packaging.
- Rule: own code only; reference add-ons (e.g. GPL '600% Sound Booster (Fixed)') are not copied — repo is MIT.
- Debug: `DEBUG_LOG` in content.js prints `[SoundSphere]` lines (CORS/off-DOM/backend changes); turn off before store submission.
- Limit: Widevine/DRM media (Spotify Web) cannot be routed through WebAudio in Firefox; 0-100% + mute only. Owner confirmed 1.3.7: volume works, EQ/Voice/Bass no effect (expected).
- Rule: popup disables Default/Voice/Bass + EQ controls whenever status `canBoost` is false, with a note (DRM text for `protected-basic`).
- Rule: content fallback never reroutes cross-origin media without CORS or into a non-running AudioContext (both = silence).
- Rule: neutral settings (100%, flat, default) stay transparent: compressor ratio 1, soft clip identity below 0.85.
- Rule: opening the popup alone must not capture or reroute audio.
- Rule: content.js must not patch page prototypes (exportFunction/wrappedJSObject). 1.3.3 did; Firefox pages stopped loading. Guard test enforces.
- Rule: page-world code lives only in `inject/media_main.js` (manifest `world: MAIN`), scoped to open.spotify.com + soundcloud.com; widen only after real-browser testing.
