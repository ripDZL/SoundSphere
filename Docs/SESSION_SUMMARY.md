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
