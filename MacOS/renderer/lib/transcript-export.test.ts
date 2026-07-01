/* Pure formatter — no DOM. */
import { describe, test, expect } from 'vitest';
import { formatTranscript } from './transcript-export';
import type { Job, TranscriptItem } from './api';

/** Minimal TranscriptItem with sane defaults. */
const ti = (p: Partial<TranscriptItem> & { kind: TranscriptItem['kind'] }): TranscriptItem => ({ text: '', ts: 0, ...p });

/** Minimal Job with sane defaults — only the fields the formatter reads matter. */
let seq = 0;
const job = (p: Partial<Job>): Job => ({
  id: `j${seq++}`, projectId: 'p', title: 't', status: 'done' as Job['status'], phase: '', progress: 1,
  input: '', output: null, error: null, effort: 'medium' as Job['effort'], cost: 0, tokens: 0, stage: '',
  createdAt: 0, updatedAt: 0, ...p,
});

describe('formatTranscript — header & ordering', () => {
  test('header carries the title, mode label and turn count', () => {
    const out = formatTranscript([job({ input: 'hi' })], { mode: 'concise', title: 'My chat' });
    expect(out).toContain('# My chat');
    expect(out).toContain('_Concise transcript · 1 turn_');
  });

  test('empty chat → 0 turns, no role headers', () => {
    const out = formatTranscript([], { mode: 'full', title: 'Empty' });
    expect(out).toContain('_Full transcript · 0 turns_');
    expect(out).not.toContain('## User');
  });

  test('turns are sorted by createdAt regardless of input order', () => {
    const out = formatTranscript(
      [job({ input: 'second', createdAt: 200 }), job({ input: 'first', createdAt: 100 })],
      { mode: 'concise' },
    );
    expect(out.indexOf('first')).toBeLessThan(out.indexOf('second'));
  });

  test('falls back to "Transcript" when no title is given', () => {
    expect(formatTranscript([], { mode: 'concise' })).toContain('# Transcript');
  });
});

describe('formatTranscript — user side', () => {
  test('prompt plus attachment placeholders', () => {
    const out = formatTranscript([job({
      input: 'look at this',
      inputImages: [{ assetId: 'a', mime: 'image/png', name: 'shot.png', imagePath: '/abs/shot.png' }],
      inputFiles: [{ name: 'notes.txt', kind: 'text' }],
    })], { mode: 'concise' });
    expect(out).toContain('## User\nlook at this');
    expect(out).toContain('[image: shot.png]'); // concise → friendly name, not the abs path
    expect(out).toContain('[file: notes.txt]');
  });

  test('full mode prefers the absolute image path', () => {
    const out = formatTranscript([job({
      input: 'x', inputImages: [{ assetId: 'a', mime: 'image/png', name: 'shot.png', imagePath: '/abs/shot.png' }],
    })], { mode: 'full' });
    expect(out).toContain('[image: /abs/shot.png]');
  });
});

describe('formatTranscript — concise collapses machinery', () => {
  const turn = job({
    input: 'do it',
    transcript: [
      ti({ kind: 'thinking', text: 'secret reasoning' }),
      ti({ kind: 'text', text: 'On it.' }),
      ti({ kind: 'tool', name: 'Read', text: '/Users/me/app/api.ts', durMs: 1234, toolStatus: 'done', preview: 'export const x = 1' }),
      ti({ kind: 'tool', name: 'Bash', text: 'Run tests', cmd: 'npm test', durMs: 5000, toolStatus: 'error' }),
      ti({ kind: 'image', imagePath: '/abs/out.png', alt: 'a chart' }),
      ti({ kind: 'result', text: 'Done.' }),
    ],
  });

  test('drops thinking', () => {
    expect(formatTranscript([turn], { mode: 'concise' })).not.toContain('secret reasoning');
  });

  test('keeps assistant prose', () => {
    const out = formatTranscript([turn], { mode: 'concise' });
    expect(out).toContain('On it.');
    expect(out).toContain('Done.');
  });

  test('tool → one line, file basename, no preview / duration / status', () => {
    const out = formatTranscript([turn], { mode: 'concise' });
    expect(out).toContain('↳ Read api.ts');
    expect(out).not.toContain('/Users/me/app/api.ts');
    expect(out).not.toContain('export const x = 1'); // preview omitted
    expect(out).not.toContain('1.2s'); // duration omitted
    expect(out).not.toContain('error'); // status omitted
  });

  test('bash tool collapses to the verb + raw command without doubling', () => {
    const out = formatTranscript([turn], { mode: 'concise' });
    expect(out).toContain('↳ Run tests: npm test');
    expect(out).not.toContain('Run Run');
  });

  test('image → bare placeholder', () => {
    const out = formatTranscript([turn], { mode: 'concise' });
    expect(out).toContain('[image]');
    expect(out).not.toContain('/abs/out.png');
  });
});

describe('formatTranscript — full keeps machinery', () => {
  const turn = job({
    input: 'do it',
    transcript: [
      ti({ kind: 'thinking', text: 'secret reasoning' }),
      ti({ kind: 'tool', name: 'Read', text: '/Users/me/app/api.ts', durMs: 1234, toolStatus: 'done', preview: 'export const x = 1' }),
      ti({ kind: 'tool', name: 'Bash', text: 'Run tests', cmd: 'npm test', durMs: 5000, toolStatus: 'error' }),
      ti({ kind: 'image', imagePath: '/abs/out.png' }),
    ],
  });

  test('includes thinking', () => {
    expect(formatTranscript([turn], { mode: 'full' })).toContain('[thinking]\nsecret reasoning');
  });

  test('tool keeps full path, duration, status and indented preview', () => {
    const out = formatTranscript([turn], { mode: 'full' });
    expect(out).toContain('↳ Read /Users/me/app/api.ts  (1.2s)');
    expect(out).toContain('    export const x = 1'); // preview indented
    expect(out).toContain('(error, 5.0s)');
  });

  test('image keeps its path', () => {
    expect(formatTranscript([turn], { mode: 'full' })).toContain('[image: /abs/out.png]');
  });
});

describe('formatTranscript — misc kinds & fallbacks', () => {
  test('no transcript → uses plain output', () => {
    const out = formatTranscript([job({ input: 'q', output: 'the answer' })], { mode: 'concise' });
    expect(out).toContain('## Assistant\nthe answer');
  });

  test('skill tool gets a friendly Skill label', () => {
    const out = formatTranscript([job({ transcript: [ti({ kind: 'tool', name: 'Skill', text: 'superpowers:brainstorming' })] })], { mode: 'concise' });
    expect(out).toContain('↳ Skill: Brainstorming');
  });

  test('review verdict line', () => {
    const out = formatTranscript([job({ transcript: [ti({ kind: 'review', verdict: 'needs-work', text: 'fix the bug' })] })], { mode: 'concise' });
    expect(out).toContain('[review: needs-work]');
  });

  test('question line', () => {
    const out = formatTranscript([job({ transcript: [ti({ kind: 'ask', ask: 'Which option?' })] })], { mode: 'full' });
    expect(out).toContain('[question] Which option?');
  });
});
