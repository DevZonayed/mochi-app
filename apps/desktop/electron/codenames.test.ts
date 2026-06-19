/* codenames — pure picker. No fs / electron / network. */
import { describe, test, expect } from 'vitest';
import { CITIES, codenameFromBranch, displayCodename, pickCityCodename } from './codenames';

describe('CITIES catalogue', () => {
  test('is non-empty and every entry is kebab-safe lowercase', () => {
    expect(CITIES.length).toBeGreaterThan(50);
    for (const c of CITIES) {
      expect(c).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    }
  });
  test('has no duplicate entries', () => {
    const set = new Set(CITIES);
    expect(set.size).toBe(CITIES.length);
  });
});

describe('pickCityCodename', () => {
  test('returns SOMETHING from the catalogue when used is empty', () => {
    const code = pickCityCodename(new Set(), 0);
    expect(CITIES).toContain(code);
  });
  test('is deterministic with seed', () => {
    expect(pickCityCodename(new Set(), 42)).toBe(pickCityCodename(new Set(), 42));
  });
  test('never returns a codename in `used`', () => {
    const used = new Set(CITIES.slice(0, CITIES.length - 1));
    const code = pickCityCodename(used, 7);
    expect(used.has(code)).toBe(false);
  });
  test('falls back to a unique numeric suffix when every city is taken', () => {
    const used = new Set(CITIES);
    const code = pickCityCodename(used);
    expect(used.has(code)).toBe(false);
    // Either `<city>-N` (preferred) or the timestamp fallback (extreme edge).
    expect(code).toMatch(/^[a-z][a-z0-9-]*(-\d+)?$/);
  });
});

describe('display + branch helpers', () => {
  test('displayCodename title-cases each hyphen-separated segment', () => {
    expect(displayCodename('lyon')).toBe('Lyon');
    expect(displayCodename('chiang-mai')).toBe('Chiang Mai');
    expect(displayCodename('punta-arenas')).toBe('Punta Arenas');
    expect(displayCodename('')).toBe('');
  });
  test('codenameFromBranch pulls the city out of mochi/<city>/<slug>', () => {
    expect(codenameFromBranch('mochi/lyon/fix-auth')).toBe('lyon');
    expect(codenameFromBranch('mochi/chiang-mai/wip')).toBe('chiang-mai');
    expect(codenameFromBranch('mochi/foo-ab12')).toBeNull();
    expect(codenameFromBranch(null)).toBeNull();
    expect(codenameFromBranch('feature/x')).toBeNull();
  });
});
