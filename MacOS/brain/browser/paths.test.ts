import { describe, it, expect } from 'vitest';
import { browserProfilesRoot, browserProfileDir } from './paths.js';

describe('browser profile paths', () => {
  it('nests profiles under <userData>/browser-profiles', () => {
    expect(browserProfilesRoot('/u')).toBe('/u/browser-profiles');
  });
  it('puts each project in its own dir', () => {
    expect(browserProfileDir('/u', 'proj_123')).toBe('/u/browser-profiles/proj_123');
  });
  it('sanitizes unsafe project ids (no traversal / separators)', () => {
    expect(browserProfileDir('/u', '../../etc')).toBe('/u/browser-profiles/______etc');
  });
});
