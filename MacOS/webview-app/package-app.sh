#!/usr/bin/env bash
set -euo pipefail

CONFIG="${1:-release}"
# The product name shipped to users. Renaming here renames dist/<name>.app and
# the CFBundleName; the CFBundleIdentifier stays cloud.nexalance.maestro.webkit
# on purpose (keychain entries + TCC permissions are keyed by it).
APP_NAME="Mochlet"
EXEC_NAME="MaestroWebKit"
ROOT="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$ROOT/../.." && pwd)"
# Release version resolution (see resolve-version.sh): explicit MAESTRO_VERSION
# wins; else the nearest reachable mochlet-v* git tag; else 0.0.0-dev. Never a
# stale hardcoded release number — a plain `./package-app.sh release` derives it.
VERSION="$(bash "$ROOT/resolve-version.sh" "$REPO_ROOT")"
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

# The Maestro dev shell prepends a ~121-byte `node` shim that execs the INSTALLED
# app's bundled node. That target is unstable during packaging — `rm -rf "$APP"`
# below deletes the dist app's node mid-build — so every `node` / shebang call
# (vite, esbuild) would break. Pin a real, STANDALONE node to the FRONT of PATH.
#
# Crucially, the pinned node also becomes the node we EMBED, so it must be able to
# load this repo's COMPILED native addons (better-sqlite3 uses a NAN/ABI-specific
# `.node`; a Node whose NODE_MODULE_VERSION differs — e.g. Homebrew v26/ABI147 vs
# deps built for Node24/ABI137 — links & signs a bundle that can't `dlopen` at
# runtime). So a candidate is accepted ONLY if that exact node can resolve+load
# the repo-root better-sqlite3 and sharp and round-trip an in-memory SQLite DB.
node_is_real() { [ -x "$1" ] && [ "$(stat -f%z "$1" 2>/dev/null || echo 0)" -gt 1048576 ] && file -b "$1" 2>/dev/null | grep -q "Mach-O"; }

# ABI/loadability probe: does THIS node load the repo's compiled native deps?
ABI_PROBE_DIR="$(mktemp -d)"
ABI_PROBE="$ABI_PROBE_DIR/abi-probe.cjs"
cat > "$ABI_PROBE" <<'PROBE'
'use strict';
// Resolve from the repo root node_modules (hoisted), exactly where the sidecar's
// externalized native deps are copied from. Require + exercise both addons.
const { createRequire } = require('node:module');
const path = require('node:path');
const repoRoot = process.argv[2];
const req = createRequire(path.join(repoRoot, 'package.json'));
const Database = req('better-sqlite3');
const db = new Database(':memory:');
try { db.prepare('select sqlite_version() as v').get(); } finally { db.close(); }
req('sharp'); // loading the native binding is the failure point for a bad ABI
process.stdout.write(process.version + ' ABI' + process.versions.modules + '\n');
PROBE

pick_build_node() {
  local shell_node cand rp ver vinfo
  # `command -v node` is included first (the shim fails node_is_real and is
  # skipped; a real shell node would be tried). Then known standalone locations.
  shell_node="$(command -v node 2>/dev/null || true)"
  for cand in "$shell_node" /opt/homebrew/bin/node /usr/local/bin/node \
    "/Applications/Mochlet.app/Contents/Resources/sidecar/bin/node" \
    "/Applications/Maestro WebKit.app/Contents/Resources/sidecar/bin/node"; do
    [ -n "$cand" ] || continue
    rp="$(resolve_path "$cand" 2>/dev/null || true)"
    [ -n "$rp" ] || continue
    if ! node_is_real "$rp"; then
      # Not self-contained (the ~121B dev shim, or a dynamically-linked node too
      # small to embed standalone). Show its version/ABI when runnable, for truth.
      vinfo="$("$rp" -e 'process.stdout.write(process.version+" ABI"+process.versions.modules)' 2>/dev/null || echo 'not a runnable standalone node')"
      echo "  skip (not a self-contained standalone node): $cand ($vinfo)"
      continue
    fi
    if ver="$("$rp" "$ABI_PROBE" "$REPO_ROOT" 2>/dev/null)"; then
      export PATH="$(dirname "$rp"):$PATH"
      echo "> using ABI-compatible node for build: $rp ($ver)"
      return 0
    fi
    vinfo="$("$rp" -e 'process.stdout.write(process.version+" ABI"+process.versions.modules)' 2>/dev/null || echo 'unknown')"
    echo "  skip (cannot load repo native deps — better-sqlite3/sharp ABI mismatch): $rp ($vinfo)"
  done
  return 1
}

