/* Context-project triage judge — the cheap "is this WhatsApp burst worth the
   operator agent's attention?" gate. Pure parse/build helpers + the raw-fetch
   call with an injected fetch stub (no network, no SDK). */
import { describe, it, expect, vi } from 'vitest';

import {
  extractTriageJson,
  parseTriageReply,
  buildTriageUserMessage,
  triageWaBurst,
  TRIAGE_SYSTEM_PROMPT,
  DEFAULT_TRIAGE_MODEL,
} from './context-triage.js';

const reply = (obj: unknown) => JSON.stringify(obj);

describe('extractTriageJson', () => {
  it('returns the bare object as-is', () => {
    expect(extractTriageJson('{"a":1}')).toBe('{"a":1}');
  });
  it('strips markdown fences and surrounding prose', () => {
    expect(extractTriageJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractTriageJson('Sure! Here you go: {"a":1} hope that helps')).toBe('{"a":1}');
  });
  it('null on garbage / no braces', () => {
    expect(extractTriageJson('')).toBeNull();
    expect(extractTriageJson('no json here')).toBeNull();
  });
});

describe('parseTriageReply', () => {
  it('parses a clean verdict', () => {
    const r = parseTriageReply(reply({ attention: true, kind: 'bug', reason: 'checkout 500', summary: 'Client reports checkout error.' }))!;
    expect(r).toEqual({ attention: true, kind: 'bug', reason: 'checkout 500', summary: 'Client reports checkout error.' });
  });
  it('rejects unknown kinds and non-boolean attention', () => {
    expect(parseTriageReply(reply({ attention: true, kind: 'urgent' }))).toBeNull();
    expect(parseTriageReply(reply({ attention: 'yes', kind: 'bug' }))).toBeNull();
    expect(parseTriageReply('not json at all')).toBeNull();
  });
  it('mechanical floor: bug/task/question are attention=true even when the model said false', () => {
    for (const kind of ['bug', 'task', 'question'] as const) {
      expect(parseTriageReply(reply({ attention: false, kind }))!.attention).toBe(true);
    }
    // update/chatter keep the model's verdict
    expect(parseTriageReply(reply({ attention: false, kind: 'update' }))!.attention).toBe(false);
    expect(parseTriageReply(reply({ attention: false, kind: 'chatter' }))!.attention).toBe(false);
    expect(parseTriageReply(reply({ attention: true, kind: 'update' }))!.attention).toBe(true);
  });
  it('defaults missing reason/summary to empty strings and caps their length', () => {
    const r = parseTriageReply(reply({ attention: true, kind: 'task', reason: 'x'.repeat(500), summary: 'y'.repeat(2000) }))!;
    expect(r.reason).toHaveLength(200);
    expect(r.summary).toHaveLength(600);
    const bare = parseTriageReply(reply({ attention: false, kind: 'chatter' }))!;
    expect(bare.reason).toBe('');
    expect(bare.summary).toBe('');
  });
});

describe('buildTriageUserMessage', () => {
  it('fences the transcript and flags it untrusted', () => {
    const m = buildTriageUserMessage({ chatName: 'Acme', transcript: '10:00 Bob: the site is down', linkedProjectNames: ['acme-web'] });
    expect(m).toContain('Chat: "Acme"');
    expect(m).toContain('Connected projects: acme-web');
    expect(m).toContain('UNTRUSTED');
    expect(m).toContain('--- TRANSCRIPT START ---');
    expect(m).toContain('the site is down');
    expect(m).toContain('--- TRANSCRIPT END ---');
  });
  it('keeps the TAIL of an oversized transcript (freshest messages carry the signal)', () => {
    const t = 'OLD-'.repeat(4000) + 'FRESH-END';
    const m = buildTriageUserMessage({ chatName: 'C', transcript: t });
    expect(m).toContain('FRESH-END');
    expect(m).toContain('(earlier omitted)');
    expect(m.length).toBeLessThan(t.length); // actually truncated
  });
  it('omits the connected-projects line when none are linked', () => {
    expect(buildTriageUserMessage({ chatName: 'C', transcript: 'hi' })).not.toContain('Connected projects');
  });
});

/** A fetch stub that records the request and answers with a canned model reply. */
function fetchStub(modelText: string, opts: { status?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return {
      ok: (opts.status ?? 200) === 200,
      status: opts.status ?? 200,
      json: async () => ({ content: [{ type: 'text', text: modelText }] }),
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

const verdict = reply({ attention: true, kind: 'question', reason: 'status ask', summary: 'Client asks for status.' });

describe('triageWaBurst', () => {
  it('returns the parsed verdict on a clean reply (api-key auth)', async () => {
    const { impl, calls } = fetchStub(verdict);
    const r = await triageWaBurst({ chatName: 'Acme', transcript: '10:00 Bob: any update?', apiKey: 'sk-test', fetchImpl: impl });
    expect(r?.kind).toBe('question');
    expect(r?.attention).toBe(true);
    const { init, url } = calls[0];
    expect(url).toContain('api.anthropic.com/v1/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test');
    expect(headers.authorization).toBeUndefined();
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(DEFAULT_TRIAGE_MODEL); // the cheap tier
    expect(body.system[0].text).toBe(TRIAGE_SYSTEM_PROMPT);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' }); // prompt caching stays on
  });

  it('uses subscription Bearer + oauth beta header when only the OAuth token is present', async () => {
    const { impl, calls } = fetchStub(verdict);
    await triageWaBurst({ chatName: 'C', transcript: 'x', oauthToken: 'oat-1', fetchImpl: impl });
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer oat-1');
    expect(headers['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(headers['x-api-key']).toBeUndefined();
  });

  it('null without creds or transcript — and never calls fetch', async () => {
    const { impl, calls } = fetchStub(verdict);
    expect(await triageWaBurst({ chatName: 'C', transcript: 'x', fetchImpl: impl })).toBeNull();
    expect(await triageWaBurst({ chatName: 'C', transcript: '  ', apiKey: 'k', fetchImpl: impl })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('null on HTTP failure, thrown fetch, or an unparseable reply (caller falls back)', async () => {
    const bad = fetchStub(verdict, { status: 529 });
    expect(await triageWaBurst({ chatName: 'C', transcript: 'x', apiKey: 'k', fetchImpl: bad.impl })).toBeNull();

    const boom = (async () => { throw new Error('net down'); }) as unknown as typeof fetch;
    expect(await triageWaBurst({ chatName: 'C', transcript: 'x', apiKey: 'k', fetchImpl: boom })).toBeNull();

    const prose = fetchStub('I think this is probably fine.');
    expect(await triageWaBurst({ chatName: 'C', transcript: 'x', apiKey: 'k', fetchImpl: prose.impl })).toBeNull();
  });

  it('honors a model override', async () => {
    const { impl, calls } = fetchStub(verdict);
    await triageWaBurst({ chatName: 'C', transcript: 'x', apiKey: 'k', model: 'claude-sonnet-4-5', fetchImpl: impl });
    expect(JSON.parse(String(calls[0].init.body)).model).toBe('claude-sonnet-4-5');
  });

  it('aborts a hung call via the timeout and resolves null', async () => {
    vi.useFakeTimers();
    try {
      const impl = ((url: unknown, init?: RequestInit) => new Promise((_res, rej) => {
        init!.signal!.addEventListener('abort', () => rej(new Error('aborted')));
      })) as unknown as typeof fetch;
      const p = triageWaBurst({ chatName: 'C', transcript: 'x', apiKey: 'k', fetchImpl: impl, timeoutMs: 2000 });
      await vi.advanceTimersByTimeAsync(2100);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
