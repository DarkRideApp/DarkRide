#!/usr/bin/env bash
# Download the Allsafe demo target APK (deliberately-vulnerable Android app).
# Kept out of git (binary); fetch on demand.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p assets
VER="v.1.6"
URL="https://github.com/t0thkr1s/allsafe-android/releases/download/${VER}/allsafe.apk"
echo "Fetching Allsafe ${VER} …"
curl -fsSL -o assets/allsafe.apk "$URL"
echo "✔ demo/assets/allsafe.apk ($(du -h assets/allsafe.apk | cut -f1))"
echo "Install on a connected device/emulator:  adb install demo/assets/allsafe.apk"
