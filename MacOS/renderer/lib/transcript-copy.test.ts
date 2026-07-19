import { describe, it, expect, vi } from 'vitest';
import { runTranscriptCopy, copyTextWith, type TranscriptCopyDeps } from './transcript-copy';
import type { Job } from './api';

// NOTE: the fixture MUST spread `over` — earlier it silently ignored overrides,
// so tests that thought they varied the job shape were all copying the same one.
const job = (over: Partial<Job> = {}): Job =>
  ({ id: 'j1', sessionId: 's1', status: 'done', createdAt: 1, input: 'hi', output: 'hey', ...over } as unknown as Job);

/** A deps object that always succeeds, overridable per test. */
function deps(over: Partial<TranscriptCopyDeps> = {}): { d: TranscriptCopyDeps; copy: ReturnType<typeof vi.fn>; format: ReturnType<typeof vi.fn> } {
  const copy = vi.fn(async (_t: string) => ({ ok: true as const }));
  const format = vi.fn((_jobs: Job[]) => 'FORMATTED-TEXT');
  const d: TranscriptCopyDeps = {
    hasSession: true,
    loadJobs: async () => [job()],
    format: format as unknown as TranscriptCopyDeps['format'],
    copy: copy as unknown as TranscriptCopyDeps['copy'],
    ...over,
  };
  return { d, copy, format };
}

describe('transcript-copy fixture — job(over) actually applies overrides', () => {
  it('spreads the override onto the base job (regression: it used to be ignored)', () => {
    expect(job({ id: 'X', output: 'OUT' })).toMatchObject({ id: 'X', output: 'OUT', sessionId: 's1' });
  });
});

describe('runTranscriptCopy — the canonical tab transcript-copy orchestration', () => {
  it('routes the copy through the injected copy dependency (never navigator.clipboard directly)', async () => {
    const { d, copy } = deps();
    const out = await runTranscriptCopy(d);
    expect(out.ok).toBe(true);
    expect(copy).toHaveBeenCalledTimes(1);
    // The helper is copy-agnostic: it only ever touches the provided dep.
    expect(copy).toHaveBeenCalledWith('FORMATTED-TEXT');
  });

  it('passes the EXACT formatted transcript text to the clipboard', async () => {
    const jobs = [job({ id: 'a' }), job({ id: 'b' })];
    const format = vi.fn((j: Job[]) => `T:${j.length}`);
    const { d, copy } = deps({ loadJobs: async () => jobs, format: format as unknown as TranscriptCopyDeps['format'] });
    await runTranscriptCopy(d);
    expect(format).toHaveBeenCalledWith(jobs);
    expect(copy).toHaveBeenCalledWith('T:2');
  });

  it('reports success ONLY after copy resolves { ok: true } — and returns the copied text', async () => {
    const { d } = deps();
    const out = await runTranscriptCopy(d);
    expect(out).toEqual({ ok: true, text: 'FORMATTED-TEXT' });
  });

  it('reports a truthful failure when copy resolves { ok:false, error } — never a success', async () => {
    const { d } = deps({ copy: (async () => ({ ok: false, error: 'pasteboard denied' })) as unknown as TranscriptCopyDeps['copy'] });
    const out = await runTranscriptCopy(d);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('copy-failed');
      expect(out.error).toBe('pasteboard denied');
      expect(out.message).not.toMatch(/copied/i);
    }
  });

  it('reports copy-failed when the copy promise REJECTS (native bridge throws)', async () => {
    const { d } = deps({ copy: (async () => { throw new Error('bridge down'); }) as unknown as TranscriptCopyDeps['copy'] });
    const out = await runTranscriptCopy(d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('copy-failed');
  });

  it('distinguishes a listJobs FAILURE from a clipboard failure and never copies', async () => {
    const { d, copy } = deps({ loadJobs: async () => { throw new Error('network'); } });
    const out = await runTranscriptCopy(d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('load-failed');
    expect(copy).not.toHaveBeenCalled();
  });

  it('distinguishes an EMPTY transcript from a clipboard failure and never copies', async () => {
    const { d, copy } = deps({ loadJobs: async () => [] });
    const out = await runTranscriptCopy(d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('empty');
    expect(copy).not.toHaveBeenCalled();
  });

  it('reports no-session before any load/copy when the tab has no session', async () => {
    const load = vi.fn(async () => [job()]);
    const { d, copy } = deps({ hasSession: false, loadJobs: load });
    const out = await runTranscriptCopy(d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('no-session');
    expect(load).not.toHaveBeenCalled();
    expect(copy).not.toHaveBeenCalled();
  });
});

describe('runTranscriptCopy — formatter failures never throw or become success', () => {
  it('maps a THROWN formatter (malformed legacy job) to format-failed, never copies', async () => {
    const copy = vi.fn(async () => ({ ok: true as const }));
    const d: TranscriptCopyDeps = {
      hasSession: true,
      loadJobs: async () => [job()],
      format: () => { throw new TypeError("Cannot read properties of undefined (reading 'role')"); },
      copy: copy as unknown as TranscriptCopyDeps['copy'],
    };
    const out = await runTranscriptCopy(d);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('format-failed');
      expect(out.message).not.toMatch(/copied/i);
      expect(out.error).toMatch(/role/);
    }
    expect(copy).not.toHaveBeenCalled();
  });

  it('maps a non-string formatter result to format-failed and never copies', async () => {
    const { d, copy } = deps({ format: (() => undefined) as unknown as TranscriptCopyDeps['format'] });
    const out = await runTranscriptCopy(d);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('format-failed');
    expect(copy).not.toHaveBeenCalled();
  });
});

describe('runTranscriptCopy — malformed copy results cannot throw or fake success', () => {
  const badResults: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['empty object', {}],
    ['ok as string "true"', { ok: 'true' }],
    ['ok as number 1', { ok: 1 }],
    ['a bare string', 'ok'],
  ];
  for (const [label, bad] of badResults) {
    it(`treats a malformed copy result (${label}) as a truthful copy-failed`, async () => {
      const { d } = deps({ copy: (async () => bad) as unknown as TranscriptCopyDeps['copy'] });
      const out = await runTranscriptCopy(d);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).toBe('copy-failed');
        expect(out.message).not.toMatch(/copied/i);
      }
    });
  }
});

