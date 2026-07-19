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
import { registerScreenWs } from './wsScreen.js';
import { SHADOW_SCREEN_ENVELOPE_MAX_BYTES } from '@maestro/realtime/shadowScreenStream';

/** Socket-level WS frame cap (M2): screen-frame envelope max + a small control margin. */
const SHADOW_SCREEN_WS_MAX_PAYLOAD = SHADOW_SCREEN_ENVELOPE_MAX_BYTES + 64 * 1024;
import { addPushToken, removePushToken } from './push.js';
import {
  acquireShadowLease,
  ackShadowCommand,
  listControllerCommandAcks,
  getScopeAuthority,
  uploadAuthorityTransitions,
  renewLeaseWithTransitions,
  listAuthorityTransitions,
  markAuthorityTransitionConsumed,
  connectShadowController,
  enqueueShadowCommand,
  pullShadowCommands,
  publishShadowSnapshot,
  putShadowBlob,
  putShadowChunk,
  readShadowBlobRange,
  revokeShadowController,
  updateShadowCursor,
  updateShadowTransport,
  uploadShadowEvents,
} from './shadowRelay.js';
import {
  readShadowRequestProof,
  verifyShadowRequestProof,
} from './shadowRequestAuth.js';
import {
  registerHostIdentity,
  createEnrollmentSession,
  submitEnrollmentRequest,
  approveEnrollment,
  denyEnrollment,
  cancelEnrollment,
  listEnrollmentSessions,
  listPendingEnrollmentRequests,
  listEnrolledControllers,
  listAccountEnrollmentMacs,
  createAccountEnrollmentChallenge,
  pollEnrollment,
  revokeEnrolledController,
} from './shadowEnrollmentService.js';
import type { FastifyRequest } from 'fastify';

/** Run all migrations (device + Better Auth). Call before listen(). */
export async function migrateAll(): Promise<void> {
  await runMigrations();
  await migrateAuth();
}

/** CORS headers for a hijacked Better Auth (`/api/auth/*`) response.

   We hijack the reply and let Better Auth write the raw response itself (see
   below), which means `@fastify/cors`'s `onSend` hook never runs for these
   routes. Without this, the OPTIONS preflight gets CORS headers (cors handles it
   directly) but the ACTUAL response does not — so a real browser origin (the
   desktop DEV build at http://localhost:5173) can't read it and `fetch` throws
   "Failed to fetch" on sign-in. Packaged apps load from file:// (null Origin →
   not a CORS request) so they were unaffected and masked the bug.

   We reflect the request Origin (matching the `cors({ origin: true })` policy)
   and expose `set-auth-token` — the header the renderer reads the session token
   from, which the browser hides on cross-origin responses unless exposed. */
export function authCorsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Expose-Headers': 'set-auth-token',
    Vary: 'Origin',
  };
}

function shadowRouteStatus(message: string, statusCode: number): Error & { statusCode: number } {
  const err = new Error(message) as Error & { statusCode: number };
  err.statusCode = statusCode;
  return err;
}

