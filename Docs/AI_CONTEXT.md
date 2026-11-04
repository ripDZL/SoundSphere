# AI Context

- Project: SoundSphere browser extension.
- Current milestone: SoundSphere 1.3.1 (bug-fix pass on 1.3).
- New package path: `SoundSphere-1.3/`.
- Chrome target: MV3, Chrome 116+, `tabCapture` + offscreen WebAudio.
- Firefox target: MV3 package manifest with content-script media processing fallback, Firefox 140+ for AMO data-consent support.
- Legacy release folders remain untouched.
- Research notes: `Docs/RESEARCH_AUDIO_EXTENSIONS.md`.
- Package: `tools/package-1.3.sh [outdir]` -> `SoundSphere-<ver>-chrome.zip` + `SoundSphere-<ver>-firefox.xpi`; CI writes to `beta/`.
- Tests: `node tests/1.3/test.js` (vm harness, 25 checks); CI runs it before packaging.
- Rule: content fallback never reroutes cross-origin media without CORS or into a non-running AudioContext (both = silence).
- Rule: neutral settings (100%, flat, default) stay transparent: compressor ratio 1, soft clip identity below 0.85.
- Rule: opening the popup alone must not capture or reroute audio.
