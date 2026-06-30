// Bundle the headless brain into a single file with esbuild — the production path (the dev runner
// uses Node's loader hooks instead). Mirrors hooks.mjs: alias `electron` → the headless shim,
// rewrite NodeNext `./x.js` specifiers → `./x.ts`. esbuild transpiles the TS + inlines JSON.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const shim = path.join(here, 'src', 'electron-shim.ts');
mkdirSync(path.join(here, 'dist'), { recursive: true });

const maestroResolve = {
  name: 'maestro-resolve',
  setup(b) {
    b.onResolve({ filter: /^electron$/ }, () => ({ path: shim }));
    b.onResolve({ filter: /\.js$/ }, (args) => {
      if (args.kind === 'entry-point' || !args.path.startsWith('.')) return null;
      const ts = path.resolve(args.resolveDir, args.path.replace(/\.js$/, '.ts'));
      return existsSync(ts) ? { path: ts } : null;
    });
  },
};

const outfile = path.join(here, 'dist', 'maestro-sidecar.mjs');
const result = await build({
  entryPoints: [path.join(here, 'src', 'headless-main.ts')],
  outfile,
  bundle: true,
  plugins: [maestroResolve],
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Native addons + packages that load assets/addons relative to their own dir can't be inlined —
  // keep them external (copied as node_modules beside the bundle). `playwright-core` vendors
  // chromium-bidi inside its pre-built coreBundle.js — a `require("chromium-bidi/…")` esbuild
  // can't resolve since it isn't a real installed package — AND locates browser binaries relative
  // to its own dir, so it must stay external. `fsevents` is a macOS-only `.node` addon esbuild has
  // no loader for (pulled in as an optional transitive of a file-watcher).
  external: process.argv.includes('--external-natives')
    ? ['better-sqlite3', 'sharp', 'jimp', 'link-preview-js', 'qrcode-terminal', 'playwright-core', 'fsevents']
    : [],
  // Node's ESM `import.meta.url` is preserved; bare node: builtins stay external automatically.
  banner: { js: "import{createRequire as __cr}from'node:module';import{fileURLToPath as __ffu}from'node:url';const require=__cr(import.meta.url);const __filename=__ffu(import.meta.url);const __dirname=__filename.slice(0,Math.max(0,__filename.lastIndexOf('/')));" },
  logOverride: { 'require-resolve-not-external': 'silent' },
  metafile: true,
  legalComments: 'none',
});

const kb = (statSync(outfile).size / 1024).toFixed(0);
console.log(`✓ bundled → dist/maestro-sidecar.mjs (${kb} KB)`);
if (result.warnings.length) console.log(`  ${result.warnings.length} warning(s)`);

// Sibling runtime assets the brain reads relative to its own dir via `import.meta.url`
// (esbuild keeps import.meta.url pointing at the bundle, so these must sit BESIDE it — they
// can't be inlined). `send-hint-overlay.js` is read eagerly at module load (overlay.ts), so a
// missing copy crashes the sidecar at boot; the `templates/` dir backs project bootstrap. Emit
// them into dist/ so the bundle is self-contained (CI native-build + package-app.sh both copy it).
const brain = path.join(here, '..', '..', 'apps', 'desktop', 'electron');
for (const [src, dst] of [['browser/send-hint-overlay.js', 'send-hint-overlay.js'], ['templates', 'templates']]) {
  const from = path.join(brain, src);
  if (existsSync(from)) { cpSync(from, path.join(here, 'dist', dst), { recursive: true }); console.log(`  + ${dst}`); }
  else console.log(`  ⚠ missing sibling asset ${src}`);
}
