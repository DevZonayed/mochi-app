/* Tests for the closed-app push fan-out. The DB-heavy ones gate on
   TEST_DATABASE_URL (same pattern as accountDevices.test.ts) so CI without a
   Postgres just skips them. The dedupe test is pure and always runs. */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { runMigrations, getDb, closeDb } from './db.js';
import {
  registerPushToken,
  unregisterPushToken,
  tokensForAccount,
  maybePush,
  setExpoFetcherForTests,
  _resetDedupeForTests,
} from './push.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;

describe.skipIf(!HAS_DB)('push token storage', () => {
  beforeAll(async () => {
    await runMigrations();
    await getDb().deleteFrom('device').execute();
  });
  afterAll(async () => { await closeDb(); });
  beforeEach(async () => {
    await getDb().deleteFrom('device').execute();
    _resetDedupeForTests();
    setExpoFetcherForTests(null);
  });

  it('registerPushToken creates the device row on first call (no upsertDevice needed)', async () => {
    // Simulates the real-world scenario: a fresh sign-in triggers push
    // registration BEFORE the /ws/remote ever opens (the WS is gated on an
    // active host). Without an upsert this would silently match 0 rows and
    // the token would be lost forever — the original bug.
    const ok = await registerPushToken('userA', 'phoneA', 'ExponentPushToken[XYZ]', 'iPhone', 'ios');
    expect(ok).toBe(true);
    const tokens = await tokensForAccount('userA');
    expect(tokens).toEqual(['ExponentPushToken[XYZ]']);
  });

  it('registerPushToken updates the token on retry (idempotent)', async () => {
    await registerPushToken('userA', 'phoneA', 'token-v1', 'iPhone', 'ios');
    await registerPushToken('userA', 'phoneA', 'token-v2', 'iPhone', 'ios');
    expect(await tokensForAccount('userA')).toEqual(['token-v2']);
  });

  it("doesn't clobber another account's row that happens to share a device id", async () => {
    // Different accounts shouldn't share a device id in practice, but the
    // (id) PK could collide if a phone reinstalled under a new account and
    // kept the old id. Registering under user B must not silently steer
    // user A's row.
    await registerPushToken('userA', 'shared', 'A-token', 'iPhone', 'ios');
    const okB = await registerPushToken('userB', 'shared', 'B-token', 'iPhone', 'ios');
    // Either the upsert filters out the cross-account row (ok=true but the A
    // row keeps its token), or it succeeds because the conflict-target's
    // user_id guard blocks it — in both cases A's token survives.
    expect(okB).toBe(true);
    const aTokens = await tokensForAccount('userA');
    expect(aTokens).toEqual(['A-token']);
  });

  it('unregisterPushToken nulls the token (sign-out)', async () => {
    await registerPushToken('userA', 'phoneA', 'tk', 'iPhone', 'ios');
    expect(await tokensForAccount('userA')).toEqual(['tk']);
    await unregisterPushToken('userA', 'phoneA');
    expect(await tokensForAccount('userA')).toEqual([]);
  });

  it('tokensForAccount is account-scoped (no cross-account leak)', async () => {
    await registerPushToken('userA', 'phoneA', 'tA', 'iPhone', 'ios');
    await registerPushToken('userB', 'phoneB', 'tB', 'iPhone', 'ios');
    expect(await tokensForAccount('userA')).toEqual(['tA']);
    expect(await tokensForAccount('userB')).toEqual(['tB']);
  });

  it("tokensForAccount excludes host devices (we never push back to the Mac)", async () => {
    // A host device wouldn't normally have a push_token, but a manual
    // tampered row shouldn't leak into the fan-out either.
    await registerPushToken('userA', 'phoneA', 'phone-token', 'iPhone', 'ios');
    // Manually seed a host row with a stray push_token.
    await getDb().insertInto('device').values({
      id: 'macA', user_id: 'userA', role: 'host', name: 'Mac', platform: 'macos',
      deck_id: null, push_token: 'should-be-ignored',
      last_seen_at: new Date(), created_at: new Date(), updated_at: new Date(),
    }).execute();
    expect(await tokensForAccount('userA')).toEqual(['phone-token']);
  });
});

