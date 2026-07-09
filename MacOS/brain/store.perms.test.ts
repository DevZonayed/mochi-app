/* The on-disk store (maestro-store.json) holds secrets — mcpToken, accessToken,
   extensionToken, provider-key metadata — so it must be owner-only (0600), never
   the umask-default 0644 an older build left behind. These tests pin that on
   fresh creation, on every save, and as a startup self-heal of an existing file.
   No secret VALUES are read or asserted here — only the file mode. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync, statSync, chmodSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-perms-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir, getVersion: () => '0.0.0-test' } }));

import { Store } from './store.js';

const storeFile = () => join(hoisted.dir, 'maestro-store.json');
const mode = (f: string) => statSync(f).mode & 0o777;

describe('Store file permissions', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('creates the store owner-only (0600) on first run', () => {
    new Store();
    expect(existsSync(storeFile())).toBe(true);
    expect(mode(storeFile())).toBe(0o600);
  });

  it('keeps 0600 after a save() mutation', () => {
    const s = new Store();
    s.rotateMcpToken(); // triggers a save
    expect(mode(storeFile())).toBe(0o600);
  });

  it('self-heals a world-readable (0644) store left by an older build on load', () => {
    // First run writes a valid store; simulate a legacy build by loosening it.
    new Store();
    chmodSync(storeFile(), 0o644);
    expect(mode(storeFile())).toBe(0o644);
    // Re-opening the store must clamp it back to owner-only.
    new Store();
    expect(mode(storeFile())).toBe(0o600);
  });

  it('does not leak the token into an unprotected temp sibling', () => {
    const s = new Store();
    s.rotateMcpToken();
    // The atomic-write temp file is created at 0600 and renamed away; assert no
    // stray .tmp-* sibling survives world-readable.
    const strays = readdirSync(hoisted.dir).filter((n) => n.startsWith('maestro-store.json.tmp-'));
    expect(strays).toEqual([]);
  });
});
