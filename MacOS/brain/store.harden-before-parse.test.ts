/* Proves the store is hardened to 0600 BEFORE it is parsed — not merely as a
   side effect of the load()-catch fallback save() rewriting the file.

   Fault injection: renameSync is mocked to fail for the store target ONLY, so the
   fallback save() can NEVER replace the malformed file. The only thing that can
   still clamp the ORIGINAL malformed file is the harden-before-parse step in
   load(). If hardenStoreFile is moved back after JSON.parse, the parse throws
   first, the harden never runs, and the file stays 0644 → this test fails.

   This mock lives in its own file (vi.mock is file-scoped) so the real
   renameSync-backed atomic-write tests in store.perms.test.ts are unaffected.
   No secret values are read or logged — only the file mode is asserted. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync, statSync, chmodSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-harden-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' } }));

// Break ONLY the store's atomic rename (…/maestro-store.json); everything else
// (WaStore's own renames, all other fs calls) uses the real implementation.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    renameSync: (from: string, to: string, ...rest: unknown[]) => {
      if (typeof to === 'string' && to.endsWith('maestro-store.json')) throw new Error('injected rename failure');
      return (actual.renameSync as (...a: unknown[]) => void)(from, to, ...rest);
    },
  };
});

import { Store } from './store.js';

const storeFile = () => join(hoisted.dir, 'maestro-store.json');
const mode = (f: string) => statSync(f).mode & 0o777;

describe('Store hardens the target BEFORE parsing (fault-injected save)', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('clamps a malformed 0644 store to 0600 even when the fallback save cannot rewrite it', () => {
    mkdirSync(hoisted.dir, { recursive: true });
    const f = storeFile();
    writeFileSync(f, '{ not valid json ');
    chmodSync(f, 0o644);
    expect(mode(f)).toBe(0o644); // precondition

    // The store's rename is broken, so load()-catch → save() cannot replace the
    // malformed target. Only the harden-BEFORE-parse path can still clamp it.
    new Store();

    expect(mode(f)).toBe(0o600);
  });
});