function parseShadowJsonObjectParam(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) {
    throw shadowRouteStatus(`${name} query param required`, 400);
  }
  if (value.length > 16 * 1024) {
    throw shadowRouteStatus(`${name} query param too large`, 413);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw shadowRouteStatus(`invalid ${name} json`, 400);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw shadowRouteStatus(`${name} must be a json object`, 400);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Enforce a signed shadow request proof for an enrolled-host / enrolled-controller
 * route. Returns the verified device id (which equals `x-maestro-device-id`).
 * Throws a bounded status error if the proof is missing/invalid/replayed/stale or
 * the body/path was altered. Bootstrap enrollment routes verify their own
 * body-level proofs and do NOT use this.
 */
async function enrolledShadowAuth(req: FastifyRequest, requiredClass: 'enrolled-host' | 'enrolled-controller'): Promise<string> {
  const accountId = (req as ReqWithUser).userId as string;
  const did = deviceIdOf(req);
  if (!did) throw shadowRouteStatus('device id required', 400);
  const proof = readShadowRequestProof(req.headers as Record<string, unknown>);
  const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody;
  await verifyShadowRequestProof(
    { accountId, method: req.method, rawUrl: req.raw.url ?? '', rawBody: typeof rawBody === 'string' ? rawBody : '', nowMs: Date.now() },
    proof,
    requiredClass,
    did,
  );
  return did;
}

export function buildAccountServer(): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 200 * 1024 * 1024 });
  app.register(cors, { origin: true });
  // M2: cap the WebSocket frame size at the socket so an oversize/bomb binary is
  // dropped by `ws` BEFORE it is buffered or reaches any hub. Sized just above the
  // screen-frame envelope max (the largest legitimate binary WS message); host/remote
  // JSON control + snapshot messages are far smaller. The screen relay ALSO re-checks
  // SHADOW_SCREEN_ENVELOPE_MAX_BYTES at the app layer (defense in depth).
  app.register(websocket, { options: { maxPayload: SHADOW_SCREEN_WS_MAX_PAYLOAD } });

  // Better Auth owns /api/auth/* — handle it in onRequest (before body parsing)
  // and hijack the reply so Better Auth reads the raw request stream itself.
  const baHandler = toNodeHandler(auth);
  app.addHook('onRequest', async (req, reply) => {
    if ((req.raw.url ?? '').startsWith('/api/auth/')) {
      // Set CORS headers on the raw response BEFORE hijacking — @fastify/cors's
      // onSend hook does not run for a hijacked reply, so without this the actual
      // auth response reaches a browser with no Access-Control-Allow-Origin. See
      // authCorsHeaders() for the full rationale.
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;
      for (const [k, v] of Object.entries(authCorsHeaders(origin))) reply.raw.setHeader(k, v);
      reply.hijack();
      await baHandler(req.raw, reply.raw);
    }
  });

  // Tolerate empty JSON bodies on bodyless POSTs. Stash the raw request string so
  // signed-request auth can bind the exact body bytes the client hashed.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    const s = typeof body === 'string' ? body : '';
    (req as FastifyRequest & { rawBody?: string }).rawBody = s;
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

  app.post('/api/shadow/lease', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const body = (req.body ?? {}) as { scopeId?: string; leaseId?: string; currentFence?: unknown; ttlMs?: number };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      return await acquireShadowLease({ accountId: userId, hostDeviceId: did, scopeId: body.scopeId, requestedLeaseId: body.leaseId, currentFence: body.currentFence, ttlMs: body.ttlMs });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.post('/api/shadow/events', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const { events } = (req.body ?? {}) as { events?: unknown[] };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      return await uploadShadowEvents({ accountId: userId, hostDeviceId: did, events: events ?? [] });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.post('/api/shadow/connect', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const { hello } = (req.body ?? {}) as { hello?: unknown };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-controller');
      return await connectShadowController({ accountId: userId, controllerDeviceId: did, hello });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.post('/api/shadow/cursor', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const body = (req.body ?? {}) as { fence?: unknown; lastSeq?: number; lastEventId?: string; lastDigest?: string };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-controller');
      return await updateShadowCursor({ accountId: userId, controllerDeviceId: did, fence: body.fence, lastSeq: body.lastSeq ?? -1, lastEventId: body.lastEventId, lastDigest: body.lastDigest });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.post('/api/shadow/snapshots', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      return await publishShadowSnapshot({ accountId: userId, hostDeviceId: did, ...(req.body as Record<string, unknown>) } as Parameters<typeof publishShadowSnapshot>[0]);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.post('/api/shadow/chunks', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      return await putShadowChunk({ accountId: userId, hostDeviceId: did, ...(req.body as Record<string, unknown>) } as Parameters<typeof putShadowChunk>[0]);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.post('/api/shadow/blobs', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      return await putShadowBlob({ accountId: userId, hostDeviceId: did, ...(req.body as Record<string, unknown>) } as Parameters<typeof putShadowBlob>[0]);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.get('/api/shadow/blobs/:contentId/:variant', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const params = req.params as { contentId: string; variant: string };
    const query = req.query as { capability?: string; start?: string; endExclusive?: string };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-controller');
      if (!query.capability) throw shadowRouteStatus('capability query param required', 400);
      return await readShadowBlobRange({ accountId: userId, controllerDeviceId: did, capability: parseShadowJsonObjectParam(query.capability, 'capability'), contentId: params.contentId, variant: params.variant, start: query.start ? Number(query.start) : undefined, endExclusive: query.endExclusive ? Number(query.endExclusive) : undefined });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.post('/api/shadow/commands', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-controller');
      return await enqueueShadowCommand({ accountId: userId, controllerDeviceId: did, ...(req.body as Record<string, unknown>) } as Parameters<typeof enqueueShadowCommand>[0]);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.get('/api/shadow/commands', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const query = req.query as { scopeId?: string; limit?: string };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      if (!query.scopeId) throw shadowRouteStatus('scopeId required', 400);
      return await pullShadowCommands({ accountId: userId, hostDeviceId: did, scopeId: query.scopeId, limit: query.limit ? Number(query.limit) : undefined });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // Enrolled-controller: poll this controller's own command ACKs (ciphertext only).
  app.get('/api/shadow/commands/acks', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const query = req.query as { fence?: string; limit?: string };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-controller');
      if (!query.fence) throw shadowRouteStatus('fence required', 400);
      return { acks: await listControllerCommandAcks({ accountId: userId, controllerDeviceId: did, fence: parseShadowJsonObjectParam(query.fence, 'fence'), limit: query.limit ? Number(query.limit) : undefined }) };
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // Enrolled-controller: reconcile the server-authoritative lease fence + expiry.
  app.get('/api/shadow/authority', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const query = req.query as { scopeId?: string };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-controller');
      if (!query.scopeId) throw shadowRouteStatus('scopeId required', 400);
      return await getScopeAuthority({ accountId: userId, controllerDeviceId: did, scopeId: query.scopeId });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // Enrolled-host: ATOMIC lease renewal + per-controller transition store (one txn).
  app.post('/api/shadow/lease/renew-with-transitions', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const body = (req.body ?? {}) as { scopeId?: string; renewalId?: string; currentFence?: unknown; expectedCurrentExpiresAt?: number; requestedExpiresAt?: number; grants?: unknown[] };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      if (!body.scopeId || !body.renewalId || typeof body.requestedExpiresAt !== 'number') throw shadowRouteStatus('scopeId, renewalId, requestedExpiresAt required', 400);
      return await renewLeaseWithTransitions({ accountId: userId, hostDeviceId: did, scopeId: body.scopeId, renewalId: body.renewalId, currentFence: body.currentFence, expectedCurrentExpiresAt: body.expectedCurrentExpiresAt, requestedExpiresAt: body.requestedExpiresAt, grants: body.grants ?? [] });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // Enrolled-host: upload per-controller signed authority-transition grants.
  app.post('/api/shadow/transitions', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const body = (req.body ?? {}) as { scopeId?: string; grants?: unknown[] };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      if (!body.scopeId) throw shadowRouteStatus('scopeId required', 400);
      return await uploadAuthorityTransitions({ accountId: userId, hostDeviceId: did, scopeId: body.scopeId, grants: body.grants ?? [] });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // Enrolled-controller: fetch this controller's pending host-signed transitions.
  app.get('/api/shadow/transitions', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const query = req.query as { scopeId?: string };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-controller');
      if (!query.scopeId) throw shadowRouteStatus('scopeId required', 400);
      return await listAuthorityTransitions({ accountId: userId, controllerDeviceId: did, scopeId: query.scopeId });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // Enrolled-controller: consume (idempotent) an applied transition.
  app.post('/api/shadow/transitions/:transitionId/consume', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const params = req.params as { transitionId: string };
    const body = (req.body ?? {}) as { scopeId?: string };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-controller');
      if (!body.scopeId) throw shadowRouteStatus('scopeId required', 400);
      return await markAuthorityTransitionConsumed({ accountId: userId, controllerDeviceId: did, scopeId: body.scopeId, transitionId: params.transitionId });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.post('/api/shadow/commands/:commandId/ack', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const params = req.params as { commandId: string };
    const body = (req.body ?? {}) as { scopeId?: string; ackCiphertext?: string; ackDigest?: string };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      if (!body.scopeId || !body.ackCiphertext || !body.ackDigest) throw shadowRouteStatus('scopeId, ackCiphertext, ackDigest required', 400);
      return await ackShadowCommand({ accountId: userId, hostDeviceId: did, scopeId: body.scopeId, commandId: params.commandId, ackCiphertext: body.ackCiphertext, ackDigest: body.ackDigest });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.post('/api/shadow/transport', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-controller');
      return await updateShadowTransport({ accountId: userId, controllerDeviceId: did, ...(req.body as Record<string, unknown>) } as Parameters<typeof updateShadowTransport>[0]);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.post('/api/shadow/revoke-controller', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    try {
      await enrolledShadowAuth(req, 'enrolled-host');
      return await revokeShadowController({ accountId: userId, ...(req.body as Record<string, unknown>) } as Parameters<typeof revokeShadowController>[0]);
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // ── Enrollment surface ──────────────────────────────────────────────────
  // Bootstrap-host: TOFU host identity registration (self-signed proof of the
  // key being registered — no prior registration exists).
  app.post('/api/shadow/enroll/host-identity', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const did = deviceIdOf(req);
    const body = (req.body ?? {}) as { signingPublicKey?: string; agreementPublicKey?: string; registrationSignature?: string; rotationSignature?: string };
    if (!did) { await reply.code(400).send({ error: 'device id required' }); return; }
    try {
      return await registerHostIdentity({ accountId: userId, hostDeviceId: did, signingPublicKey: body.signingPublicKey ?? '', agreementPublicKey: body.agreementPublicKey ?? '', registrationSignature: body.registrationSignature ?? '', rotationSignature: body.rotationSignature, nowMs: Date.now() });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // Enrolled-host: create a single-use enrollment session (signed request proof).
  app.post('/api/shadow/enroll/session', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const body = (req.body ?? {}) as { sessionId?: string; hostSigningKeyId?: string; secretSalt?: string; secretVerifier?: string; relayOrigin?: string; ttlMs?: number; expectedFingerprint?: string };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      return await createEnrollmentSession({ accountId: userId, hostDeviceId: did, sessionId: body.sessionId ?? '', hostSigningKeyId: body.hostSigningKeyId ?? '', secretSalt: body.secretSalt ?? '', secretVerifier: body.secretVerifier ?? '', relayOrigin: body.relayOrigin ?? '', ttlMs: body.ttlMs, expectedFingerprint: body.expectedFingerprint, nowMs: Date.now() });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // Bootstrap-controller: submit a signed enrollment request + one-time secret proof.
  app.post('/api/shadow/enroll/request', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const body = (req.body ?? {}) as { sessionId?: string; request?: unknown; presentedSecret?: string; idempotencyKey?: string };
    try {
      return await submitEnrollmentRequest({ accountId: userId, sessionId: body.sessionId ?? '', request: body.request as Parameters<typeof submitEnrollmentRequest>[0]['request'], presentedSecret: body.presentedSecret ?? '', idempotencyKey: body.idempotencyKey, nowMs: Date.now() });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // Account-controller: identity/discovery only. Same-account Macs with active
  // host identities are visible; online is true only while the live host lease is
  // unexpired. This route never grants control.
  app.get('/api/shadow/enroll/account/macs', async (req) => {
    const userId = (req as ReqWithUser).userId as string;
    return { macs: await listAccountEnrollmentMacs({ accountId: userId, nowMs: Date.now() }) };
  });

  // Account-controller: mint a high-entropy, one-time, short-lived challenge for
  // a selected same-account Mac. The phone must still submit a signed request,
  // and the Mac must still approve before any grant exists.
  app.post('/api/shadow/enroll/account/challenge', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const did = deviceIdOf(req);
    const body = (req.body ?? {}) as { hostDeviceId?: string; requestedCapabilities?: unknown; ttlMs?: number; relayOrigin?: string };
    if (!did) { await reply.code(400).send({ error: 'device id required' }); return; }
    try {
      return await createAccountEnrollmentChallenge({
        accountId: userId,
        hostDeviceId: body.hostDeviceId ?? '',
        controllerDeviceId: did,
        requestedCapabilities: body.requestedCapabilities ?? ['account.read'],
        relayOrigin: body.relayOrigin ?? 'https://api.nexalance.cloud',
        ttlMs: body.ttlMs,
        nowMs: Date.now(),
      });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // Enrolled-host: list sessions, approve, deny, cancel, list controllers.
  app.get('/api/shadow/enroll/sessions', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      return { sessions: await listEnrollmentSessions({ accountId: userId, hostDeviceId: did }) };
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // Enrolled-host: read PUBLIC pending-request material (keys/nonce/transcript)
  // needed to render the SAS and wrap the scope key before approval. No secrets.
  app.get('/api/shadow/enroll/requests', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      return { requests: await listPendingEnrollmentRequests({ accountId: userId, hostDeviceId: did }) };
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.get('/api/shadow/enroll/controllers', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    try {
      await enrolledShadowAuth(req, 'enrolled-host');
      return { controllers: await listEnrolledControllers({ accountId: userId }) };
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.post('/api/shadow/enroll/approve', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const body = (req.body ?? {}) as { sessionId?: string; grant?: unknown; keyMaterial?: unknown; controllerName?: string; controllerPlatform?: string };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      return await approveEnrollment({ accountId: userId, hostDeviceId: did, sessionId: body.sessionId ?? '', grant: body.grant as Parameters<typeof approveEnrollment>[0]['grant'], keyMaterial: body.keyMaterial as Parameters<typeof approveEnrollment>[0]['keyMaterial'], controllerName: body.controllerName, controllerPlatform: body.controllerPlatform, nowMs: Date.now() });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.post('/api/shadow/enroll/deny', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const body = (req.body ?? {}) as { sessionId?: string };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      return await denyEnrollment({ accountId: userId, hostDeviceId: did, sessionId: body.sessionId ?? '' });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  app.post('/api/shadow/enroll/cancel', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const body = (req.body ?? {}) as { sessionId?: string };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      return await cancelEnrollment({ accountId: userId, hostDeviceId: did, sessionId: body.sessionId ?? '' });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // Bootstrap-controller: poll enrollment status + fetch own grant (signature-gated).
  app.post('/api/shadow/enroll/poll', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const body = (req.body ?? {}) as { sessionId?: string; controllerDeviceId?: string; nonce?: string; timestampMs?: number; signature?: string };
    try {
      return await pollEnrollment({ accountId: userId, sessionId: body.sessionId ?? '', controllerDeviceId: body.controllerDeviceId ?? '', nonce: body.nonce ?? '', timestampMs: body.timestampMs ?? 0, signature: body.signature ?? '', nowMs: Date.now() });
    } catch (e) {
      const err = e as { statusCode?: number; message?: string };
      await reply.code(err.statusCode ?? 500).send({ error: err.message ?? 'failed' });
    }
  });

  // Enrolled-host: atomic signed revocation + remaining-controller rotation.
  app.post('/api/shadow/enroll/revoke', async (req, reply) => {
    const userId = (req as ReqWithUser).userId as string;
    const body = (req.body ?? {}) as { scopeId?: string; controllerDeviceId?: string; revocation?: unknown; effectiveSeq?: number; remainingRotations?: unknown };
    try {
      const did = await enrolledShadowAuth(req, 'enrolled-host');
      return await revokeEnrolledController({ accountId: userId, hostDeviceId: did, scopeId: body.scopeId ?? '', controllerDeviceId: body.controllerDeviceId ?? '', revocation: body.revocation as Parameters<typeof revokeEnrolledController>[0]['revocation'], effectiveSeq: body.effectiveSeq ?? 0, remainingRotations: body.remainingRotations as Parameters<typeof revokeEnrolledController>[0]['remainingRotations'], nowMs: Date.now() });
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
    registerScreenWs(scope);
  });
  return app;
}