if ! pick_build_node; then
  rm -rf "$ABI_PROBE_DIR"
  echo "ERROR: no standalone Node found that can load this repo's compiled native modules" >&2
  echo "  (better-sqlite3 + sharp). Rebuild them under the Node you intend to ship — matching" >&2
  echo "  its NODE_MODULE_VERSION — e.g.  (cd \"$REPO_ROOT\" && npm rebuild better-sqlite3 sharp)" >&2
  echo "  with that Node active, or install a standalone Node whose ABI matches. Refusing to" >&2
  echo "  build a bundle whose embedded Node can't dlopen its native addons." >&2
  exit 1
fi
rm -rf "$ABI_PROBE_DIR"

echo "> building React renderer for WebKit"
if [ ! -x "$REPO_ROOT/node_modules/.bin/vite" ]; then
  echo "Missing node_modules/.bin/vite. Run pnpm install from the repo root first."
  exit 1
fi
(cd "$REPO_ROOT/MacOS" && "$REPO_ROOT/node_modules/.bin/vite" build --config vite.web.config.ts --outDir "$ROOT/build/web" --emptyOutDir)

echo "> swift build -c $CONFIG (version $VERSION)"
swift build -c "$CONFIG" --package-path "$ROOT"

echo "> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"
cp "$BUILD_DIR/$EXEC_NAME" "$APP/Contents/MacOS/$EXEC_NAME"
cp -R "$ROOT/build/web/." "$APP/Contents/Resources/web/"

# ── App icon ─────────────────────────────────────────────────────────────────
# Build AppIcon.icns from the master AppIcon.png (1254×1254). macOS wants a full
# iconset (each size @1x and @2x); sips downsamples the master into each slot and
# iconutil packs them. If the tools or source are missing we warn and continue so
# a dev build without the icon still succeeds.
ICON_SRC="$ROOT/AppIcon.png"
if [ -f "$ICON_SRC" ] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  echo "> generating AppIcon.icns"
  ICONSET="$(mktemp -d)/AppIcon.iconset"
  mkdir -p "$ICONSET"
  for spec in "16:16x16" "32:16x16@2x" "32:32x32" "64:32x32@2x" \
              "128:128x128" "256:128x128@2x" "256:256x256" "512:256x256@2x" \
              "512:512x512" "1024:512x512@2x"; do
    px="${spec%%:*}"; name="${spec#*:}"
    sips -z "$px" "$px" "$ICON_SRC" --out "$ICONSET/icon_$name.png" >/dev/null 2>&1
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" \
    && echo "  wrote $(du -h "$APP/Contents/Resources/AppIcon.icns" | cut -f1) AppIcon.icns" \
    || echo "  warning: iconutil failed — bundle will have no icon"
  rm -rf "$(dirname "$ICONSET")"
else
  echo "  warning: AppIcon.png or sips/iconutil missing — skipping app icon"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>Mochlet</string>
  <key>CFBundleIdentifier</key><string>cloud.nexalance.maestro.webkit</string>
  <key>CFBundleExecutable</key><string>$EXEC_NAME</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSDesktopFolderUsageDescription</key><string>Mochlet reads Desktop project folders you add so the local agent can show files, run tasks, and render chats.</string>
  <key>NSDocumentsFolderUsageDescription</key><string>Mochlet reads project folders you add from Documents so the local agent can show files, run tasks, and render chats.</string>
  <key>NSDownloadsFolderUsageDescription</key><string>Mochlet reads project folders you add from Downloads so the local agent can show files, run tasks, and render chats.</string>
</dict>
</plist>
PLIST

# Build-time verification: the version we just wrote MUST round-trip out of the
# bundle, because the sidecar reports it at runtime (env MAESTRO_VERSION, injected
# by the Swift launcher from this exact key). A mismatch here means health/feedback
# would report the wrong version — fail the build loudly rather than ship it.
if command -v plutil >/dev/null 2>&1; then
  PLIST_VERSION="$(plutil -extract CFBundleShortVersionString raw -o - "$APP/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$PLIST_VERSION" != "$VERSION" ]; then
    echo "  ERROR: Info.plist CFBundleShortVersionString ('$PLIST_VERSION') != build VERSION ('$VERSION')"
    exit 1
  fi
  echo "> verified Info.plist version = $PLIST_VERSION"
fi

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
# The Maestro dev shell prepends a ~121-byte `node` shim (execs the installed
# app's bundled node with ELECTRON_RUN_AS_NODE=1). Embedding that shim yields a
# non-self-contained bundle. Detect a too-small / non-Mach-O node and fall back
# to a real interpreter (installed app's bundled node, then common locations).
node_is_real() { [ -x "$1" ] && [ "$(stat -f%z "$1" 2>/dev/null || echo 0)" -gt 1048576 ] && file -b "$1" 2>/dev/null | grep -q "Mach-O"; }
if ! node_is_real "$REAL_NODE"; then
  echo "  note: '$REAL_NODE' looks like a shim/non-binary; searching for a real node"
  for cand in \
    "/Applications/Mochlet.app/Contents/Resources/sidecar/bin/node" \
    "/Applications/Maestro WebKit.app/Contents/Resources/sidecar/bin/node" \
    "/opt/homebrew/bin/node" \
    "/usr/local/bin/node"; do
    rp="$(resolve_path "$cand")"
    if node_is_real "$rp"; then REAL_NODE="$rp"; echo "  using $REAL_NODE"; break; fi
  done
