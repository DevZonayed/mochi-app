/* Pure AskUserQuestion follow-up logic: parsing, recommended-option pick, the
   prefixed answer channel, and the escalating-extend + 30-min-cap math. */
import { describe, it, expect } from 'vitest';
import {
  parseAsk, pickRecommended, recommendedAnswer, answerMessage, timeoutAnswer,
  offsetForExtends, nextExtend, ANSWER_PREFIX, ASK_BASE_MS, ASK_CAP_MS,
} from './ask-question.js';

const ASK = JSON.stringify({
  questions: [{
    question: 'How would you like to proceed with the todo app?',
    header: 'Approach',
    options: [
      { label: 'Define requirements first', description: 'Talk through features before any code.' },
      { label: 'Pick a stack now', description: 'Lock in tech choices and scaffold.' },
      { label: 'Use a recommended default', description: 'I propose Next.js + SQLite and start immediately.' },
    ],
    multiSelect: false,
  }],
});

describe('parseAsk', () => {
  it('parses questions + options from a JSON string', () => {
    const qs = parseAsk(ASK);
    expect(qs).toHaveLength(1);
    expect(qs[0].header).toBe('Approach');
    expect(qs[0].options.map(o => o.label)).toEqual(['Define requirements first', 'Pick a stack now', 'Use a recommended default']);
  });
  it('accepts an already-parsed object', () => {
    expect(parseAsk(JSON.parse(ASK))).toHaveLength(1);
  });
  it('returns [] for junk', () => {
    expect(parseAsk('not json')).toEqual([]);
    expect(parseAsk({})).toEqual([]);
    expect(parseAsk({ questions: 'nope' })).toEqual([]);
  });
});

describe('pickRecommended', () => {
  it('picks the option that signals recommended/default', () => {
    const q = parseAsk(ASK)[0];
    expect(pickRecommended(q)?.label).toBe('Use a recommended default');
  });
  it('falls back to the first option when none is marked', () => {
    const q = parseAsk(JSON.stringify({ questions: [{ question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] }] }))[0];
    expect(pickRecommended(q)?.label).toBe('A');
  });
});

describe('answer formatting', () => {
  it('prefixes the answer with the model-recognized tag', () => {
    expect(answerMessage('Pick a stack now')).toBe(`${ANSWER_PREFIX} Pick a stack now`);
  });
  it('recommendedAnswer summarizes per question with header', () => {
    expect(recommendedAnswer(parseAsk(ASK))).toBe('Approach: Use a recommended default');
  });
  it('timeoutAnswer carries the recommendation + a no-ask directive', () => {
    const msg = timeoutAnswer(parseAsk(ASK));
    expect(msg.startsWith(ANSWER_PREFIX)).toBe(true);
    expect(msg).toMatch(/Use a recommended default/);
    expect(msg).toMatch(/without asking again/i);
  });
  it('timeoutAnswer falls back to a generic default when unparseable', () => {
    expect(timeoutAnswer([])).toMatch(/recommended default/i);
  });
});

describe('escalating extend + cap', () => {
  // After the 2026 autopilot redesign ASK_BASE_MS dropped 5min → 1min (the
  // operator wanted snappier countdowns now that it's opt-in per-chat).
  // The escalating step (+5, +10, +15) is unchanged, only the BASE shifts —
  // so deadlines below are written in terms of ASK_BASE_MS, not literal 10m/20m.
  it('offset grows base, +5, +10, +15 …', () => {
    expect(offsetForExtends(0)).toBe(ASK_BASE_MS);                 // base (1m)
    expect(offsetForExtends(1)).toBe(ASK_BASE_MS + 5 * 60_000);    // base + 5m
    expect(offsetForExtends(2)).toBe(ASK_BASE_MS + 15 * 60_000);   // base + 15m
    expect(offsetForExtends(3)).toBe(ASK_BASE_MS + 30 * 60_000);   // base + 30m (over 30-min cap)
  });
  it('first extend adds 5 min', () => {
    const armed = 1_000_000;
    const e = nextExtend(armed, 0);
    expect(e.capped).toBe(false);
    expect(e.extends).toBe(1);
    expect(e.addedMs).toBe(5 * 60_000);
    expect(e.deadline).toBe(armed + ASK_BASE_MS + 5 * 60_000);
  });
  it('second extend adds 10 min (15 min of extension total)', () => {
    const armed = 1_000_000;
    const e = nextExtend(armed, 1);
    expect(e.capped).toBe(false);
    expect(e.extends).toBe(2);
    expect(e.addedMs).toBe(10 * 60_000);
    expect(e.deadline).toBe(armed + ASK_BASE_MS + 15 * 60_000);
  });
  it('the extend that would exceed 30 min total caps → graceful pause', () => {
    const e = nextExtend(1_000_000, 2); // next would push past the 30-min cap
    expect(e.capped).toBe(true);
    expect(offsetForExtends(3)).toBeGreaterThan(ASK_CAP_MS);
  });
});
