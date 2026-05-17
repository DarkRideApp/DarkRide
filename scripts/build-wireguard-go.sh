#!/bin/bash
# Build wireguard-go and wg-uapi for Android architectures
# Requires: Go 1.20+ installed
#
# Usage: bash scripts/build-wireguard-go.sh
#
# Produces static binaries in data/apks/wg-binaries/:
#   wireguard-go-arm64-v8a    (userspace WireGuard)
#   wireguard-go-armeabi-v7a
#   wireguard-go-x86_64
#   wireguard-go-x86
#   wg-uapi-arm64-v8a         (UAPI config tool)
#   wg-uapi-armeabi-v7a
#   wg-uapi-x86_64
#   wg-uapi-x86

set -euo pipefail

REPO="https://git.zx2c4.com/wireguard-go"
OUT_DIR="data/apks/wg-binaries"
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPDIR_BASE=$(mktemp -d)

cleanup() { rm -rf "$TMPDIR_BASE"; }
trap cleanup EXIT

echo "Cloning wireguard-go..."
git clone --depth 1 "$REPO" "$TMPDIR_BASE/wireguard-go" 2>&1 | tail -1

cd "$TMPDIR_BASE/wireguard-go"

# Map Android ABI names to Go architecture names
declare -A GOARCH_MAP=(
  ["arm64-v8a"]="arm64"
  ["armeabi-v7a"]="arm"
  ["x86_64"]="amd64"
  ["x86"]="386"
)

mkdir -p "$PROJECT_ROOT/$OUT_DIR"

for abi in "${!GOARCH_MAP[@]}"; do
  arch="${GOARCH_MAP[$abi]}"
  out="$PROJECT_ROOT/$OUT_DIR/wireguard-go-${abi}"
  echo "Building wireguard-go for $abi (GOARCH=$arch)..."

  GOARM_ENV=""
  if [[ "$abi" == "armeabi-v7a" ]]; then
    GOARM_ENV="GOARM=7"
  fi

  env GOOS=linux GOARCH="$arch" CGO_ENABLED=0 $GOARM_ENV \
    go build -ldflags="-s -w" -o "$out" . 2>&1

  size=$(stat --printf="%s" "$out" 2>/dev/null || stat -f "%z" "$out" 2>/dev/null)
  echo "  -> $(basename "$out") ($(( size / 1024 )) KB)"
done

echo ""
echo "Building wg-uapi (UAPI config tool)..."

cd "$PROJECT_ROOT/tools/wg-uapi"

for abi in "${!GOARCH_MAP[@]}"; do
  arch="${GOARCH_MAP[$abi]}"
  out="$PROJECT_ROOT/$OUT_DIR/wg-uapi-${abi}"
  echo "Building wg-uapi for $abi (GOARCH=$arch)..."

  GOARM_ENV=""
  if [[ "$abi" == "armeabi-v7a" ]]; then
    GOARM_ENV="GOARM=7"
  fi

  env GOOS=linux GOARCH="$arch" CGO_ENABLED=0 $GOARM_ENV \
    go build -ldflags="-s -w" -o "$out" . 2>&1

  size=$(stat --printf="%s" "$out" 2>/dev/null || stat -f "%z" "$out" 2>/dev/null)
  echo "  -> $(basename "$out") ($(( size / 1024 )) KB)"
done

echo ""
echo "Done. Binaries in $OUT_DIR/:"
ls -lh "$PROJECT_ROOT/$OUT_DIR/wireguard-go-"* "$PROJECT_ROOT/$OUT_DIR/wg-uapi-"* 2>/dev/null | awk '{print "  " $NF " (" $5 ")"}'