fi
if [ -x "$REAL_NODE" ]; then
  cp "$REAL_NODE" "$RES_SC/bin/node" && chmod +x "$RES_SC/bin/node"
  echo "  embedded $(du -h "$RES_SC/bin/node" | cut -f1) node"
  # Some node builds dynamically link @rpath/libnode.dylib and need it copied
  # alongside; a self-contained (statically linked) node has no sibling lib/ dir,
  # so probe the dependency FIRST and only chase the lib dir when it's actually
  # referenced (the unconditional `cd ../lib` used to abort the build under -e).
  NODE_LIB="$(otool -L "$REAL_NODE" | sed -n 's#^[[:space:]]*@rpath/\(libnode[^[:space:]]*\).*#\1#p' | head -n 1)"
  if [ -n "$NODE_LIB" ]; then
    NODE_LIB_DIR="$(cd "$(dirname "$REAL_NODE")/../lib" 2>/dev/null && pwd -P || true)"
    if [ -n "$NODE_LIB_DIR" ] && [ -f "$NODE_LIB_DIR/$NODE_LIB" ]; then
      mkdir -p "$RES_SC/lib"
      cp "$NODE_LIB_DIR/$NODE_LIB" "$RES_SC/lib/$NODE_LIB"
      echo "  embedded $(du -h "$RES_SC/lib/$NODE_LIB" | cut -f1) $NODE_LIB"
    else
      echo "  warning: node references @rpath/$NODE_LIB but lib not found — bundle may not be self-contained"
    fi
  else
    echo "  node is self-contained (no @rpath/libnode dependency)"
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

# ── Pre-codesign native-module preflight ─────────────────────────────────────
# A signed bundle that embeds better-sqlite3 / sharp is still broken if their
# native `.node` addons can't LOAD inside the app's embedded Node (e.g. an
# `--ignore-scripts` install left `build/Release/better_sqlite3.node` absent).
# Run the APP'S OWN embedded node, resolve modules exactly as the sidecar does
# (from Contents/Resources/sidecar), require both native deps, and instantiate +
# close an in-memory SQLite DB. ANY failure exits nonzero so the build cannot
# claim success. The smoke script lives in a temp dir — never inside the bundle,
# so it is not shipped or signed. Prints only non-secret OK/version evidence.
echo "> preflight: embedded-node native module smoke (sharp + better-sqlite3)"
SMOKE_NODE="$RES_SC/bin/node"
if [ -x "$SMOKE_NODE" ]; then
  SMOKE_DIR="$(mktemp -d)"
  SMOKE_JS="$SMOKE_DIR/preflight.cjs"
  cat > "$SMOKE_JS" <<'SMOKE'
'use strict';
// Resolve modules from the sidecar Resources dir, identical to how
// maestro-sidecar.mjs resolves its externalized native deps at runtime.
const { createRequire } = require('node:module');
const path = require('node:path');
const base = process.argv[2];
const req = createRequire(path.join(base, 'maestro-sidecar.mjs'));

// better-sqlite3: require + instantiate an in-memory DB + trivial query + close.
const Database = req('better-sqlite3');
const db = new Database(':memory:');
try {
  const v = db.prepare('select sqlite_version() as v').get().v;
  console.log('  better-sqlite3 OK (sqlite ' + v + ')');
} finally {
  db.close();
}

// sharp: require loads the native binding (the failure point for a broken
// install); report its version as non-secret evidence.
const sharp = req('sharp');
const sv = (sharp.versions && sharp.versions.sharp) || 'unknown';
console.log('  sharp OK (v' + sv + ')');
SMOKE
  if "$SMOKE_NODE" "$SMOKE_JS" "$RES_SC"; then
    rm -rf "$SMOKE_DIR"
    echo "  preflight OK"
  else
    rm -rf "$SMOKE_DIR"
    echo "  ERROR: embedded-node native-module preflight FAILED — sharp/better-sqlite3 are not loadable in the bundle; refusing to sign a broken app." >&2
    exit 1
  fi
else
  echo "  warning: no embedded node at $SMOKE_NODE — skipping native preflight (dev/system-node build)"
fi

echo "> ad-hoc codesign"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || echo "  (codesign skipped)"

echo "built $APP"
