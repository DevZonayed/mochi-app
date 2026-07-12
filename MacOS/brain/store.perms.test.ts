/* The on-disk store (maestro-store.json) holds secrets — mcpToken, accessToken,
   extensionToken, provider-key metadata — so it must be owner-only (0600), never
   the umask-default 0644 an older build left behind. These tests pin that on
   fresh creation, on every save, and as a startup self-heal of an existing file.
   No secret VALUES are read or asserted here — only the file mode. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync, statSync, chmodSync, existsSync, readdirSync, writeFileSync, readFileSync, mkdirSync, symlinkSync } from 'node:fs';
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

  // RED: current save() writes to the predictable `${file}.tmp-${pid}` path with
  // flag 'w', which follows/overwrites a pre-existing file (or symlink) at that
  // path — writing SECRETS into an attacker-stageable, possibly 0644 location.
  // The fix uses a unique O_EXCL 0600 temp, so a pre-existing sibling is never
  // touched. (Assert via a boolean so a failure never prints store contents.)
  it('never reuses/overwrites a pre-existing predictable temp sibling on a save', () => {
    const s = new Store(); // stabilise: store exists at 0600
    const predictable = `${storeFile()}.tmp-${process.pid}`;
    const SENTINEL = 'SENTINEL_UNCHANGED';
    writeFileSync(predictable, SENTINEL);
    chmodSync(predictable, 0o644);
    s.rotateMcpToken(); // exactly ONE save with the predictable sibling present
    const untouched = existsSync(predictable) && readFileSync(predictable, 'utf8') === SENTINEL;
    expect(untouched).toBe(true);
  });

  // RED: a crash can leave a secret-bearing `${file}.tmp-*` behind at 0644.
  // Startup must harden + remove regular-file temp artifacts.
  it('hardens and removes a stale temp sibling on startup', () => {
    mkdirSync(hoisted.dir, { recursive: true });
    const stale = `${storeFile()}.tmp-99999`;
    writeFileSync(stale, '{"secret":"x"}');
    chmodSync(stale, 0o644);
    new Store();
    expect(existsSync(stale)).toBe(false);
    const strays = readdirSync(hoisted.dir).filter((n) => n.startsWith('maestro-store.json.tmp-'));
    expect(strays).toEqual([]);
  });

  // Defense-in-depth: even a malformed (unparseable) 0644 legacy store must end
  // up 0600 after construction (hardened before parse; save() also rewrites it).
  it('clamps a malformed 0644 store to 0600', () => {
    mkdirSync(hoisted.dir, { recursive: true });
    writeFileSync(storeFile(), '{ not valid json ');
    chmodSync(storeFile(), 0o644);
    new Store();
    expect(mode(storeFile())).toBe(0o600);
  });

  // Safety: the startup sweep removes a symlink temp-sibling ENTRY (unlink does
  // not follow it) but must leave its target fully untouched — no chmod-through,
  // content + mode + existence all preserved.
  it('removes a symlink temp sibling entry without touching its target', () => {
    mkdirSync(hoisted.dir, { recursive: true });
    const outside = join(hoisted.dir, 'outside.txt');
    writeFileSync(outside, 'important');
    chmodSync(outside, 0o644);
    const link = `${storeFile()}.tmp-symlink`;
    symlinkSync(outside, link);
    new Store();
    expect(existsSync(link)).toBe(false);                     // link entry unlinked
    expect(existsSync(outside)).toBe(true);                   // target survives
    expect(mode(outside)).toBe(0o644);                        // NOT clamped through the link
    expect(readFileSync(outside, 'utf8')).toBe('important');  // content intact
  });
});
