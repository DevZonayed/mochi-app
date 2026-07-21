import { describe, expect, it } from 'vitest';
import { projectPendingQuestions } from './question-projection';
import type { Job, Schedule } from './api';

const turn = (id: string): Pick<Job, 'id'> => ({ id });

const question = (id: string, sourceJobId: string | undefined, sessionId = 's1'): Schedule => ({
  id,
  projectId: 'p1',
  title: 'Auto-answer question',
  time: '',
  cadence: 'once',
  enabled: true,
  nextRun: Date.now() + 60_000,
  createdAt: Date.now(),
  sessionId,
  kind: 'auto-answer',
  prompt: 'answer',
  questionAsk: JSON.stringify({ questions: [{ question: `Question ${id}?`, options: [{ label: 'Yes' }, { label: 'No' }] }] }),
  fireAt: Date.now() + 60_000,
  ...(sourceJobId ? { sourceJobId } : {}),
});

describe('question projection', () => {
  it('maps each pending question to its exact source turn, not the last turn', () => {
    const a = question('qa', 'turn-a');
    const b = question('qb', 'turn-b');
    const projection = projectPendingQuestions([a, b], [turn('turn-a'), turn('unrelated-last'), turn('turn-b')], 's1');

    expect(projection.bySourceJobId.get('turn-a')?.id).toBe('qa');
    expect(projection.bySourceJobId.get('turn-b')?.id).toBe('qb');
    expect(projection.bySourceJobId.get('unrelated-last')).toBeUndefined();
    expect(projection.hidden).toEqual([]);
    expect(projection.legacy).toEqual([]);
  });

  it('does not project legacy source-less rows and summarizes exact questions whose turn is unloaded', () => {
    const visible = question('visible', 'turn-a');
    const hidden = question('hidden', 'turn-b');
    const legacy = question('legacy', undefined);
    const otherSession = question('other', 'turn-a', 's2');

    const projection = projectPendingQuestions([visible, hidden, legacy, otherSession], [turn('turn-a')], 's1');

    expect(projection.bySourceJobId.get('turn-a')?.id).toBe('visible');
    expect(projection.hidden.map(row => row.id)).toEqual(['hidden']);
    expect(projection.legacy.map(row => row.id)).toEqual(['legacy']);
  });

  it('supports out-of-order exact answer and extend payloads while A remains projected', () => {
    const a = question('qa', 'turn-a');
    const b = question('qb', 'turn-b');
    const projection = projectPendingQuestions([a, b], [turn('turn-a'), turn('turn-b')], 's1');

    const answerPayload = { sessionId: 's1', sourceJobId: projection.bySourceJobId.get('turn-b')?.sourceJobId, answer: 'B first' };
    const extendPayload = { sessionId: 's1', sourceJobId: projection.bySourceJobId.get('turn-b')?.sourceJobId };
    const afterB = projectPendingQuestions([a], [turn('turn-a'), turn('turn-b')], 's1');

    expect(answerPayload).toEqual({ sessionId: 's1', sourceJobId: 'turn-b', answer: 'B first' });
    expect(extendPayload).toEqual({ sessionId: 's1', sourceJobId: 'turn-b' });
    expect(afterB.bySourceJobId.get('turn-a')?.id).toBe('qa');
    expect(afterB.bySourceJobId.get('turn-b')).toBeUndefined();
  });

  it('keeps hidden B independently actionable and removes only B after its schedule update', () => {
    const visibleA = question('qa', 'turn-a');
    const hiddenB = question('qb', 'turn-b');
    const hiddenLegacy = question('legacy', undefined);
    delete hiddenLegacy.questionAsk;

    const projection = projectPendingQuestions([visibleA, hiddenB, hiddenLegacy], [turn('turn-a')], 's1');
    const hidden = projection.hidden[0];

    expect(hidden.id).toBe('qb');
    expect(hidden.questionAsk).toContain('Question qb?');
    expect({ sessionId: 's1', sourceJobId: hidden.sourceJobId, answer: 'B first' }).toEqual({
      sessionId: 's1',
      sourceJobId: 'turn-b',
      answer: 'B first',
    });
    expect({ sessionId: 's1', sourceJobId: hidden.sourceJobId }).toEqual({
      sessionId: 's1',
      sourceJobId: 'turn-b',
    });
    expect(projection.legacy.map(row => row.id)).toEqual(['legacy']);

    const afterBRemoved = projectPendingQuestions([visibleA, hiddenLegacy], [turn('turn-a')], 's1');
    expect(afterBRemoved.bySourceJobId.get('turn-a')?.id).toBe('qa');
    expect(afterBRemoved.hidden).toEqual([]);
    expect(afterBRemoved.legacy.map(row => row.id)).toEqual(['legacy']);
  });
});
