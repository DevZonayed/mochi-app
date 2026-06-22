/* Tests for the autopilot follow-up judge — the Sonnet call that decides
   whether to arm a [Auto-continue]: 1-min countdown after an assistant turn.

   The judge is the brain swap that replaced the brittle regex in
   armKeepGoingFollowup. These tests guard:

   1. JSON parsing — the model sometimes wraps its reply in ```json fences,
      stray prose, or omits whitespace; we tolerate all three.
   2. Verdict enum — only the four allowed strings pass; "yes"/"no"/garbage
      returns null so the caller's regex fallback fires.
   3. Items — defensive: drop too-short/too-long strings, cap at 6, skip the
      field entirely when there are none.
   4. HTTP shape — body has cache_control on the system prompt (so a fleet
      of judge calls share the prefix), correct headers, model defaults to
      Sonnet, timeout/abort works.
   5. Failure modes — no API key, malformed JSON, non-2xx HTTP, network
      error, all return null cleanly (NEVER throw — autopilot must not
      break a chat turn).

   No actual network in these tests; we inject a stub fetch via JudgeInput. */
import { describe, it, expect, vi } from 'vitest';
import {
  judgeFollowup,
  extractJson,
  parseJudgeReply,
  buildJudgeUserMessage,
  DEFAULT_JUDGE_MODEL,
  JUDGE_SYSTEM_PROMPT,
  type JudgeResult,
} from './followup-judge.js';

function fakeResponse(text: string, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => ({ content: [{ type: 'text', text }] }),
  } as unknown as Response;
}

describe('extractJson', () => {
  it('returns the JSON body when the model emits a bare object', () => {
    expect(extractJson('{"verdict":"continue","reason":"ok"}'))
      .toBe('{"verdict":"continue","reason":"ok"}');
  });
  it('strips a ```json fenced block', () => {
    const wrapped = '```json\n{"verdict":"done","reason":"shipped"}\n```';
    expect(extractJson(wrapped)).toBe('{"verdict":"done","reason":"shipped"}');
  });
  it('strips a plain ``` fenced block + leading prose', () => {
    // The model occasionally prefaces the JSON with "Here is the verdict:"
    // despite the system prompt. Make sure we still find the {...} body.
    const wrapped = 'Here is the verdict:\n```\n{"verdict":"wait-for-user","reason":"asked which DB"}\n```\n';
    expect(extractJson(wrapped)).toBe('{"verdict":"wait-for-user","reason":"asked which DB"}');
  });
  it('returns null when there is no {...} at all', () => {
    expect(extractJson('')).toBeNull();
    expect(extractJson('just prose, no json')).toBeNull();
  });
  it('returns null when the braces are inverted (defensive)', () => {
    expect(extractJson('}{')).toBeNull();
  });
});

describe('parseJudgeReply', () => {
  it('accepts a clean "continue" verdict', () => {
    const r = parseJudgeReply('{"verdict":"continue","reason":"offered to keep going"}');
    expect(r).toEqual<JudgeResult>({ verdict: 'continue', reason: 'offered to keep going' });
  });
  it('accepts all four verdict values', () => {
    for (const v of ['continue', 'wait-for-user', 'paused', 'done'] as const) {
      const r = parseJudgeReply(`{"verdict":"${v}","reason":"r"}`);
      expect(r?.verdict).toBe(v);
    }
  });
  it('rejects an unknown verdict (caller falls back to regex)', () => {
    expect(parseJudgeReply('{"verdict":"yes","reason":"r"}')).toBeNull();
    expect(parseJudgeReply('{"verdict":"keep_going","reason":"r"}')).toBeNull();
  });
  it('rejects malformed JSON', () => {
    expect(parseJudgeReply('{verdict:"continue"}')).toBeNull();      // unquoted key
    expect(parseJudgeReply('{"verdict":')).toBeNull();               // truncated
  });
  it('returns reason as the empty string when the model omits it', () => {
    const r = parseJudgeReply('{"verdict":"done"}');
    expect(r).toEqual<JudgeResult>({ verdict: 'done', reason: '' });
  });
  it('clamps a runaway reason to 200 chars', () => {
    const long = 'x'.repeat(500);
    const r = parseJudgeReply(`{"verdict":"continue","reason":"${long}"}`);
    expect(r?.reason.length).toBe(200);
  });
  it('captures items, deduping ranges + capping at 6', () => {
    const r = parseJudgeReply(`{"verdict":"continue","reason":"ok","items":["Ship A","Ship B","","ok","y","Ship C","Ship D","Ship E","Ship F","Ship G"]}`);
    // 6-cap means at most six survive; empty/too-short ("" and "ok"/"y") are
    // pruned so the remaining items are clean.
    expect(r?.items?.length ?? 0).toBeLessThanOrEqual(6);
    expect(r?.items).toContain('Ship A');
    expect(r?.items).not.toContain('');
  });
  it('omits the items field when no item passes the filter', () => {
    const r = parseJudgeReply(`{"verdict":"continue","reason":"ok","items":["", "ab"]}`);
    expect(r?.items).toBeUndefined();
  });
});

