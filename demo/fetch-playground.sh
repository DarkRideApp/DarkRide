#!/usr/bin/env bash
# Download the DarkRide Playground target APK from its GitHub Releases.
# The repo is private, so this uses `gh` (respects your auth) rather than curl.
#   demo/fetch-playground.sh            # latest release
#   demo/fetch-playground.sh v1.0       # a specific tag
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p assets
REPO="DarkRideApp/playground"
TAG="${1:-}"

command -v gh >/dev/null 2>&1 || { echo "gh (GitHub CLI) required for the private repo." >&2; exit 1; }

echo "Fetching Playground APK from $REPO (${TAG:-latest}) …"
if [ -n "$TAG" ]; then
  gh release download "$TAG" --repo "$REPO" --pattern '*.apk' --dir assets --clobber
else
  gh release download --repo "$REPO" --pattern '*.apk' --dir assets --clobber
fi

APK="$(ls -1 assets/*.apk 2>/dev/null | head -1 || true)"
[ -n "$APK" ] || { echo "No APK in the release yet — tag a release (push a v* tag) to trigger the build." >&2; exit 1; }
mv -f "$APK" assets/playground.apk
echo "✔ demo/assets/playground.apk ($(du -h assets/playground.apk | cut -f1))"
echo "Install on a device/emulator:  adb install demo/assets/playground.apk"
