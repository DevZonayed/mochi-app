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
import { addPushToken, removePushToken } from './push.js';

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

  // ── Expo push registration ────────────────────────────────────────────
  // The phone POSTs its Expo push token here at launch + on foreground; we
  // mirror the host's alert-worthy events into Expo so a CLOSED app still
  // gets an OS notification. Account-scoped: only the user's own Macs can
  // cause their own phones to buzz. See push.ts for the full rationale.
  app.post('/api/push/register', async (req) => {
    const userId = (req as ReqWithUser).userId as string;
    const { token } = (req.body ?? {}) as { token?: string };
    const devices = await addPushToken(userId, token ?? '');
    return { ok: true, devices };
  });
  app.post('/api/push/unregister', async (req) => {
    const userId = (req as ReqWithUser).userId as string;
    const { token } = (req.body ?? {}) as { token?: string };
    const devices = await removePushToken(userId, token ?? '');
    return { ok: true, devices };
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
