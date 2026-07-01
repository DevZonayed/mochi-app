import { describe, it, expect, beforeEach } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { hasSeed, seedInfo, clearSeed, applySeedIfFresh } from './seed.js';

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
