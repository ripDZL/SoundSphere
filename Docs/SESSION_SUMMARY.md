# Session Summary

- Decision: Chrome reliability depends on MV3 `tabCapture` + offscreen document.
- Decision: Firefox remains content-script based because Chrome offscreen/tabCapture is not portable.
- Decision: keep legacy folders intact and add clean `SoundSphere-1.3/`.
- Constraint: DRM/protected playback is fallback-only; no bypass attempts.
- Deliverable: complete unpacked extension package at `SoundSphere-1.3/`.
- Fix: Bandcamp exposed an eager media-element hook; content fallback now starts only after background requests fallback control.
