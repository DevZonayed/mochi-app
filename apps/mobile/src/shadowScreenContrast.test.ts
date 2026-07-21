import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeTheme } from '@maestro/design-tokens';

// Independent sRGB relative-luminance + WCAG contrast, computed from the ACTUAL design
// tokens (M-B) — never "claimed" from a token name. Alpha-composited over the background
// exactly as the RN renderer would layer the text on the surface.
function parse(c: string): { r: number; g: number; b: number; a: number } {
  const hex = c.match(/^#([0-9a-f]{6})$/i);
  if (hex) { const n = parseInt(hex[1]!, 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }; }
  const rgba = c.match(/rgba?\(([^)]+)\)/i);
  if (rgba) { const p = rgba[1]!.split(',').map((x) => parseFloat(x.trim())); return { r: p[0]!, g: p[1]!, b: p[2]!, a: p[3] ?? 1 }; }
  throw new Error(`unparseable color ${c}`);
}
function over(fg: string, bg: string): { r: number; g: number; b: number } {
  const f = parse(fg), b = parse(bg);
  return { r: f.r * f.a + b.r * (1 - f.a), g: f.g * f.a + b.g * (1 - f.a), b: f.b * f.a + b.b * (1 - f.a) };
}
function lum({ r, g, b }: { r: number; g: number; b: number }): number {
  const f = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function ratio(fg: string, bg: string): number {
  const L1 = lum(over(fg, bg)), L2 = lum(parse(bg));
  const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

const light = makeTheme('light').color;
const dark = makeTheme('dark').color;
const LIGHT_CARD = '#FFFFFF';        // bgElevated
const LIGHT_GROUPED = '#F2F2F7';     // bg / systemGrouped
const DARK_CARD = '#1C1C1E';         // bgElevated (dark)

describe('ScreenViewer standing safety/source text (M-B) — WCAG AA on every surface', () => {
  it('the CHOSEN token `ink` clears 4.5:1 on light white, light systemGrouped, and dark', () => {
    expect(ratio(light.ink, LIGHT_CARD)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(light.ink, LIGHT_GROUPED)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(dark.ink, DARK_CARD)).toBeGreaterThanOrEqual(4.5);
  });

  it('documents WHY: the old `inkSecondary` was BELOW AA on light (the reviewer-flagged 3.4:1)', () => {
    expect(ratio(light.inkSecondary, LIGHT_CARD)).toBeLessThan(4.5);
    expect(ratio(light.inkSecondary, LIGHT_GROUPED)).toBeLessThan(4.5);
    // dark secondary already passed — the fix is light-mode only
    expect(ratio(dark.inkSecondary, DARK_CARD)).toBeGreaterThanOrEqual(4.5);
  });

  it('ScreenViewer uses `ink` for the standing note + source label and drops the false AA comment', () => {
    const SRC = readFileSync(new URL('./screens/controller/ScreenViewer.tsx', import.meta.url).pathname, 'utf8');
    // the standing "View only …" note + source label are on the primary ink token now
    expect(SRC).toContain('color: theme.color.ink, fontSize: 12.5'); // viewOnlyNote
    expect(SRC).toContain('color: theme.color.ink, fontSize: 13');   // source label
    expect(SRC).toContain('subtitleColor={theme.color.ink}');        // header subtitle
    // the false "WCAG AA: use the higher-contrast secondary ink" comment is gone
    expect(SRC).not.toMatch(/WCAG AA: use the higher-contrast secondary ink/);
  });
});

describe('StatusChip label (M-B) — chip text clears WCAG AA on every tone', () => {
  // The chip background is the tone color at ~12.5% (`color + '20'`) composited over the card;
  // the LABEL text must be `ink` (the tone colors themselves — esp. neutral/orange — were far
  // below AA as small text). Compute ink over each tone-tinted background.
  const CHIP_ALPHA = 0x20 / 0xff; // '20' hex suffix
  function tint(tone: string, card: string): string {
    const t = parse(tone), c = parse(card);
    const r = t.r * CHIP_ALPHA + c.r * (1 - CHIP_ALPHA), g = t.g * CHIP_ALPHA + c.g * (1 - CHIP_ALPHA), b = t.b * CHIP_ALPHA + c.b * (1 - CHIP_ALPHA);
    return `rgba(${r},${g},${b},1)`;
  }
  const tones = (t: ReturnType<typeof makeTheme>['color']) => [t.green, t.red, t.orange, t.inkTertiary];

  it('light: ink over every tone-tinted chip background ≥ 4.5:1', () => {
    for (const tone of tones(light)) {
      expect(ratio(light.ink, tint(tone, LIGHT_CARD))).toBeGreaterThanOrEqual(4.5);
      expect(ratio(light.ink, tint(tone, LIGHT_GROUPED))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('dark: ink over every tone-tinted chip background ≥ 4.5:1', () => {
    for (const tone of tones(dark)) {
      expect(ratio(dark.ink, tint(tone, DARK_CARD))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('source guard: StatusChip renders its label <Text> in theme.color.ink (not the tone color)', () => {
    const PARTS = readFileSync(new URL('./screens/controller/parts.tsx', import.meta.url).pathname, 'utf8');
    // the label Text uses ink…
    expect(PARTS).toMatch(/fontSize: 12, fontWeight: '600', color: theme\.color\.ink/);
    // …and no longer paints the label with the raw tone `color`
    expect(PARTS).not.toMatch(/fontWeight: '600', color \}/);
    expect(PARTS).not.toMatch(/fontWeight: '600', color:? color/);
  });
});
