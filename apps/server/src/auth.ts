/* Better Auth (email/password) on Postgres. The `bearer` plugin lets clients
   present the session as `Authorization: Bearer <token>` (cookies aren't usable
   from React Native or WebSocket upgrades), which is how every device authenticates.
   Better Auth owns user/session/account/verification; migrateAuth() creates them. */
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { getMigrations } from 'better-auth/db/migration';
import { getPool } from './db.js';

export const auth = betterAuth({
  database: getPool(),
  emailAndPassword: { enabled: true, requireEmailVerification: false },
  secret: process.env.BETTER_AUTH_SECRET || 'dev-insecure-secret-change-me',
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:8787',
  trustedOrigins: ['*'],
  // Native clients (Electron renderer, React Native) send a `null` / no Origin,
  // which Better Auth's origin check rejects with "Missing or null Origin" in
  // production (the check is auto-skipped in test env, which hid this). Our auth is
  // BEARER-TOKEN based (not cookies), so CSRF — a cookie/browser attack — doesn't
  // apply; disabling the CSRF/origin check is the correct posture for token auth.
  advanced: { disableCSRFCheck: true },
  plugins: [bearer()],
});

/** Create/patch Better Auth's tables. Idempotent (diffs against the live schema);
    run on boot and in tests. */
export async function migrateAuth(): Promise<void> {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}

type HeaderBag = Record<string, string | string[] | undefined>;

/** Resolve the account (user) from request headers (Bearer token or cookie).
    Returns null when there's no valid session. */
export async function getSessionUser(headers: HeaderBag): Promise<{ userId: string } | null> {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') h.set(k, v);
    else if (Array.isArray(v)) h.set(k, v.join(','));
  }
  const session = await auth.api.getSession({ headers: h });
  return session?.user?.id ? { userId: session.user.id } : null;
}
