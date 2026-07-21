#!/usr/bin/env bash
# Convert a recorded webm into a web-ready MP4 and an optimized GIF.
# Usage: demo/to-gif.sh demo/out/hero.webm [fps] [width]
set -euo pipefail

IN="${1:?usage: to-gif.sh <input.webm> [fps=15] [width=960]}"
FPS="${2:-15}"
WIDTH="${3:-960}"
BASE="${IN%.*}"

# 1) MP4 (H.264) — the primary hero asset: small, crisp, loops in a <video>.
ffmpeg -y -i "$IN" \
  -movflags +faststart -pix_fmt yuv420p \
  -vf "scale=${WIDTH}:-2:flags=lanczos" \
  -c:v libx264 -crf 23 -preset veryslow -an \
  "${BASE}.mp4"

# 2) Optimized GIF — two-pass palettegen/paletteuse for clean colors + small size.
PALETTE="$(mktemp --suffix=.png)"
ffmpeg -y -i "$IN" -vf "fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,palettegen=stats_mode=diff" "$PALETTE"
ffmpeg -y -i "$IN" -i "$PALETTE" \
  -lavfi "fps=${FPS},scale=${WIDTH}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" \
  "${BASE}.gif"
rm -f "$PALETTE"

echo
echo "✔ ${BASE}.mp4  ($(du -h "${BASE}.mp4" | cut -f1))"
echo "✔ ${BASE}.gif  ($(du -h "${BASE}.gif" | cut -f1))"
