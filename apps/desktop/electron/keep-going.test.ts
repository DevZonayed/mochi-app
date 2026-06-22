/* Pure keep-going follow-up: pattern detection + organizing the auto-continue
   prompt that fires at timeout. The exact scenario this guards (image_0ss8f.png)
   is the agent ending a long turn on "Want me to keep going? Sprint 4b / 8 / 5.
   I'll just pick one and ship unless you redirect." That's a halt the operator
   shouldn't have to babysit on a goal-mode run.

   Coverage:
   - the offer-to-continue patterns ("want me to keep going", "shall I continue",
     "next up", "ready when you are", "I'll just pick one")
   - NEGATIVE cases (real branching question, hard pause, explicit blocker)
   - the organizer echoes the model's outlined items back as bullets
   - the prompt always uses the model-prefix the engine looks for */
import { describe, it, expect } from 'vitest';
import {
  detectKeepGoing, extractNextItems, organizedContinuePrompt,
  KEEP_GOING_PREFIX, KEEP_GOING_BASE_MS, KEEP_GOING_MAX_PER_SESSION, KEEP_GOING_CAP_NOTE,
} from './keep-going.js';

describe('detectKeepGoing', () => {
  it('hits the exact image_0ss8f.png tail', () => {
    const tail = `Want me to keep going? Natural next waves: **Sprint 4b live entitlement check** (paywall enforcement), **Sprint 8 admin audit log + role grants**, or **Sprint 5 OMR scanner sidecar**. I'll just pick one and ship unless you redirect.`;
    const m = detectKeepGoing(tail);
    expect(m).not.toBeNull();
    expect(/keep going/i.test(m as string)).toBe(true);
  });
  it('hits "should I continue" / "shall I" / "would you like me to"', () => {
    expect(detectKeepGoing('All green. Should I continue with the next sprint?')).not.toBeNull();
    expect(detectKeepGoing('Done. Shall I proceed with the next item?')).not.toBeNull();
    expect(detectKeepGoing('Ready. Would you like me to tackle the next sprint?')).not.toBeNull();
  });
  it('hits the "next up / on deck / coming up" offer', () => {
    expect(detectKeepGoing('All tests pass. Next up: ship the migration.')).not.toBeNull();
    expect(detectKeepGoing('Locked in. On deck: real-time presence.')).not.toBeNull();
    expect(detectKeepGoing('Sprint 3 done. Coming up: review the docs.')).not.toBeNull();
  });
  it('hits "ready when you are" / "say the word"', () => {
    expect(detectKeepGoing('Built and tested. Ready when you are.')).not.toBeNull();
    expect(detectKeepGoing('All staged. Just say the word.')).not.toBeNull();
  });
  it('searches only the trailing slice so a stray phrase mid-body does not trigger', () => {
    // The offer ("want me to keep going?") lives deep in the middle of a long
    // body that ends on a real deliverable — the trailing-slice search must
    // ignore the early phrase and return null.
    const middleOffer = 'Want me to keep going on the codepath? Sure I will.';
    const body = `${middleOffer} ${'.'.repeat(2000)} All done — shipped.`;
    expect(detectKeepGoing(body)).toBeNull();
  });
  it('does NOT hit a hard pause we already cover', () => {
    expect(detectKeepGoing('⏸ Claude usage limit reached. I scheduled a continue.')).toBeNull();
    expect(detectKeepGoing('Paused at the turn limit — the work so far is saved.')).toBeNull();
  });
  it('does NOT hit an explicit blocker (auth / creds / decision-only)', () => {
    expect(detectKeepGoing('I need your decision on which DB to use before I can continue. Want me to proceed?')).toBeNull();
    expect(detectKeepGoing("I don't have the credentials for Stripe — please share the secret key. Want me to keep going?")).toBeNull();
    expect(detectKeepGoing("I can't continue without the deploy token. Should I continue?")).toBeNull();
  });
  it('returns null on empty / nullish text', () => {
    expect(detectKeepGoing('')).toBeNull();
    expect(detectKeepGoing(undefined)).toBeNull();
    expect(detectKeepGoing(null)).toBeNull();
  });
});

