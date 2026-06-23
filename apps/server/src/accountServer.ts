/* The account multi-tenant server: Better Auth + account-scoped REST + the host/
   remote WS endpoints. Stateless; coordination via Redis. Replaces the pairing
   deck model (see server.ts) at cutover. */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { toNodeHandler } from 'better-auth/node';
import { auth, migrateAuth } from './auth.js';
import { runMigrations } from './db.js';
import { installAuthHook, deviceIdOf, type ReqWithUser } from './authHook.js';
import { listDevicesForUser, assertHostInAccount } from './accountDevices.js';
import { getSnapshot } from './redis.js';
import { forwardCommand } from './routing.js';
import { routeSignal, turnCredentials } from './webrtc.js';
import { registerHostWs } from './wsHost.js';
import { registerRemoteWs } from './wsRemote.js';
import { registerPushToken, unregisterPushToken } from './push.js';

/** Run all migrations (device + Better Auth). Call before listen(). */
export async function migrateAll(): Promise<void> {
  await runMigrations();
  await migrateAuth();
}

export function buildAccountServer(): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 200 * 1024 * 1024 });
  app.register(cors, { origin: true });
  app.register(websocket);

  // Better Auth owns /api/auth/* — handle it in onRequest (before body parsing)
  // and hijack the reply so Better Auth reads the raw request stream itself.
  const baHandler = toNodeHandler(auth);
  app.addHook('onRequest', async (req, reply) => {
    if ((req.raw.url ?? '').startsWith('/api/auth/')) {
      reply.hijack();
      await baHandler(req.raw, reply.raw);
    }
  });

  // Tolerate empty JSON bodies on bodyless POSTs.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const s = typeof body === 'string' ? body : '';
    if (s.trim() === '') { done(null, undefined); return; }
    try { done(null, JSON.parse(s)); } catch (e) { done(e instanceof Error ? e : new Error('invalid json'), undefined); }
  });

  installAuthHook(app);

  app.get('/health', async () => ({ ok: true, name: 'maestro-account-server', mode: 'account-multitenant' }));

  app.get('/api/devices', async (req) => listDevicesForUser((req as ReqWithUser).userId as string));

  app.get('/api/turn-credentials', async () => turnCredentials());

  app.get('/api/sync', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const host = (req.query as { host?: string }).host;
    if (!host) { await reply.code(400).send({ error: 'host query param required' }); return; }
    await assertHostInAccount(userId, host);
    return { host, snapshot: await getSnapshot(host) };
  });

  app.post('/api/signal', async (req) => {
    const userId = (req as ReqWithUser).userId as string;
    const { toDeviceId, signal } = (req.body ?? {}) as { toDeviceId?: string; signal?: unknown };
    await routeSignal(userId, deviceIdOf(req) ?? '', toDeviceId ?? '', signal);
    return { ok: true };
  });

  // ── Closed-app push registration ────────────────────────────────────────
  // The remote (phone) registers its Expo push token here so the relay can
  // wake the closed app on alert-worthy host events (see push.ts). The token
  // is stored on the caller's device row (must already exist via wsRemote
  // upsertDevice on its first WS connect) and is account-scoped — another
  // account's token can never be steered here. 400 instead of a silent 200
  // when the device id is missing so the mobile client logs a real error.
  app.post('/api/push/register', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const deviceId = deviceIdOf(req);
    const { token } = (req.body ?? {}) as { token?: string };
    if (!deviceId) { await reply.code(400).send({ error: 'x-maestro-device-id header required' }); return; }
    if (typeof token !== 'string' || !token.trim()) { await reply.code(400).send({ error: 'token required' }); return; }
    // The device row may not exist yet (the WS is gated on picking an active
    // host, so on first sign-in the registration call lands BEFORE the WS).
    // Pass the device label so registerPushToken's UPSERT can seed the row.
    const name = typeof req.headers['x-maestro-device'] === 'string' ? (req.headers['x-maestro-device'] as string) : '';
    const platform = typeof req.headers['x-maestro-platform'] === 'string' ? (req.headers['x-maestro-platform'] as string) : '';
    const ok = await registerPushToken(userId, deviceId, token, name, platform);
    return { ok, deviceId };
  });
  app.post('/api/push/unregister', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const deviceId = deviceIdOf(req);
    if (!deviceId) { await reply.code(400).send({ error: 'x-maestro-device-id header required' }); return; }
    const ok = await unregisterPushToken(userId, deviceId);
    return { ok, deviceId };
  });

  // Generic account-scoped command forward. The legacy /api/jobs|projects|… routes
  // map onto this (method = the host RPC name) during the full cutover.
  app.post('/api/cmd', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const { hostId, method, params } = (req.body ?? {}) as { hostId?: string; method?: string; params?: Record<string, unknown> };
    if (!hostId || !method) { await reply.code(400).send({ error: 'hostId + method required' }); return; }
    try {
      return await forwardCommand(userId, hostId, method, params ?? {});
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // WS routes must live inside a plugin scope so @fastify/websocket (v11) has
  // decorated the instance before the {websocket:true} routes are evaluated;
  // registering on the root app directly yields a plain 200 instead of a 101 upgrade.
  app.register(async (scope) => {
    registerHostWs(scope);
    registerRemoteWs(scope);
  });
  return app;
}
