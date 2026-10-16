#!/usr/bin/env bash
# Builds Pixie (release, arm64) and assembles mac/dist/Pixie.app + mac/dist/Pixie-macOS-arm64.zip.
# Run from the repository root:   bash mac/scripts/package.sh
set -euo pipefail

ROOT="$(pwd)"
MAC="$ROOT/mac"
if [ ! -f "$MAC/Package.swift" ]; then
  echo "error: run this from the repository root (mac/Package.swift not found)" >&2
  exit 1
fi

DIST="$MAC/dist"
APP="$DIST/Pixie.app"

echo "==> swift build (release, arm64)"
swift build -c release --arch arm64 --package-path mac

BIN_DIR="$(swift build -c release --arch arm64 --package-path mac --show-bin-path)"
BIN="$BIN_DIR/Pixie"
if [ ! -x "$BIN" ]; then
  echo "error: built binary not found at $BIN" >&2
  exit 1
fi

echo "==> assembling $APP"
rm -rf "$APP" "$DIST/Pixie-macOS-arm64.zip"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Pixie"
cp "$MAC/Resources/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"
# SwiftPM resource bundles (none today, but copy any that appear).
for b in "$BIN_DIR"/*.bundle; do
  if [ -e "$b" ]; then
    cp -R "$b" "$APP/Contents/Resources/"
  fi
done

strip -x "$APP/Contents/MacOS/Pixie" || true

echo "==> ad-hoc codesign"
codesign --force --deep --options runtime -s - --entitlements mac/Pixie.entitlements "$APP"
codesign --verify --verbose=2 "$APP"

echo "==> zip"
ditto -c -k --keepParent "$APP" "$DIST/Pixie-macOS-arm64.zip"

du -sh "$APP" "$DIST/Pixie-macOS-arm64.zip"
echo "done: $DIST/Pixie-macOS-arm64.zip"
