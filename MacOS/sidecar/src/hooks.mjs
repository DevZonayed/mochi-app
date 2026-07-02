// Synchronous module hooks (for module.registerHooks) that let Node run the brain's TypeScript
// directly in dev — no build step:
//   • resolve: alias the bare `electron` specifier → our headless electron-shim, and rewrite
//     NodeNext `./x.js` import specifiers → `./x.ts` when the .ts exists (the brain is authored
//     with `.js` specifiers expecting a tsc/vite build step).
//   • load: transpile every .ts via esbuild.transformSync. (Node's built-in type-stripping is
//     "strip-only" and rejects parameter properties / enums, which the brain uses — esbuild's
//     full transform handles them.)
// esbuild is already in the monorepo (a Vite dependency). The prod build uses esbuild→SEA.

import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { transformSync } from 'esbuild';

const SHIM = new URL('./electron-shim.ts', import.meta.url).href;

// The brain is authored for a bundler that provides the CJS globals __filename/__dirname/require.
// Running it as ESM, we synthesize them per-module from import.meta.url (prepended to the
// transpiled output; ESM hoists the import declarations).
const CJS_BANNER =
  "import{createRequire as __mcr}from'node:module';" +
  "import{fileURLToPath as __mfu}from'node:url';" +
  "const require=__mcr(import.meta.url);" +
  "const __filename=__mfu(import.meta.url);" +
  "const __dirname=__filename.slice(0,Math.max(0,__filename.lastIndexOf('/')));\n";

export function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: SHIM, shortCircuit: true };
  }
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const tsPath = resolvePath(dirname(parent), specifier.slice(0, -3) + '.ts');
    if (existsSync(tsPath)) {
      return { url: pathToFileURL(tsPath).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export function load(url, context, nextLoad) {
  // The brain imports JSON with NodeNext `resolveJsonModule` (no explicit import attribute);
  // serve it as a json module so Node doesn't demand a `with { type: 'json' }`.
  if (url.endsWith('.json')) {
    return { format: 'json', source: readFileSync(fileURLToPath(url), 'utf8'), shortCircuit: true };
  }
  if (url.endsWith('.ts') || url.endsWith('.mts') || url.endsWith('.cts')) {
    const filename = fileURLToPath(url);
    const src = readFileSync(filename, 'utf8');
    const { code } = transformSync(src, {
      loader: 'ts',
      format: 'esm',
      target: 'esnext',
      platform: 'node',
      sourcefile: filename,
    });
    return { format: 'module', source: CJS_BANNER + code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
