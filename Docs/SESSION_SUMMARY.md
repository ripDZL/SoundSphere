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
