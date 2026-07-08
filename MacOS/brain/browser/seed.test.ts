import { describe, it, expect, beforeEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { hasSeed, seedInfo, clearSeed, applySeedIfFresh, probeCookies } from './seed.js';

const UD = '/tmp/mochi-seed-unit-' + process.pid;
function makeSeed() {
  const seedDefault = path.join(UD, 'browser-profiles', '_seed', 'Default');
  mkdirSync(seedDefault, { recursive: true });
  writeFileSync(path.join(seedDefault, 'Cookies'), 'fake-cookie-db');
  writeFileSync(path.join(UD, 'browser-profiles', '_seed', '.mochi-seed.json'),
    JSON.stringify({ sourceDir: 'Profile 2', sourceName: 'Jonayed', importedAt: 123, cookieCount: 58 }));
}

describe('seed profile copy logic', () => {
  beforeEach(() => { rmSync(UD, { recursive: true, force: true }); });

  it('hasSeed/seedInfo reflect an imported seed', () => {
    expect(hasSeed(UD)).toBe(false);
    makeSeed();
    expect(hasSeed(UD)).toBe(true);
    expect(seedInfo(UD)?.sourceName).toBe('Jonayed');
    expect(seedInfo(UD)?.cookieCount).toBe(58);
  });

  it('applySeedIfFresh copies the seed into a NEW project profile', () => {
    makeSeed();
    expect(applySeedIfFresh(UD, 'proj_1')).toBe(true);
    const cookies = path.join(UD, 'browser-profiles', 'proj_1', 'Default', 'Cookies');
    expect(existsSync(cookies)).toBe(true);
    expect(readFileSync(cookies, 'utf8')).toBe('fake-cookie-db'); // each project gets its OWN copy
  });

  it('never overwrites a project that already has its own profile', () => {
    makeSeed();
    mkdirSync(path.join(UD, 'browser-profiles', 'proj_2'), { recursive: true });
    expect(applySeedIfFresh(UD, 'proj_2')).toBe(false);
  });

  it('no-ops when there is no seed', () => {
    expect(applySeedIfFresh(UD, 'proj_3')).toBe(false);
  });

  it('clearSeed removes the seed', () => {
    makeSeed();
    expect(hasSeed(UD)).toBe(true);
    clearSeed(UD);
    expect(hasSeed(UD)).toBe(false);
  });
});

// probeCookies is the diagnostics core: it decides whether an import silently
// captured nothing (0 cookies) or copied undecryptable App-Bound (v20) cookies —
// the two "worked on one Mac, not another" failure modes. Build real sqlite Cookies
// fixtures so the detection is exercised end-to-end (sqlite3 ships with macOS).
const SQLITE = '/usr/bin/sqlite3';
const haveSqlite = existsSync(SQLITE);
// Chrome stamps each encrypted cookie value with an ASCII version tag: v10/v11 =
// Keychain-derived (decryptable by the agent Chromium), v20 = App-Bound (not).
function makeCookieDb(dbPath: string, prefixes: string[]) {
  execFileSync(SQLITE, [dbPath, 'create table cookies (host_key text, name text, encrypted_value blob);']);
  prefixes.forEach((p, i) => {
    // x'..' blob literal = version tag bytes + a byte of ciphertext, so length >= 3.
    const hex = Buffer.from(p + '\x00', 'binary').toString('hex');
    execFileSync(SQLITE, [dbPath, `insert into cookies values ('h${i}', 'n${i}', x'${hex}');`]);
  });
}

describe.skipIf(!haveSqlite)('probeCookies diagnostics', () => {
  beforeEach(() => { rmSync(UD, { recursive: true, force: true }); mkdirSync(UD, { recursive: true }); });

  it('flags an empty snapshot (0 cookies → logged out)', () => {
    const db = path.join(UD, 'Cookies');
    makeCookieDb(db, []);
    const r = probeCookies(db);
    expect(r.cookieCount).toBe(0);
    expect(r.appBound).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/0 cookies/i);
  });

  it('accepts v10/v11 cookies with no warnings (decryptable on the same Mac)', () => {
    const db = path.join(UD, 'Cookies');
    makeCookieDb(db, ['v10', 'v11', 'v10']);
    const r = probeCookies(db);
    expect(r.cookieCount).toBe(3);
    expect(r.appBound).toBe(false);
    expect(r.warnings).toHaveLength(0);
  });

  it('detects App-Bound Encryption (v20) — the machine-specific failure', () => {
    const db = path.join(UD, 'Cookies');
    makeCookieDb(db, ['v20', 'v20']);
    const r = probeCookies(db);
    expect(r.cookieCount).toBe(2);
    expect(r.appBound).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/App-Bound Encryption/i);
    expect(r.warnings.join(' ')).toMatch(/cannot decrypt/i); // no decryptable cookies at all
  });

  it('warns on a mix of v10 + v20 (partial carry-over)', () => {
    const db = path.join(UD, 'Cookies');
    makeCookieDb(db, ['v10', 'v20']);
    const r = probeCookies(db);
    expect(r.cookieCount).toBe(2);
    expect(r.appBound).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/may not carry over/i); // softer: some are still usable
  });
});
