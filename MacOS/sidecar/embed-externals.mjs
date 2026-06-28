// Copy the full runtime dependency *closure* of the externalized packages into the packaged
// sidecar's node_modules. The esbuild bundle keeps a few packages external (native addons +
// asset-relative loaders — see build.mjs); those must resolve beside the bundle at runtime.
//
// Under pnpm's hoisted node-linker the transitive deps are laid out FLAT at the repo root
// (e.g. better-sqlite3 → bindings → file-uri-to-path; sharp → color/detect-libc/semver/@img/*),
// not nested inside each package — so a naive per-package copy silently drops them and the
// packaged app crashes at boot with MODULE_NOT_FOUND. Walking the dependency graph copies exactly
// what's needed (platform-specific optionals that aren't installed are skipped).
//
// usage: node embed-externals.mjs <rootNodeModules> <destNodeModules> <pkg...>
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const [, , rootNM, destNM, ...roots] = process.argv;
if (!rootNM || !destNM || roots.length === 0) {
  console.error('usage: embed-externals.mjs <rootNodeModules> <destNodeModules> <pkg...>');
  process.exit(1);
}
mkdirSync(destNM, { recursive: true });

const seen = new Set();
const missing = [];

function visit(name) {
  if (seen.has(name)) return;
  const src = path.join(rootNM, name);
  if (!existsSync(src)) { missing.push(name); return; } // platform-specific optional / not installed
  seen.add(name);
  const dest = path.join(destNM, name);
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: true }); // dereference: hoisted entries may be symlinks into .pnpm
  let pkg;
  try { pkg = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf8')); } catch { return; }
  const deps = { ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) };
  for (const d of Object.keys(deps)) visit(d);
}

for (const r of roots) visit(r);
console.log(`  embedded ${seen.size} packages (closure of ${roots.join(', ')})`);
if (missing.length) console.log(`  skipped ${missing.length} not-installed (platform-specific optionals, etc.)`);
