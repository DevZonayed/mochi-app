#!/usr/bin/env bash
set -euo pipefail

CONFIG="${1:-release}"
APP_NAME="Maestro WebKit"
EXEC_NAME="MaestroWebKit"
VERSION="${MAESTRO_VERSION:-0.1.28}"
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
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

echo "> building React renderer for WebKit"
if [ ! -x "$REPO_ROOT/node_modules/.bin/vite" ]; then
  echo "Missing node_modules/.bin/vite. Run pnpm install from the repo root first."
  exit 1
fi
(cd "$REPO_ROOT/apps/desktop" && "$REPO_ROOT/node_modules/.bin/vite" build --config vite.web.config.ts --outDir "$ROOT/build/web" --emptyOutDir)

echo "> swift build -c $CONFIG (version $VERSION)"
swift build -c "$CONFIG" --package-path "$ROOT"

echo "> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"
cp "$BUILD_DIR/$EXEC_NAME" "$APP/Contents/MacOS/$EXEC_NAME"
cp -R "$ROOT/build/web/." "$APP/Contents/Resources/web/"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>Maestro</string>
  <key>CFBundleIdentifier</key><string>cloud.nexalance.maestro.webkit</string>
  <key>CFBundleExecutable</key><string>$EXEC_NAME</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSDesktopFolderUsageDescription</key><string>Maestro reads Desktop project folders you add so the local agent can show files, run tasks, and render chats.</string>
  <key>NSDocumentsFolderUsageDescription</key><string>Maestro reads project folders you add from Documents so the local agent can show files, run tasks, and render chats.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>Maestro reads project folders you add from Downloads so the local agent can show files, run tasks, and render chats.</string>
</dict>
</plist>
PLIST

SIDECAR="$ROOT/../sidecar"
echo "> building sidecar bundle"
node "$SIDECAR/build.mjs" --external-natives
RES_SC="$APP/Contents/Resources/sidecar"
mkdir -p "$RES_SC/bin" "$RES_SC/node_modules"
cp "$SIDECAR/dist/maestro-sidecar.mjs" "$RES_SC/maestro-sidecar.mjs"
cp "$SIDECAR/dist/send-hint-overlay.js" "$RES_SC/send-hint-overlay.js" 2>/dev/null || echo "  warning: send-hint-overlay.js missing from dist"
[ -d "$SIDECAR/dist/templates" ] && cp -R "$SIDECAR/dist/templates" "$RES_SC/templates" || echo "  warning: templates/ missing from dist"

echo "> embedding node runtime"
REAL_NODE="$(resolve_path "$(command -v node)")"
if [ -x "$REAL_NODE" ]; then
  cp "$REAL_NODE" "$RES_SC/bin/node" && chmod +x "$RES_SC/bin/node"
  echo "  embedded $(du -h "$RES_SC/bin/node" | cut -f1) node"
  NODE_LIB_DIR="$(cd "$(dirname "$REAL_NODE")/../lib" && pwd -P)"
  NODE_LIB="$(otool -L "$REAL_NODE" | sed -n 's#^[[:space:]]*@rpath/\(libnode[^[:space:]]*\).*#\1#p' | head -n 1)"
  if [ -n "$NODE_LIB" ] && [ -f "$NODE_LIB_DIR/$NODE_LIB" ]; then
    mkdir -p "$RES_SC/lib"
    cp "$NODE_LIB_DIR/$NODE_LIB" "$RES_SC/lib/$NODE_LIB"
    echo "  embedded $(du -h "$RES_SC/lib/$NODE_LIB" | cut -f1) $NODE_LIB"
  fi
else
  NODE_SZ=$(stat -f%z "$REAL_NODE" 2>/dev/null || echo 0)
  echo "  warning: system node is not executable ($((NODE_SZ/1024))K), not embeddable."
  echo "    Dev uses the system node unless MAESTRO_REQUIRE_EMBEDDED_NODE=1 is set."
  if [ "${MAESTRO_REQUIRE_EMBEDDED_NODE:-0}" = "1" ]; then
    exit 1
  fi
fi

echo "> embedding externalized native deps"
REPO_NM="$REPO_ROOT/node_modules"
node "$SIDECAR/embed-externals.mjs" "$REPO_NM" "$RES_SC/node_modules" \
  better-sqlite3 sharp jimp link-preview-js qrcode-terminal playwright-core fsevents

echo "> ad-hoc codesign"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "  (codesign skipped)"

echo "built $APP"
