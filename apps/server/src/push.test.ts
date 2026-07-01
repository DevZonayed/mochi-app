/* Unit tests for the closed-app push module. Uses ioredis-mock (already wired
   in redis.ts when NODE_ENV=test) and a stubbed pushTransport so nothing here
   actually hits exp.host. */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  addPushToken,
  removePushToken,
  listPushTokens,
  tokenCount,
  sendExpoPush,
  maybePush,
  setPushTransport,
} from './push.js';

/** Build a fake fetch that records every call and returns a programmable JSON
    body. Mirrors exp.host's shape so the prune-DeviceNotRegistered path runs. */
function captureFetch(
  receipts: ('ok' | { error: string })[] = [],
): { calls: { url: string; body: unknown }[]; fetch: typeof fetch } {
  const calls: { url: string; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url;
    calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) });
    const data = receipts.map((r) => (r === 'ok' ? { status: 'ok' } : { status: 'error', details: { error: r.error } }));
    return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, fetch: fetchImpl };
}

/** Fresh, unique user id per test so the ioredis-mock state from prior tests
    can't bleed in (it persists for the process lifetime). */
let u = 0;
const nextUser = (): string => `user-${Date.now()}-${++u}`;

describe('push: token store', () => {
  it('add → list round-trips, dedupes, and removes', async () => {
    const userId = nextUser();
    expect(await listPushTokens(userId)).toEqual([]);
    expect(await tokenCount(userId)).toBe(0);

    expect(await addPushToken(userId, 'ExponentPushToken[a]')).toBe(1);
    expect(await addPushToken(userId, 'ExponentPushToken[a]')).toBe(1); // idempotent
    expect(await addPushToken(userId, 'ExponentPushToken[b]')).toBe(2);
    expect((await listPushTokens(userId)).sort()).toEqual(['ExponentPushToken[a]', 'ExponentPushToken[b]']);

    expect(await removePushToken(userId, 'ExponentPushToken[a]')).toBe(1);
    expect(await listPushTokens(userId)).toEqual(['ExponentPushToken[b]']);
  });

  it('ignores blank token + blank userId (defensive)', async () => {
    const userId = nextUser();
    expect(await addPushToken(userId, '')).toBe(0);
    expect(await addPushToken('', 'ExponentPushToken[x]')).toBe(0);
    expect(await listPushTokens('')).toEqual([]);
    expect(await tokenCount('')).toBe(0);
  });

  it('trims whitespace on add/remove so a stray newline can\'t orphan a token', async () => {
    const userId = nextUser();
    await addPushToken(userId, '  ExponentPushToken[c]\n');
    expect(await listPushTokens(userId)).toEqual(['ExponentPushToken[c]']);
    await removePushToken(userId, 'ExponentPushToken[c]');
    expect(await listPushTokens(userId)).toEqual([]);
  });
});

describe('push: sendExpoPush', () => {
  beforeEach(() => { /* tests install their own transport */ });

  it('POSTs one message per token with the alerts channel + nav data', async () => {
    const userId = nextUser();
    await addPushToken(userId, 'tok-1');
    await addPushToken(userId, 'tok-2');
    const cap = captureFetch(['ok', 'ok']);
    const restore = setPushTransport(cap.fetch);
    try {
      await sendExpoPush(userId, ['tok-1', 'tok-2'], 'Hi', 'There', { kind: 'job-done', hostId: 'host-x', jobId: 'j1' });
    } finally { restore(); }
    expect(cap.calls).toHaveLength(1);
    expect(cap.calls[0].url).toMatch(/exp\.host/);
    const msgs = cap.calls[0].body as Array<{ to: string; title: string; body: string; channelId: string; priority: string; data: { kind: string } }>;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].to).toBe('tok-1');
    expect(msgs[1].to).toBe('tok-2');
    expect(msgs[0].channelId).toBe('alerts');
    expect(msgs[0].priority).toBe('high');
    expect(msgs[0].data.kind).toBe('job-done');
  });

  it('prunes DeviceNotRegistered tokens so dead phones stop being targeted', async () => {
    const userId = nextUser();
    await addPushToken(userId, 'live');
    await addPushToken(userId, 'dead');
    const cap = captureFetch(['ok', { error: 'DeviceNotRegistered' }]);
    const restore = setPushTransport(cap.fetch);
    try {
      await sendExpoPush(userId, ['live', 'dead'], 'T', 'B');
    } finally { restore(); }
    expect((await listPushTokens(userId)).sort()).toEqual(['live']);
  });

  it('silently no-ops when the transport throws (Expo unreachable)', async () => {
    const userId = nextUser();
    const restore = setPushTransport(async () => { throw new Error('ENETDOWN'); });
    try {
      await expect(sendExpoPush(userId, ['t'], 'T', 'B')).resolves.toBeUndefined();
    } finally { restore(); }
  });

  it('no-ops for an empty token list (no HTTP call)', async () => {
    const cap = captureFetch();
    const restore = setPushTransport(cap.fetch);
    try {
      await sendExpoPush('anyone', [], 'T', 'B');
    } finally { restore(); }
    expect(cap.calls).toHaveLength(0);
  });
});