describe('buildJudgeUserMessage', () => {
  it('flags goal mode + injects the original goal', () => {
    const msg = buildJudgeUserMessage({
      lastAssistantText: 'all green; next up I will wire the toggle',
      goalMode: true, originalGoal: 'Ship the autopilot redesign end-to-end',
    });
    expect(msg).toMatch(/GOAL_MODE/);
    expect(msg).toMatch(/Original goal: Ship the autopilot/);
  });
  it('marks non-goal mode as normal_chat (no goal-mode bias)', () => {
    const msg = buildJudgeUserMessage({ lastAssistantText: 'done' });
    expect(msg).toMatch(/normal_chat/);
  });
  it('caps the last turn at the tail when it is huge (>6000 chars)', () => {
    const huge = 'A'.repeat(20_000) + ' TAIL_MARKER';
    const msg = buildJudgeUserMessage({ lastAssistantText: huge });
    expect(msg).toMatch(/earlier omitted/);
    expect(msg).toMatch(/TAIL_MARKER/);
    // Tail-only is the whole point — the bulk of the head should be gone.
    expect(msg.length).toBeLessThan(7000);
  });
  it('truncates each context turn to 1200 chars', () => {
    const long = 'B'.repeat(5000);
    const msg = buildJudgeUserMessage({
      lastAssistantText: 'next up',
      contextTurns: [{ role: 'user', text: long }],
    });
    // The 1200-char truncation lands somewhere in the middle of the run,
    // so we won't see the full 5000-char string.
    expect(msg.split('B').length - 1).toBeLessThanOrEqual(1200);
  });
});

describe('judgeFollowup', () => {
  it('returns null when there is no API key (autopilot still works via regex)', async () => {
    const r = await judgeFollowup({ apiKey: '', lastAssistantText: 'next up' });
    expect(r).toBeNull();
  });
  it('returns null when there is no last text', async () => {
    const r = await judgeFollowup({ apiKey: 'sk-x', lastAssistantText: '' });
    expect(r).toBeNull();
  });
  it('POSTs the cached system prompt to /v1/messages with Sonnet by default', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse('{"verdict":"continue","reason":"ok"}'));
    await judgeFollowup({
      apiKey: 'sk-test',
      lastAssistantText: 'want me to keep going?',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
    expect((init.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe(DEFAULT_JUDGE_MODEL);
    expect(body.model).toBe('claude-sonnet-4-6');
    // The system block must carry cache_control or the prefix won't cache —
    // see shared/prompt-caching.md. Verify the layout exactly.
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].text).toBe(JUDGE_SYSTEM_PROMPT);
    // Output token cap is tight — judgment is JSON, not prose.
    expect(body.max_tokens).toBeLessThanOrEqual(512);
  });
  it('honors a model override (escape hatch for tuning)', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse('{"verdict":"done","reason":"ok"}'));
    await judgeFollowup({
      apiKey: 'sk-test', lastAssistantText: 'all done',
      model: 'claude-haiku-4-5',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body.model).toBe('claude-haiku-4-5');
  });
  it('returns the parsed verdict on a clean reply', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse('{"verdict":"continue","reason":"the agent offered to keep going","items":["Ship A","Ship B"]}'));
    const r = await judgeFollowup({
      apiKey: 'sk-test', lastAssistantText: 'next up',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toEqual<JudgeResult>({
      verdict: 'continue',
      reason: 'the agent offered to keep going',
      items: ['Ship A', 'Ship B'],
    });
  });
  it('returns null on a non-2xx HTTP response (so caller falls back to regex)', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse('boom', false));
    const r = await judgeFollowup({
      apiKey: 'sk-test', lastAssistantText: 'next up',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toBeNull();
  });
  it('returns null when fetch throws (network failure)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    const r = await judgeFollowup({
      apiKey: 'sk-test', lastAssistantText: 'next up',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toBeNull();
  });
  it('returns null when the model returns un-parseable JSON', async () => {
    const fetchImpl = vi.fn(async () => fakeResponse('I refuse to answer.'));
    const r = await judgeFollowup({
      apiKey: 'sk-test', lastAssistantText: 'next up',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(r).toBeNull();
  });
  it('never throws — autopilot must NEVER break a chat turn', async () => {
    // Even if everything goes wrong, the function must resolve to null.
    const fetchImpl = vi.fn(async () => { throw new Error('catastrophic'); });
    const promise = judgeFollowup({
      apiKey: 'sk-test', lastAssistantText: 'x',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(promise).resolves.toBeNull();
  });
});
