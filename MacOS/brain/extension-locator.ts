/* Locate the unpacked Chrome extension folder on disk, both in dev and in
   packaged builds. At dev time we resolve the in-tree MacOS/extension/ folder;
   a packaged build may ship it under process.resourcesPath/extension.

   Why a locator (not a hard-coded path):
   - In packaged builds the folder lives at process.resourcesPath/extension —
     and on macOS that path has a space ("Maestro.app/Contents/Resources") which
     would break a naive concatenation.
   - In dev, we walk up from the calling module (the brain runs from MacOS/brain
     via the sidecar) looking for the sibling MacOS/extension/ source.
   - In `vitest` (no host app), we can be called from tests — return null
     instead of throwing so `extensionStatus()` keeps working.

   Used by:
   - localApi.ts `extensionPath` (UI shows the path in Settings → Browser ext)
   - localApi.ts `extensionRevealFolder` (Finder/Explorer "Load Unpacked" helper)
   - tests (verify we never resolve to a path that isn't there) */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface ExtensionLocation {
  /** Absolute path to the unpacked extension folder, if it exists on disk. */
  path: string | null;
  /** Where we found it — for the Settings UI tooltip + diagnostics. */
  source: 'packaged' | 'dev' | 'env-override' | 'not-found';
  /** True iff manifest.json is present at that path (Chrome won't load otherwise). */
  manifestPresent: boolean;
}

/** Cheap check — does this folder hold an MV3 manifest? */
function looksLikeExtensionDir(dir: string): boolean {
  return existsSync(join(dir, 'manifest.json'));
}

/** Resolve the extension folder. Returns `{ path: null, source: 'not-found' }` if nothing
    on disk matches — the caller (Settings UI) shows the right "not bundled" message. */
export function locateExtension(opts: {
  /** Pass `process.resourcesPath` (Electron) or undefined (tests). */
  resourcesPath?: string;
  /** Pass `__dirname` of the calling module (Electron main) or undefined (tests). */
  callerDir?: string;
  /** Pass `process.env` (or {} in tests). */
  env?: NodeJS.ProcessEnv;
} = {}): ExtensionLocation {
  const env = opts.env ?? process.env;

  // 1) Explicit override (operator points us at a different folder for dev).
  const override = env.MAESTRO_EXTENSION_DIR;
  if (override && override.trim()) {
    const abs = resolve(override.trim());
    return { path: abs, source: 'env-override', manifestPresent: looksLikeExtensionDir(abs) };
  }

  // 2) Packaged build: <resourcesPath>/extension/
  // process.resourcesPath is `…/Maestro.app/Contents/Resources` on mac,
  // `…/resources` on win/linux. Both are real, writable lookups.
  const fromResources = opts.resourcesPath ? join(opts.resourcesPath, 'extension') : null;
  if (fromResources && looksLikeExtensionDir(fromResources)) {
    return { path: fromResources, source: 'packaged', manifestPresent: true };
  }

  // 3) Dev (`npm run dev` in the sidecar): the brain runs from MacOS/brain via the
  // sidecar loader hooks — walk up from the caller looking for the sibling
  // MacOS/extension/ folder. We only walk up a few levels to avoid scanning the
  // whole disk if the layout ever changes.
  if (opts.callerDir) {
    let cur = opts.callerDir;
    for (let i = 0; i < 6; i++) {
      const candidate = join(cur, 'extension');
      if (looksLikeExtensionDir(candidate)) {
        return { path: candidate, source: 'dev', manifestPresent: true };
      }
      const parent = dirname(cur);
      if (parent === cur) break; // reached filesystem root
      cur = parent;
    }
  }

  // 4) Nothing found — give the UI enough context to say "no extension shipped"
  // without crashing.
  return { path: null, source: 'not-found', manifestPresent: false };
}
