import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { auth, migrateAuth, getSessionUser } from './auth.js';
import { closeDb } from './db.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;

describe('auth config', () => {
  it('disables the CSRF/origin check so native clients (null Origin) can sign in', () => {
    // Electron/RN send a null/no Origin; the origin check is auto-skipped in test
    // env, so this asserts the prod-relevant config explicitly. Bearer-token auth
    // is not CSRF-exposed.
    expect(auth.options.advanced?.disableCSRFCheck).toBe(true);
  });
});

describe.skipIf(!HAS_DB)('auth (email/password + bearer session)', () => {
  beforeAll(async () => { await migrateAuth(); });
  afterAll(async () => { await closeDb(); });

  it('signs up and resolves the account from a bearer token', async () => {
    const email = `u${Date.now()}@example.dev`;
    const res = await auth.api.signUpEmail({ body: { email, password: 'pw-12345678', name: 'Tester' } });
    expect(res.token).toBeTruthy();

    const who = await getSessionUser({ authorization: `Bearer ${res.token}` });
    expect(who?.userId).toBeTruthy();
    expect(who?.userId).toBe(res.user.id);
  });

  it('rejects a bogus token', async () => {
    expect(await getSessionUser({ authorization: 'Bearer not-a-real-token' })).toBeNull();
    expect(await getSessionUser({})).toBeNull();
  });
});