describe('extractNextItems', () => {
  it('pulls the bold-headed alternatives from the screenshot tail', () => {
    const tail = `Want me to keep going? Natural next waves: **Sprint 4b live entitlement check** (paywall enforcement), **Sprint 8 admin audit log + role grants**, or **Sprint 5 OMR scanner sidecar**. I'll just pick one and ship unless you redirect.`;
    const items = extractNextItems(tail);
    expect(items.length).toBeGreaterThanOrEqual(1);
    // The first alt should mention "Sprint 4b" + "live entitlement"
    expect(items.some(i => /Sprint 4b/.test(i) && /entitlement/.test(i))).toBe(true);
  });
  it('pulls numbered + bulleted lists', () => {
    const body = `Next steps:\n1. Ship the migration.\n2. Roll the cache.\n- write the smoke tests\n- bump the version`;
    const items = extractNextItems(body);
    expect(items).toContain('Ship the migration.');
    expect(items).toContain('Roll the cache.');
    expect(items).toContain('write the smoke tests');
    expect(items).toContain('bump the version');
  });
  it('dedupes + caps at 8', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `- item ${i + 1}`).join('\n');
    const items = extractNextItems(lines);
    expect(items.length).toBeLessThanOrEqual(8);
    // First 8 are present
    expect(items[0]).toBe('item 1');
    expect(items[7]).toBe('item 8');
  });
  it('returns [] for empty', () => {
    expect(extractNextItems('')).toEqual([]);
    expect(extractNextItems(undefined)).toEqual([]);
  });

  // image_kpijo.png / image_6f4zy.png: the items used to land in the
  // organized prompt with their literal **stars**, which the user-side chat
  // bubble doesn't render — they showed as raw `**` to the operator.
  it('strips inline **bold** / __bold__ from bulleted items so the auto-continue prompt reads clean in the user bubble', () => {
    const body = `Suggested next wave\n- **Sprint 10b — CSFLE on phone/email** (envelope-encrypt PII via mongoose plugin; placeholder KMS until real KMS lands)\n- **Sprint 3b PDF renderer follow-up** — wire the rendered URL into \`paper_render_ready\` notifications\n- __Sprint 9c__ image-render mode for question detail (anti-OCR; serve text as watermarked SVG)`;
    const items = extractNextItems(body);
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const it of items) {
      expect(it).not.toMatch(/\*\*/);
      expect(it).not.toMatch(/__/);
    }
    // The semantic content survives — both the head and the trailing detail.
    expect(items.some(i => i.includes('Sprint 10b — CSFLE on phone/email') && i.includes('mongoose plugin'))).toBe(true);
    expect(items.some(i => i.includes('Sprint 3b PDF renderer follow-up') && i.includes('paper_render_ready'))).toBe(true);
    expect(items.some(i => i.includes('Sprint 9c'))).toBe(true);
  });

  it('preserves backticked inline code (the user-side bubble renders code OK)', () => {
    const body = `- Run \`pnpm import:questions\` on prod\n- Set \`BILLING_ENABLED=true\``;
    const items = extractNextItems(body);
    expect(items.some(i => i.includes('`pnpm import:questions`'))).toBe(true);
    expect(items.some(i => i.includes('`BILLING_ENABLED=true`'))).toBe(true);
  });
});

describe('organizedContinuePrompt', () => {
  it('starts with the auto-continue prefix so the engine recognizes it', () => {
    const p = organizedContinuePrompt({ lastText: 'Want me to keep going?' });
    expect(p.startsWith(KEEP_GOING_PREFIX)).toBe(true);
  });
  it('echoes the outlined items back as bullets', () => {
    const tail = `Next moves:\n1. Ship A.\n2. Ship B.\nWant me to keep going?`;
    const p = organizedContinuePrompt({ lastText: tail });
    expect(p).toMatch(/- Ship A\./);
    expect(p).toMatch(/- Ship B\./);
    expect(p).toMatch(/highest-impact/i);
  });
  it('injects the goal block in goal mode', () => {
    const p = organizedContinuePrompt({ lastText: 'Want me to keep going?', goalMode: true, originalGoal: 'Ship the dashboard end-to-end.' });
    expect(p).toMatch(/Goal: Ship the dashboard end-to-end\./);
  });
  it('falls back to a generic continue when no items are detected', () => {
    const p = organizedContinuePrompt({ lastText: 'Want me to keep going?' });
    expect(p).toMatch(/Continue exactly where you left off/);
  });
  it('shows the attempt counter when supplied', () => {
    const p = organizedContinuePrompt({ lastText: 'next up?', attempt: 3, maxAttempts: 20 });
    expect(p).toMatch(/Auto-continue 3\/20/);
  });
});

describe('keep-going constants', () => {
  it('defaults match the design (1-min base + 20-cap)', () => {
    // Tightened from 5min → 1min when autopilot became opt-in (the user
    // explicitly enables it per-chat now, so a long wait window is wasted).
    expect(KEEP_GOING_BASE_MS).toBe(60_000);
    expect(KEEP_GOING_MAX_PER_SESSION).toBe(20);
    expect(KEEP_GOING_CAP_NOTE).toMatch(/Auto-continue paused after 20/);
  });
});