describe('runTranscriptCopy — exact payload delivery (unicode + large, once)', () => {
  it('passes an exact Unicode transcript byte-for-byte to copy exactly once', async () => {
    const unicode = 'café — 日本語 — 🚀🧑‍🚀 — Z̧̊algo — مرحبا — 😀\n\ttab\tend';
    const { d, copy } = deps({ format: (() => unicode) as unknown as TranscriptCopyDeps['format'] });
    const out = await runTranscriptCopy(d);
    expect(out).toEqual({ ok: true, text: unicode });
    expect(copy).toHaveBeenCalledTimes(1);
    expect(copy).toHaveBeenCalledWith(unicode);
    expect(copy.mock.calls[0][0] as string).toBe(unicode);
  });

  it('passes a large (>= 1 MiB) transcript without truncation, exactly once', async () => {
    const big = 'A'.repeat(1024 * 1024) + '🚀END';
    expect(big.length).toBeGreaterThan(1024 * 1024);
    const { d, copy } = deps({ format: (() => big) as unknown as TranscriptCopyDeps['format'] });
    const out = await runTranscriptCopy(d);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.text.length).toBe(big.length);
    expect(copy).toHaveBeenCalledTimes(1);
    const delivered = copy.mock.calls[0][0] as string;
    expect(delivered.length).toBe(big.length);
    expect(delivered).toBe(big); // byte-for-byte, no truncation
  });
});

describe('copyTextWith — native-first with a browser clipboard fallback', () => {
  it('uses the native bridge copy when present (WebKit path), NOT navigator.clipboard', async () => {
    const native = vi.fn(async () => ({ ok: true as const }));
    const writeText = vi.fn(async () => {});
    const out = await copyTextWith('hello', { native, clipboard: { writeText } });
    expect(native).toHaveBeenCalledWith('hello');
    expect(writeText).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
  });

  it('propagates a native failure envelope truthfully', async () => {
    const native = vi.fn(async () => ({ ok: false as const, error: 'no pasteboard' }));
    const out = await copyTextWith('x', { native, clipboard: null });
    expect(out).toEqual({ ok: false, error: 'no pasteboard' });
  });

  it('falls back to navigator.clipboard when the native bridge is absent (browser build)', async () => {
    const writeText = vi.fn(async () => {});
    const out = await copyTextWith('web-text', { native: undefined, clipboard: { writeText } });
    expect(writeText).toHaveBeenCalledWith('web-text');
    expect(out.ok).toBe(true);
  });

  it('reports a failure (never a false success) when the browser clipboard rejects', async () => {
    const writeText = vi.fn(async () => { throw new Error('blocked'); });
    const out = await copyTextWith('x', { native: undefined, clipboard: { writeText } });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('blocked');
  });

  it('reports a failure when neither native bridge nor clipboard is available', async () => {
    const out = await copyTextWith('x', { native: undefined, clipboard: null });
    expect(out.ok).toBe(false);
  });
});

describe('copyTextWith — strict native-result validation (no false success)', () => {
  const badNative: Array<[string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['empty object', {}],
    ['ok as string "true"', { ok: 'true' }],
    ['ok as number 1', { ok: 1 }],
    ['explicit ok:false', { ok: false }],
  ];
  for (const [label, bad] of badNative) {
    it(`treats a malformed/false native result (${label}) as failure`, async () => {
      const native = (async () => bad) as unknown as (t: string) => Promise<{ ok: boolean; error?: string }>;
      const out = await copyTextWith('x', { native, clipboard: null });
      expect(out.ok).toBe(false);
    });
  }

  it('accepts ONLY a literal ok === true from the native bridge', async () => {
    const native = (async () => ({ ok: true, extra: 1 })) as unknown as (t: string) => Promise<{ ok: boolean }>;
    const out = await copyTextWith('x', { native, clipboard: null });
    expect(out).toEqual({ ok: true });
  });

  it('does NOT fall back to the browser clipboard when native returns a malformed result', async () => {
    const writeText = vi.fn(async () => {});
    const native = (async () => undefined) as unknown as (t: string) => Promise<{ ok: boolean }>;
    const out = await copyTextWith('x', { native, clipboard: { writeText } });
    expect(out.ok).toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });

  it('reports failure (never throws) when the native bridge itself rejects', async () => {
    const native = (async () => { throw new Error('bridge exploded'); }) as unknown as (t: string) => Promise<{ ok: boolean }>;
    const out = await copyTextWith('x', { native, clipboard: null });
    expect(out.ok).toBe(false);
    expect(out.error).toBe('bridge exploded');
  });
});
