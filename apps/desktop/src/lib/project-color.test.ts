import { describe, it, expect } from 'vitest';
import { PROJECT_PALETTE, colorFromId, projectColor, projectColorName, projectInitial } from './project-color';

describe('projectColor', () => {
  it('returns the stored color when present', () => {
    expect(projectColor({ id: 'x', color: 'purple' })).toBe('var(--purple)');
    expect(projectColorName({ id: 'x', color: 'purple' })).toBe('purple');
  });

  it('falls back to a palette color when stored color is missing', () => {
    const name = projectColorName({ id: 'project-without-color', color: '' });
    expect((PROJECT_PALETTE as readonly string[])).toContain(name);
    expect(projectColor({ id: 'project-without-color', color: '' })).toBe(`var(--${name})`);
  });

  it('is deterministic for the same id', () => {
    expect(colorFromId('abc')).toBe(colorFromId('abc'));
    expect(colorFromId('proj-42')).toBe(colorFromId('proj-42'));
  });

  it('spreads across multiple palette colors for varied ids', () => {
    const ids = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
    const uniq = new Set(ids.map(colorFromId));
    // Not strictly all distinct (palette is small) but should not collapse to 1.
    expect(uniq.size).toBeGreaterThan(1);
  });

  it('handles null/undefined safely', () => {
    expect(projectColor(null)).toBe('var(--blue)');
    expect(projectColor(undefined)).toBe('var(--blue)');
    expect(colorFromId('')).toBe('blue');
  });
});

describe('projectInitial', () => {
  it('returns uppercase first letter', () => {
    expect(projectInitial('mochi')).toBe('M');
    expect(projectInitial('Quick Project')).toBe('Q');
    expect(projectInitial('  spaced')).toBe('S');
  });

  it('falls back to ? when empty', () => {
    expect(projectInitial('')).toBe('?');
    expect(projectInitial('   ')).toBe('?');
    expect(projectInitial(null)).toBe('?');
    expect(projectInitial(undefined)).toBe('?');
  });
});
