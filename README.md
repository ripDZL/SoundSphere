<p align="center">
  <img src="logo.png" alt="SoundSphere logo" width="300">
</p>

# SoundSphere

SoundSphere is a Firefox extension that lets you push quiet tabs louder, shape the sound, and quickly see which tabs are actually making noise.

- Per-tab or global volume control
- Boost up to **800%**
- Voice and bass enhancement modes
- Optional **Experimental Overdrive** for extra punch (may distort)
- Clean, minimal UI with a built-in JetBrains Mono font
- No trackers, no analytics, nothing phoning home

---

## Features

### 🔊 Volume boost (up to 800%)

- Slider range: **0% → 800%**
- Anything above **600%** shows a warning:
  - 0–100%: normal range  
  - 100–600%: strong but generally usable  
  - 600–800%: “you’re on your own” zone – can clip or distort on some sites

Under the hood, the slider controls a Web Audio gain node. On sites that still have headroom, you’ll get a real loudness increase. On heavily limited/mastered sources, you’ll hit the ceiling sooner (see **Known limitations**).

### 🎛 Voice / Bass modes

Three EQ modes:

- **Default** – neutral, minimal shaping
- **Voice boost** – high-shelf boost to help speech cut through
- **Bass boost** – low-shelf lift for low-end heavy music

These modes affect the sound even when you’re not boosting volume, so you can use SoundSphere as a lightweight EQ.

### 🧪 Experimental Overdrive Mode

Overdrive adds a dynamics compressor in the chain to squeeze a bit more perceived loudness out of already hot audio:

- Makes quieter details more audible
- Can introduce noticeable distortion on very loud/limited material
- Intended as an **optional** “last resort” for quiet content

You can toggle Overdrive in:

- The popup’s settings panel
- The extension’s Options page (`about:addons` → SoundSphere → Preferences)

### 🧩 Tab awareness and badge

- The extension icon shows a **badge count** of how many tabs are currently audible.
- The popup lists all tabs that are playing audio:
  - Favicon
  - Shortened title
  - Click to jump to that tab

You can turn the badge off if you prefer a clean toolbar.

### 🧠 Smart defaults

Configurable via the popup settings panel and options page:

- Remember volume **per tab**, or use a single **global** volume
- Always start new tabs at **100%**
- Show or hide the badge count
- Enable/disable Experimental Overdrive

All settings are stored locally using `browser.storage.sync`.

### Known limitations

SoundSphere works best on normal HTML5 audio/video players: YouTube, embedded videos, simple audio players, etc.

Some sites use very complex Web Audio setups and heavy mastering/limiting:

SoundCloud

Bandcamp

Other custom WebAudio players

On those sites:

SoundSphere can successfully:

Mute audio

Change tone with Voice / Bass modes

Apply Overdrive’s compression flavor

But it may not give you a dramatic boost above “100%” perceived loudness because:

The audio is already mastered to be very loud,

Peaks are limited right up to digital 0 dBFS,

There’s very little headroom left to boost cleanly.

In other words: if a site is already smashing everything into a limiter, no extension can magically recover “more volume” without distortion.

If you need truly global, guaranteed loudness on everything, a system-level solution (like Equalizer APO, Voicemeeter, etc.) is still the more reliable option. SoundSphere is meant to be a convenient, per-tab, browser-side tool.

---
