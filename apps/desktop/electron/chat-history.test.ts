/* Unit tests for the cross-engine chat handoff: model-aware budget + a recap
   built from each turn's structured transcript (not just truncated prose). */

import { describe, it, expect } from 'vitest';
import { contextWindowFor, historyCharBudget, handoffBrief, type BriefTurn } from './chat-history.js';
import type { TranscriptItem } from './store.js';

const tool = (name: string, text: string): TranscriptItem => ({ kind: 'tool', name, text, ts: 0 });
const turn = (over: Partial<BriefTurn> & { createdAt: number }): BriefTurn =>
  ({ input: 'hi', output: 'ok', transcript: [], ...over });

describe('contextWindowFor', () => {
  it('gives Codex/GPT a larger window than default Claude', () => {
    expect(contextWindowFor('codex', 'gpt-5')).toBe(250_000);
    expect(contextWindowFor('claude', 'claude-sonnet-4-5')).toBe(200_000);
  });
  it('honors an explicit 1M long-context model id regardless of engine', () => {
    expect(contextWindowFor('claude', 'claude-sonnet-4-5-1m')).toBe(1_000_000);
    expect(contextWindowFor('claude', 'claude-sonnet-4-5[1m]')).toBe(1_000_000);
  });
  it('falls back to a safe 200k for unknown/missing models', () => {
    expect(contextWindowFor(undefined, undefined)).toBe(200_000);
  });
});

describe('historyCharBudget', () => {
  it('scales with the window and never regresses below the legacy 12k floor', () => {
    const codex = historyCharBudget(contextWindowFor('codex', 'gpt-5'));   // 250k * .30 * 4
    const claude = historyCharBudget(contextWindowFor('claude', 'x'));      // 200k * .30 * 4
    expect(codex).toBe(300_000);
    expect(claude).toBe(240_000);
    expect(historyCharBudget(1000)).toBe(12_000); // tiny window → floor
  });
});

describe('handoffBrief', () => {
  it('returns empty for no prior turns (no stray recap on a fresh chat)', () => {
    expect(handoffBrief([], 10_000)).toBe('');
  });

  it('folds the structured tool trail in between the user ask and final answer', () => {
    const brief = handoffBrief([turn({
      createdAt: 1,
      input: 'add a login button',
      output: 'Done — added it.',
      transcript: [tool('Edit', 'src/Login.tsx'), tool('Bash', 'run tests')],
    })], 10_000);
    expect(brief).toContain('[User]: add a login button');
    expect(brief).toContain('[Assistant did]:');
    expect(brief).toContain('· Edit: src/Login.tsx');
    expect(brief).toContain('· Bash: run tests');
    expect(brief).toContain('[Assistant]: Done — added it.');
  });

  it('renders turns oldest→newest but prioritizes the NEWEST when budget is tight', () => {
    const turns = [
      turn({ createdAt: 1, input: 'FIRST question', output: 'first answer' }),
      turn({ createdAt: 2, input: 'SECOND question', output: 'second answer' }),
    ];
    // Budget big enough for only ~one block → newest (SECOND) must survive.
    const brief = handoffBrief(turns, 60);
    expect(brief).toContain('SECOND question');
    expect(brief).not.toContain('FIRST question');
  });

  it('keeps chronological order when both turns fit', () => {
    const turns = [
      turn({ createdAt: 1, input: 'FIRST', output: 'a' }),
      turn({ createdAt: 2, input: 'SECOND', output: 'b' }),
    ];
    const brief = handoffBrief(turns, 10_000);
    expect(brief.indexOf('FIRST')).toBeLessThan(brief.indexOf('SECOND'));
  });

  it('always keeps at least the newest turn even if it alone exceeds budget', () => {
    const brief = handoffBrief([turn({ createdAt: 1, input: 'x'.repeat(500), output: 'y' })], 20);
    expect(brief).toContain('[User]: ');
  });

  it('does not render "Bash: Bash" when the label equals the tool name', () => {
    const brief = handoffBrief([turn({ createdAt: 1, transcript: [tool('Bash', 'Bash')] })], 10_000);
    expect(brief).toContain('· Bash');
    expect(brief).not.toContain('Bash: Bash');
  });

  it('handles a retention-stripped (empty) transcript by falling back to input/output', () => {
    const brief = handoffBrief([turn({ createdAt: 1, input: 'q', output: 'a', transcript: [] })], 10_000);
    expect(brief).toContain('[User]: q');
    expect(brief).toContain('[Assistant]: a');
    expect(brief).not.toContain('[Assistant did]:');
  });

  it('includes review verdicts in the trail', () => {
    const brief = handoffBrief([turn({
      createdAt: 1,
      transcript: [{ kind: 'review', verdict: 'needs-work', resolved: true, text: '', ts: 0 }],
    })], 10_000);
    expect(brief).toContain('· review: needs-work (resolved)');
  });
});