describe.skipIf(!HAS_DB)('maybePush — alert-worthy event mirroring', () => {
  beforeAll(async () => {
    await runMigrations();
    await getDb().deleteFrom('device').execute();
  });
  afterAll(async () => { await closeDb(); });
  beforeEach(async () => {
    await getDb().deleteFrom('device').execute();
    _resetDedupeForTests();
  });

  it('pushes job-done to every remote in the host\'s account', async () => {
    // Two phones on the same account, plus the host (so accountForHost can resolve).
    await getDb().insertInto('device').values([
      { id: 'macA', user_id: 'userA', role: 'host', name: 'Mac', platform: 'macos', deck_id: null, push_token: null, last_seen_at: new Date(), created_at: new Date(), updated_at: new Date() },
      { id: 'phone1', user_id: 'userA', role: 'remote', name: 'iPhone', platform: 'ios', deck_id: null, push_token: 'tk1', last_seen_at: new Date(), created_at: new Date(), updated_at: new Date() },
      { id: 'phone2', user_id: 'userA', role: 'remote', name: 'Android', platform: 'android', deck_id: null, push_token: 'tk2', last_seen_at: new Date(), created_at: new Date(), updated_at: new Date() },
      // Another account's phone — MUST NOT receive userA's push.
      { id: 'phoneZ', user_id: 'userB', role: 'remote', name: 'Outsider', platform: 'ios', deck_id: null, push_token: 'tkZ', last_seen_at: new Date(), created_at: new Date(), updated_at: new Date() },
    ]).execute();

    const calls: { tokens: string[]; title: string; body: string }[] = [];
    setExpoFetcherForTests(async (_url, init) => {
      const msgs = JSON.parse(init.body) as { to: string; title: string; body: string }[];
      calls.push({ tokens: msgs.map((m) => m.to), title: msgs[0].title, body: msgs[0].body });
      return { json: async () => ({ data: msgs.map(() => ({ status: 'ok' })) }) };
    });

    await maybePush('macA', 'job', { id: 'j1', status: 'done', title: 'Build green', projectId: 'p1', sessionId: 's1' });
    expect(calls).toHaveLength(1);
    expect(calls[0].tokens.sort()).toEqual(['tk1', 'tk2']); // userB's tkZ NOT here
    expect(calls[0].title).toBe('Conversation complete');
    expect(calls[0].body).toBe('Build green');
  });

  it('skips non-terminal job updates (running/pending)', async () => {
    await getDb().insertInto('device').values([
      { id: 'macA', user_id: 'userA', role: 'host', name: 'Mac', platform: 'macos', deck_id: null, push_token: null, last_seen_at: new Date(), created_at: new Date(), updated_at: new Date() },
      { id: 'phone1', user_id: 'userA', role: 'remote', name: 'iPhone', platform: 'ios', deck_id: null, push_token: 'tk1', last_seen_at: new Date(), created_at: new Date(), updated_at: new Date() },
    ]).execute();
    let calls = 0;
    setExpoFetcherForTests(async () => { calls++; return { json: async () => ({ data: [] }) }; });
    await maybePush('macA', 'job', { id: 'j1', status: 'running' });
    await maybePush('macA', 'job', { id: 'j1', status: 'pending' });
    expect(calls).toBe(0);
  });

  it('dedupes a re-fired job-done within the TTL', async () => {
    await getDb().insertInto('device').values([
      { id: 'macA', user_id: 'userA', role: 'host', name: 'Mac', platform: 'macos', deck_id: null, push_token: null, last_seen_at: new Date(), created_at: new Date(), updated_at: new Date() },
      { id: 'phone1', user_id: 'userA', role: 'remote', name: 'iPhone', platform: 'ios', deck_id: null, push_token: 'tk1', last_seen_at: new Date(), created_at: new Date(), updated_at: new Date() },
    ]).execute();
    let calls = 0;
    setExpoFetcherForTests(async () => { calls++; return { json: async () => ({ data: [{ status: 'ok' }] }) }; });
    await maybePush('macA', 'job', { id: 'j1', status: 'done' });
    await maybePush('macA', 'job', { id: 'j1', status: 'done' }); // retry — dedupe should swallow
    expect(calls).toBe(1);
  });

  it('prunes DeviceNotRegistered tokens so future events skip them', async () => {
    await getDb().insertInto('device').values([
      { id: 'macA', user_id: 'userA', role: 'host', name: 'Mac', platform: 'macos', deck_id: null, push_token: null, last_seen_at: new Date(), created_at: new Date(), updated_at: new Date() },
      { id: 'phone-good', user_id: 'userA', role: 'remote', name: 'iPhone', platform: 'ios', deck_id: null, push_token: 'tk-good', last_seen_at: new Date(), created_at: new Date(), updated_at: new Date() },
      { id: 'phone-gone', user_id: 'userA', role: 'remote', name: 'OldPhone', platform: 'ios', deck_id: null, push_token: 'tk-gone', last_seen_at: new Date(), created_at: new Date(), updated_at: new Date() },
    ]).execute();
    setExpoFetcherForTests(async (_url, init) => {
      const msgs = JSON.parse(init.body) as { to: string }[];
      return { json: async () => ({ data: msgs.map((m) => m.to === 'tk-gone' ? { status: 'error', details: { error: 'DeviceNotRegistered' } } : { status: 'ok' }) }) };
    });
    await maybePush('macA', 'job', { id: 'j1', status: 'done' });
    // tk-gone should be pruned from the device row.
    expect((await tokensForAccount('userA')).sort()).toEqual(['tk-good']);
  });
});

describe('maybePush — pure filtering (no DB hit)', () => {
  beforeEach(() => {
    _resetDedupeForTests();
    setExpoFetcherForTests(null);
  });
  it('returns early for non-alert event names without hitting the DB', async () => {
    // No fetcher set — if maybePush tried to push we'd see an unhandled
    // promise rejection. A clean exit means the early filter worked.
    await maybePush('macA', 'host', { online: true });
    await maybePush('macA', 'state', {});
    await maybePush('macA', 'asset', { id: 'a1' });
  });
});
