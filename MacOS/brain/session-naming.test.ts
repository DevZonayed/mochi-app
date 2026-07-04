/* AI session naming — pure parsing/normalizing + the fetch contract, all
   offline via fetchImpl. The hard rule under test: a failure NEVER throws,
   it returns null so callers keep the deterministic branchSlug fallback. */

import { describe, test, expect } from 'vitest';
import { normalizeSlug, parseNamingReply, generateSessionName, DEFAULT_NAMING_MODEL, NAMING_SYSTEM_PROMPT } from './session-naming.js';

const reply = (text: string) =>
  ({ ok: true, json: async () => ({ content: [{ type: 'text', text }] }) }) as unknown as Response;

describe('normalizeSlug', () => {
  test('kebab-cases arbitrary input', () => {
    expect(normalizeSlug('Fix Auth Token Refresh!')).toBe('fix-auth-token-refresh');
    expect(normalizeSlug('  --Dark_Mode  Toggle--  ')).toBe('dark-mode-toggle');
  });
  test('caps at 32 chars without a trailing dash', () => {
    const s = normalizeSlug('a'.repeat(30) + '-bcdefgh');
    expect(s.length).toBeLessThanOrEqual(32);
    expect(s.endsWith('-')).toBe(false);
  });
  test('empty/garbage → empty string', () => {
    expect(normalizeSlug('')).toBe('');
    expect(normalizeSlug('!!!')).toBe('');
  });
});

describe('parseNamingReply', () => {
  test('parses a clean JSON object', () => {
    expect(parseNamingReply('{"title": "Fix Auth Token Refresh", "slug": "fix-auth-token-refresh"}'))
      .toEqual({ title: 'Fix Auth Token Refresh', slug: 'fix-auth-token-refresh' });
  });
  test('strips code fences and surrounding prose', () => {
    const out = parseNamingReply('```json\n{"title": "Dark Mode Toggle", "slug": "dark-mode-toggle"}\n```');
    expect(out).toEqual({ title: 'Dark Mode Toggle', slug: 'dark-mode-toggle' });
    expect(parseNamingReply('Sure! {"title": "Onboarding Redesign", "slug": "onboarding-redesign"} Done.'))
      .toEqual({ title: 'Onboarding Redesign', slug: 'onboarding-redesign' });
  });
  test('re-normalizes an unsafe slug and derives one from the title when missing', () => {
    expect(parseNamingReply('{"title": "Fix Bug", "slug": "Fix Bug!!"}')?.slug).toBe('fix-bug');
    expect(parseNamingReply('{"title": "Fix The Bug"}')?.slug).toBe('fix-the-bug');
  });
  test('trims trailing punctuation and caps the title', () => {
    expect(parseNamingReply('{"title": "Fix Auth Flow!!", "slug": "fix-auth-flow"}')?.title).toBe('Fix Auth Flow');
    const long = parseNamingReply(`{"title": "${'A Very Long Title '.repeat(6)}", "slug": "long"}`);
    expect((long?.title ?? '').length).toBeLessThanOrEqual(48);
  });
  test('null on garbage / too-short / non-JSON', () => {
    expect(parseNamingReply('')).toBeNull();
    expect(parseNamingReply('no json here')).toBeNull();
    expect(parseNamingReply('{"title": "ab", "slug": "x"}')).toBeNull();
    expect(parseNamingReply('{broken json}')).toBeNull();
  });
});

describe('generateSessionName', () => {
  test('happy path: posts to Anthropic with the frozen system prompt and parses the reply', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const named = await generateSessionName({
      userMessage: 'Please fix the auth token refresh loop in the app',
      assistantText: 'Fixed the refresh loop by …',
      apiKey: 'sk-ant-test',
      fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
        captured = { url: String(url), init: init! };
        return reply('{"title": "Fix Auth Token Refresh", "slug": "fix-auth-token-refresh"}');
      }) as typeof fetch,
    });
    expect(named).toEqual({ title: 'Fix Auth Token Refresh', slug: 'fix-auth-token-refresh' });
    expect(captured!.url).toContain('api.anthropic.com/v1/messages');
    const body = JSON.parse(String(captured!.init.body));
    expect(body.model).toBe(DEFAULT_NAMING_MODEL);
    expect(body.system[0].text).toBe(NAMING_SYSTEM_PROMPT);
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect((captured!.init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test');
  });

  test('null (never throws) on HTTP error, network error, or unusable reply', async () => {
    const base = { userMessage: 'fix it', apiKey: 'k' };
    expect(await generateSessionName({ ...base, fetchImpl: (async () => ({ ok: false } as Response)) as typeof fetch })).toBeNull();
    expect(await generateSessionName({ ...base, fetchImpl: (async () => { throw new Error('offline'); }) as typeof fetch })).toBeNull();
    expect(await generateSessionName({ ...base, fetchImpl: (async () => reply('not json')) as typeof fetch })).toBeNull();
  });

  test('null without ANY credential or user message — no fetch attempted', async () => {
    const boom = (async () => { throw new Error('should not be called'); }) as typeof fetch;
    expect(await generateSessionName({ userMessage: 'x', apiKey: '', fetchImpl: boom })).toBeNull();
    expect(await generateSessionName({ userMessage: 'x', fetchImpl: boom })).toBeNull();
    expect(await generateSessionName({ userMessage: '   ', apiKey: 'k', fetchImpl: boom })).toBeNull();
  });

  // Subscription sign-ins have NO raw API key (the operator's setup) — the
  // namer must authenticate with the Claude Code OAuth token instead of
  // silently bailing to the slug-of-the-first-message fallback (image_rnydz.png).
  test('OAuth fallback: Bearer + oauth beta header when only oauthToken is present', async () => {
    let captured: RequestInit | null = null;
    const named = await generateSessionName({
      userMessage: 'Please fix the auth token refresh loop',
      oauthToken: 'sk-ant-oat01-xyz',
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
        captured = init!;
        return reply('{"title": "Fix Auth Token Refresh", "slug": "fix-auth-token-refresh"}');
      }) as typeof fetch,
    });
    expect(named).toEqual({ title: 'Fix Auth Token Refresh', slug: 'fix-auth-token-refresh' });
    const h = captured!.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer sk-ant-oat01-xyz');
    expect(h['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(h['x-api-key']).toBeUndefined();
  });

  test('an explicit API key wins over the OAuth token', async () => {
    let captured: RequestInit | null = null;
    await generateSessionName({
      userMessage: 'fix it', apiKey: 'sk-ant-test', oauthToken: 'sk-ant-oat01-xyz',
      fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => { captured = init!; return reply('{"title": "Fix It Now", "slug": "fix-it-now"}'); }) as typeof fetch,
    });
    const h = captured!.headers as Record<string, string>;
    expect(h['x-api-key']).toBe('sk-ant-test');
    expect(h.authorization).toBeUndefined();
  });
});