describe('push: maybePush event mapping', () => {
  it('returns false when the user has no tokens (no HTTP call)', async () => {
    const userId = nextUser();
    const cap = captureFetch();
    const restore = setPushTransport(cap.fetch);
    try {
      expect(await maybePush(userId, 'host-1', 'job', { id: 'j1', status: 'done', title: 'x' })).toBe(false);
    } finally { restore(); }
    expect(cap.calls).toHaveLength(0);
  });

  it('returns false for non-alert events (status:running, unknown event names)', async () => {
    const userId = nextUser();
    await addPushToken(userId, 't');
    const cap = captureFetch();
    const restore = setPushTransport(cap.fetch);
    try {
      expect(await maybePush(userId, 'h', 'job', { id: 'j', status: 'running' })).toBe(false);
      expect(await maybePush(userId, 'h', 'snapshot', { foo: 'bar' })).toBe(false);
      expect(await maybePush(userId, 'h', 'approval', { id: 'a', status: 'resolved' })).toBe(false);
    } finally { restore(); }
    expect(cap.calls).toHaveLength(0);
  });

  it('pushes job:done with hostId/projectId/sessionId/jobId in nav data', async () => {
    const userId = nextUser();
    await addPushToken(userId, 'tk');
    const cap = captureFetch(['ok']);
    const restore = setPushTransport(cap.fetch);
    try {
      expect(await maybePush(userId, 'host-A', 'job', { id: 'job-1', status: 'done', title: 'My run', projectId: 'p1', sessionId: 's1' })).toBe(true);
    } finally { restore(); }
    const msg = (cap.calls[0].body as Array<{ title: string; body: string; data: { kind: string; hostId: string; jobId: string; projectId: string; sessionId: string } }>)[0];
    expect(msg.title).toBe('Conversation complete');
    expect(msg.body).toBe('My run');
    expect(msg.data).toEqual({ kind: 'job-done', hostId: 'host-A', jobId: 'job-1', projectId: 'p1', sessionId: 's1' });
  });

  it('pushes job:failed with a fallback body when title is missing', async () => {
    const userId = nextUser();
    await addPushToken(userId, 'tk');
    const cap = captureFetch(['ok']);
    const restore = setPushTransport(cap.fetch);
    try {
      expect(await maybePush(userId, 'h', 'job', { id: 'job-2', status: 'failed' })).toBe(true);
    } finally { restore(); }
    const msg = (cap.calls[0].body as Array<{ title: string; body: string; data: { kind: string } }>)[0];
    expect(msg.title).toBe('Job failed');
    expect(msg.body).toBe('A run failed on your Mac.');
    expect(msg.data.kind).toBe('job-failed');
  });

  it('pushes approval:pending with approvalId + projectId in nav', async () => {
    const userId = nextUser();
    await addPushToken(userId, 'tk');
    const cap = captureFetch(['ok']);
    const restore = setPushTransport(cap.fetch);
    try {
      expect(await maybePush(userId, 'host-B', 'approval', { id: 'a1', status: 'pending', title: 'Edit file?', projectId: 'p1', jobId: 'j1', sessionId: 's2' })).toBe(true);
    } finally { restore(); }
    const msg = (cap.calls[0].body as Array<{ title: string; data: { kind: string; approvalId: string; projectId: string; sessionId: string; jobId: string } }>)[0];
    expect(msg.title).toBe('Needs your attention');
    expect(msg.data).toEqual({ kind: 'approval', hostId: 'host-B', approvalId: 'a1', projectId: 'p1', sessionId: 's2', jobId: 'j1' });
  });

  it('pushes schedule-late', async () => {
    const userId = nextUser();
    await addPushToken(userId, 'tk');
    const cap = captureFetch(['ok']);
    const restore = setPushTransport(cap.fetch);
    try {
      expect(await maybePush(userId, 'h', 'schedule-late', { id: 's-1', title: 'Weekly digest', firedAt: 123, projectId: 'p1', sessionId: 'sess-1' })).toBe(true);
    } finally { restore(); }
    const msg = (cap.calls[0].body as Array<{ title: string; data: { kind: string } }>)[0];
    expect(msg.title).toBe('Scheduled task ran late');
    expect(msg.data.kind).toBe('schedule-late');
  });

  it('dedupes the same event within the TTL window — a brief WS reconnect doesn\'t double-buzz', async () => {
    const userId = nextUser();
    await addPushToken(userId, 'tk');
    const cap = captureFetch(['ok']);
    const restore = setPushTransport(cap.fetch);
    try {
      expect(await maybePush(userId, 'h', 'job', { id: 'dup-1', status: 'done' })).toBe(true);
      expect(await maybePush(userId, 'h', 'job', { id: 'dup-1', status: 'done' })).toBe(false);
    } finally { restore(); }
    expect(cap.calls).toHaveLength(1);
  });

  it('different events with the same job id (done vs failed) both push (independent dedupe keys)', async () => {
    const userId = nextUser();
    await addPushToken(userId, 'tk');
    const cap = captureFetch(['ok', 'ok']);
    const restore = setPushTransport(cap.fetch);
    try {
      expect(await maybePush(userId, 'h', 'job', { id: 'pair-1', status: 'done' })).toBe(true);
      expect(await maybePush(userId, 'h', 'job', { id: 'pair-1', status: 'failed' })).toBe(true);
    } finally { restore(); }
    expect(cap.calls).toHaveLength(2);
  });
});
