import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { locateExtension } from './extension-locator.js';

/* The locator runs in three contexts:
   - packaged Electron app    → process.resourcesPath/extension/
   - `pnpm dev` Electron      → walks up from main.js to apps/desktop/extension/
   - vitest                   → both inputs undefined; returns 'not-found' cleanly
   We test all three and an env-override path the operator can use to point at
   any folder on disk (handy for hacking on the extension out-of-tree). */

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ext-locator-')); });
afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

function seedExtension(dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), '{ "manifest_version": 3, "name": "Mochi", "version": "0.1.0" }', 'utf8');
}

describe('locateExtension', () => {
  it('returns "not-found" when given no hints AND no env override', () => {
    const loc = locateExtension({ env: {} });
    expect(loc.path).toBeNull();
    expect(loc.source).toBe('not-found');
    expect(loc.manifestPresent).toBe(false);
  });

  it('finds the packaged extension at <resourcesPath>/extension/', () => {
    const resources = root;
    seedExtension(join(resources, 'extension'));

    const loc = locateExtension({ resourcesPath: resources, env: {} });
    expect(loc.source).toBe('packaged');
    expect(loc.path).toBe(join(resources, 'extension'));
    expect(loc.manifestPresent).toBe(true);
  });

  it('reports manifestPresent=false when resourcesPath has an "extension" folder WITHOUT a manifest', () => {
    // electron-builder dropped the folder shell but the filter excluded the
    // contents — the UI should surface this so the user knows it's broken.
    mkdirSync(join(root, 'extension'), { recursive: true });
    const loc = locateExtension({ resourcesPath: root, env: {} });
    // Folder without a manifest doesn't match "packaged" — falls through to not-found.
    expect(loc.source).toBe('not-found');
    expect(loc.manifestPresent).toBe(false);
  });

  it('walks up from callerDir to find the in-tree extension/ in dev', () => {
    // Simulate: apps/desktop/dist-electron/main.js. Walk up to apps/desktop/extension/.
    seedExtension(join(root, 'extension'));
    const callerDir = join(root, 'dist-electron');
    mkdirSync(callerDir, { recursive: true });

    const loc = locateExtension({ callerDir, env: {} });
    expect(loc.source).toBe('dev');
    expect(loc.path).toBe(join(root, 'extension'));
    expect(loc.manifestPresent).toBe(true);
  });

  it('honors the MAESTRO_EXTENSION_DIR env override above anything else', () => {
    seedExtension(join(root, 'overridden'));
    const loc = locateExtension({
      // Packaged path also exists — override wins.
      resourcesPath: root,
      env: { MAESTRO_EXTENSION_DIR: join(root, 'overridden') },
    });
    expect(loc.source).toBe('env-override');
    expect(loc.path).toBe(join(root, 'overridden'));
    expect(loc.manifestPresent).toBe(true);
  });

  it('reports manifestPresent=false on an env-override path that has no manifest', () => {
    mkdirSync(join(root, 'empty-override'), { recursive: true });
    const loc = locateExtension({ env: { MAESTRO_EXTENSION_DIR: join(root, 'empty-override') } });
    expect(loc.source).toBe('env-override');
    expect(loc.path).toBe(join(root, 'empty-override'));
    expect(loc.manifestPresent).toBe(false);
  });
});
