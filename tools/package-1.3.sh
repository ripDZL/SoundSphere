#!/usr/bin/env bash
# Package SoundSphere-1.3 into store-ready archives.
#   Chrome : <out>/SoundSphere-<version>-chrome.zip  (manifest.json, offscreen engine)
#   Firefox: <out>/SoundSphere-<version>-firefox.xpi (manifest.firefox.json -> manifest.json)
# Both archives keep manifest.json at the archive root (required by AMO).
# Usage: tools/package-1.3.sh [output-dir]   (default: repo root)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/SoundSphere-1.3"
OUT="$(mkdir -p "${1:-$ROOT}" && cd "${1:-$ROOT}" && pwd)"
VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SRC/manifest.json")"
FF_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$SRC/manifest.firefox.json")"
if [ "$VERSION" != "$FF_VERSION" ]; then
  echo "Version mismatch: manifest.json=$VERSION manifest.firefox.json=$FF_VERSION" >&2
  exit 1
fi

SHARED=(content.js options.css options.html options.js popup.css popup.html popup.js icon fonts)
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Chrome
mkdir -p "$STAGE/chrome"
cp -r "${SHARED[@]/#/$SRC/}" "$STAGE/chrome/"
cp "$SRC/manifest.json" "$SRC/background.js" "$SRC/offscreen.html" "$SRC/offscreen.js" "$STAGE/chrome/"
mkdir -p "$STAGE/chrome/inject"
cp "$SRC/inject/webaudio_tap.js" "$STAGE/chrome/inject/"
rm -f "$OUT/SoundSphere-$VERSION-chrome.zip"
(cd "$STAGE/chrome" && zip -qrX "$OUT/SoundSphere-$VERSION-chrome.zip" . -x "*.DS_Store")

# Firefox
mkdir -p "$STAGE/firefox"
cp -r "${SHARED[@]/#/$SRC/}" "$STAGE/firefox/"
cp "$SRC/manifest.firefox.json" "$STAGE/firefox/manifest.json"
cp "$SRC/background.firefox.js" "$STAGE/firefox/"
mkdir -p "$STAGE/firefox/inject"
cp "$SRC/inject/webaudio_tap.js" "$SRC/inject/media_main.js" "$STAGE/firefox/inject/"
rm -f "$OUT/SoundSphere-$VERSION-firefox.xpi"
(cd "$STAGE/firefox" && zip -qrX "$OUT/SoundSphere-$VERSION-firefox.xpi" . -x "*.DS_Store")

echo "$OUT/SoundSphere-$VERSION-chrome.zip"
echo "$OUT/SoundSphere-$VERSION-firefox.xpi"
