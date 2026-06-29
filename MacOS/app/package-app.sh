#!/usr/bin/env bash
# Assemble a distributable Maestro.app from the SwiftPM build.
# P0: bundles the app binary + Info.plist + ad-hoc codesign. The headless sidecar runs from
# the repo during dev; production embedding of the Node SEA binary (Resources/maestro-sidecar)
# + notarization is wired in P5 (see docs/superpowers/specs §6). Run from MacOS/app/.
set -euo pipefail

CONFIG="${1:-release}"
APP_NAME="Maestro"
VERSION="${MAESTRO_VERSION:-0.1.28}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$ROOT/.build/$CONFIG"
OUT="$ROOT/dist"
APP="$OUT/$APP_NAME.app"

resolve_path() {
  local target="$1"
  local dir

  while [ -L "$target" ]; do
    dir="$(cd "$(dirname "$target")" && pwd -P)"
    target="$(readlink "$target")"
    [[ "$target" = /* ]] || target="$dir/$target"
  done

  dir="$(cd "$(dirname "$target")" && pwd -P)"
  printf '%s/%s\n' "$dir" "$(basename "$target")"
}

echo "▸ swift build -c $CONFIG (version $VERSION)"
swift build -c "$CONFIG" --package-path "$ROOT"

echo "▸ assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD_DIR/$APP_NAME" "$APP/Contents/MacOS/$APP_NAME"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>cloud.nexalance.maestro</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
</dict>
</plist>
PLIST

# Embed the headless sidecar: an esbuild bundle of the whole brain run by an embedded node, plus
# the externalized native deps. Self-contained — the packaged app needs neither the repo nor a
# system node. (A future SEA single-binary at sidecar/dist/maestro-sidecar would be preferred by
# the supervisor if present.)
SIDECAR="$ROOT/../sidecar"
echo "▸ building sidecar bundle (esbuild)"
node "$SIDECAR/build.mjs" --external-natives
RES_SC="$APP/Contents/Resources/sidecar"
mkdir -p "$RES_SC/bin" "$RES_SC/node_modules"
cp "$SIDECAR/dist/maestro-sidecar.mjs" "$RES_SC/maestro-sidecar.mjs"

echo "▸ embedding node runtime"
REAL_NODE="$(resolve_path "$(command -v node)")"
NODE_SZ=$(stat -f%z "$REAL_NODE" 2>/dev/null || echo 0)
if [ "$NODE_SZ" -gt 5000000 ]; then
  cp "$REAL_NODE" "$RES_SC/bin/node" && chmod +x "$RES_SC/bin/node"
  echo "  embedded $(du -h "$RES_SC/bin/node" | cut -f1) node"
else
  echo "  ⚠ system node is a relocated/wrapper binary ($((NODE_SZ/1024))K), not embeddable."
  echo "    Ship the official Node binary from nodejs.org/dist (~90MB) here, OR fetch it on"
  echo "    first run into userData (like the Claude/Codex engines). Dev uses the system node."
  if [ "${MAESTRO_REQUIRE_EMBEDDED_NODE:-0}" = "1" ]; then
    echo "    MAESTRO_REQUIRE_EMBEDDED_NODE=1 is set; refusing to publish a non-self-contained app."
    exit 1
  fi
fi

echo "▸ embedding externalized native deps (full dependency closure)"
REPO_NM="$ROOT/../../node_modules"
# Copy the FULL dependency closure of the externalized packages, not just the top-level names.
# Under pnpm's hoisted node-linker the transitive deps are laid out FLAT at the repo root
# (better-sqlite3→bindings→file-uri-to-path, sharp→color/detect-libc/semver/@img/*), so a
# per-package copy silently drops them and the packaged sidecar crashes at boot (MODULE_NOT_FOUND).
# playwright-core is kept external (see sidecar/build.mjs) and powers the native
# per-project browser — embed its closure so the packaged sidecar can import it at
# runtime. fsevents is the macOS-only file-watcher addon (optional; tiny).
node "$SIDECAR/embed-externals.mjs" "$REPO_NM" "$RES_SC/node_modules" \
  better-sqlite3 sharp jimp link-preview-js qrcode-terminal playwright-core fsevents

echo "▸ ad-hoc codesign"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "  (codesign skipped)"

echo "✓ built $APP"
