# TODO

- Smoke test 1.3.1 before submitting (beta/ builds):
  - Chrome: YouTube, Spotify, Bandcamp; 100% sounds identical to off; drag slider right after opening popup (one capture, no double audio).
  - Firefox: YouTube, Bandcamp (boost after short reload), SoundCloud (boost not doubled), Spotify (volume + mute, rest greyed).
- Submit 1.3.1 to CWS and AMO using `Docs/STORE_SUBMISSION.md`.
- Manual Chrome: boost tab A, pick tab B in list, boost; close both; offscreen doc gone ~15 s later (chrome://inspect/#other).
- Manual Firefox: embedded SoundCloud widget on another site; autoplayed YouTube tab shows "Click the page once".
- Manual multi-window audible-tab focus test.
- Decide: per-tab vs per-site remembered volume.
- Optional hardening (needs real Firefox test): scope CORS rule beyond tab id (initiatorDomains/requestDomains).
