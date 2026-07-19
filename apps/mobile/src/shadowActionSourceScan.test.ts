/**
 * shadowActionSourceScan.test.ts — Phase 3C3 negative security contract. The six-action
 * graph MUST traverse only the encrypted controller command path (ProductionShadowController
 * `actions.*` → `sendCommand` → relay → host executor) — NEVER a direct REST/server mutation
 * (`api.sendChat` / `api.approveApproval` / `fetch(...)` / etc.), and NEVER render raw
 * command/grant/key/fence ids or command payload text.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTheme } from '@maestro/design-tokens';

const HERE = new URL('.', import.meta.url).pathname;
const GRAPH = [
  'shadowActionCapabilities.ts', 'shadowActionModel.ts', 'shadowActionController.ts', 'shadowActionRuntime.ts',
  'screens/controller/ActionControls.tsx',
];
const src = (f: string) => readFileSync(join(HERE, f), 'utf8');

describe('no direct REST/server mutation in the action graph', () => {
  it('imports NO direct `api` module', () => {
    for (const f of GRAPH) {
      const s = src(f);
      expect(s).not.toMatch(/from ['"]\.\.?\/(\.\.\/)*api['"]/);
      expect(s).not.toMatch(/require\(['"].*\/api['"]\)/);
    }
  });
  it('calls NO direct REST mutation and NO raw fetch', () => {
    for (const f of GRAPH) {
      const s = src(f);
      for (const forbidden of ['api.sendChat', 'api.approveApproval', 'api.denyApproval', 'api.createJob', 'api.cancelJob', 'reqAccount', 'accountReq', 'fetch(']) {
        expect(s, `${f} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
  it('routes actions ONLY through the controller actions surface', () => {
    const ctrl = src('shadowActionController.ts');
    // Every dispatch goes through `c.actions.*` (the verified capability-gated API).
    expect(ctrl).toMatch(/c\.actions/);
    expect(ctrl).toMatch(/a\.startJob|a\.cancelJob|a\.respondApproval|a\.answerQuestion|a\.sendMessage|a\.setAutopilot/);
  });
});

describe('F1 idempotency key is sealed, never plaintext-relay / logged / rendered', () => {
  it('the service seals the caller key inside the envelope and sends a DISTINCT random relay key', () => {
    const s = readFileSync(join(HERE, 'shadowControllerService.ts'), 'utf8');
    // The sealed (host exactly-once) key is the caller's attempt key or a random fallback…
    expect(s).toMatch(/sealCommandEnvelope\([^)]*idempotencyKey:\s*sealedIdempotencyKey/);
    // …and the plaintext relay transport-dedup key is a SEPARATE per-command random value.
    expect(s).toMatch(/relayIdempotencyKey\s*=\s*`idem_\$\{base64urlEncode\(this\.backend\.randomBytes/);
    expect(s).toMatch(/idempotencyKey:\s*relayIdempotencyKey/);
    // The caller key must never be the plaintext relay field.
    expect(s).not.toMatch(/idempotencyKey:\s*sealedIdempotencyKey[^}]*envelopeCiphertext/s);
  });
  it('no action-graph module logs / analytics / renders the idempotency key', () => {
    for (const f of [...GRAPH, 'shadowActionIdempotency.ts', 'shadowActionRuntime.ts']) {
      const s = src(f);
      for (const line of s.split('\n')) {
        if (/idempotencyKey|newIdempotencyKey|\bidem_/.test(line)) {
          expect(line, `${f}: key must not reach a log/analytics sink`).not.toMatch(/console\.|analytics|track\(|logger|Sentry|\bText\b|<Text/);
        }
      }
    }
  });
});

describe('no raw internal ids / command payload rendered', () => {
  it('the UI never renders commandId / grantId / keyId / fence / scopeKey', () => {
    const ui = src('screens/controller/ActionControls.tsx');
    for (const forbidden of ['commandId', 'grantId', 'keyId', 'fence', 'scopeKey', 'idempotencyKey']) {
      expect(ui, `ActionControls must not render ${forbidden}`).not.toContain(forbidden);
    }
  });
  it('no screen streaming / input authorization / handoff features', () => {
    for (const f of GRAPH) {
      const s = src(f).toLowerCase();
      for (const forbidden of ['pixel-stream', 'screenstream', 'visualinput', 'handoff', 'keyboard event', 'mousedown']) {
        expect(s, `${f} must not reference ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

// ── R2: the read-only / offline ActionsNote body must be READABLE (WCAG AA 4.5:1) against the
//    REAL Overview background in BOTH themes — never the disabled-control `inkTertiary` token. ──
type RGB = { r: number; g: number; b: number };
function parseColor(c: string): { r: number; g: number; b: number; a: number } {
  const hex = c.match(/^#([0-9a-f]{6})$/i);
  if (hex) return { r: parseInt(hex[1].slice(0, 2), 16), g: parseInt(hex[1].slice(2, 4), 16), b: parseInt(hex[1].slice(4, 6), 16), a: 1 };
  const m = c.match(/rgba?\(([^)]+)\)/i);
  if (!m) throw new Error(`unparseable color ${c}`);
  const p = m[1].split(',').map((x) => parseFloat(x.trim()));
  return { r: p[0], g: p[1], b: p[2], a: p[3] ?? 1 };
}
function relLum({ r, g, b }: RGB): number {
  const ch = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
/** Contrast of a (possibly translucent) foreground composited over an opaque hex background. */
function contrast(fg: string, bgHex: string): number {
  const f = parseColor(fg); const bg = parseColor(bgHex);
  const comp: RGB = { r: f.r * f.a + bg.r * (1 - f.a), g: f.g * f.a + bg.g * (1 - f.a), b: f.b * f.a + bg.b * (1 - f.a) };
  const l1 = relLum(comp); const l2 = relLum({ r: bg.r, g: bg.g, b: bg.b });
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

describe('R2: ActionsNote body text is accessible (WCAG AA) in both themes', () => {
  for (const mode of ['light', 'dark'] as const) {
    const t = makeTheme(mode).color;
    it(`${mode}: the note body \`ink\` on Overview bg ${t.bg} clears 4.5:1`, () => {
      expect(contrast(t.ink, t.bg), `ink on ${t.bg}`).toBeGreaterThanOrEqual(4.5);
    });
  }
  it('light: the previous `inkTertiary` token FAILS 4.5:1 (≈1.7:1) — proves the fix is required', () => {
    const t = makeTheme('light').color;
    expect(contrast(t.inkTertiary, t.bg)).toBeLessThan(4.5);
  });
  it('measured ratios: light ~18.8:1, dark ~21:1 (documented for the artifact)', () => {
    expect(contrast(makeTheme('light').color.ink, makeTheme('light').color.bg)).toBeGreaterThan(15);
    expect(contrast(makeTheme('dark').color.ink, makeTheme('dark').color.bg)).toBeGreaterThan(15);
  });
  it('source guard: the note body <Text> uses theme.color.ink, NOT inkTertiary', () => {
    const s = src('screens/controller/ActionControls.tsx');
    const fn = s.slice(s.indexOf('export function ActionsNote'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 1);
    expect(body).toMatch(/fontSize:\s*13,\s*color:\s*theme\.color\.ink\b/);
    expect(body).not.toMatch(/fontSize:\s*13,\s*color:\s*theme\.color\.inkTertiary\b/);
  });
});
