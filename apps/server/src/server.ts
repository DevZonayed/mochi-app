/* maestro-relay — the server owns NOTHING and computes NOTHING.

   Its only job is to connect each operator's devices:
   - A Mac (desktop app) dials in over WebSocket as the HOST, pushes state
     snapshots, and executes every command locally.
   - Phones / web remotes keep using the same REST surface: GETs are served
     from THEIR Mac's last pushed snapshot; POSTs are forwarded to THEIR Mac
     over the socket and answered with the Mac's result.
   - SSE relays one host's live events to that host's web clients.
   No database, no engine, no credentials — if the Mac is offline, commands
   return 503 and reads serve the last mirrored snapshot.

   ── Multi-tenant model ─────────────────────────────────────────────────
   The relay is a public deployment; multiple operators share the same
   instance. Each operator's Mac registers a Deck (keyed by `deckId`) and
   pushes its own snapshot, owns its own SSE/device/push registries, and is
   ROUTED to by the phone's pairing token (`accessToken`). A WS message from
   one operator's host can ONLY mutate that operator's Deck — never anyone
   else's. */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { WebSocket } from 'ws';
import { registerRegistry } from './registry.js';
import { DeviceRegistry } from './devices.js';
import { turnConfigFromEnv } from './turn.js';

interface Snapshot {
  workspace?: unknown;
  workspaces?: unknown[];
  projects?: { id?: string }[];
  jobs?: { id?: string; projectId?: string; sessionId?: string }[];
  sessions?: { id?: string; projectId?: string }[];
  approvals?: { id?: string; status?: string }[];
  schedules?: unknown[];
  skills?: unknown[];
  templates?: unknown[];
  assets?: { id?: string; projectId?: string | null; status?: string }[];
  mediaRates?: unknown;
  publishDrafts?: unknown[];
  publishLedger?: unknown[];
  briefs?: unknown[];
  researchRuns?: unknown[];
  events?: unknown[];
  chatBindings?: unknown[];
  pendingChats?: unknown[];
  commEvents?: unknown[];
  feedback?: { id?: string; status?: string }[];
  commsStatus?: unknown;
  budget?: unknown;
  costs?: unknown;
  dashboard?: unknown;
  providers?: unknown[];
  routing?: unknown;
  settings?: unknown;
  engineStatus?: unknown;
  models?: unknown;
  at?: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error & { statusCode?: number }) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Deck {
  deckId: string;
  secret: string;
  /** Pairing token remotes must present on every /api/* request. */
  accessToken: string;
  ws: WebSocket | null;
  online: boolean;
  lastSeen: number;
  state: Snapshot | null;
  pending: Map<string, Pending>;
  /** Per-tenant device list (presence + revocation). */
  devices: DeviceRegistry;
  /** Per-tenant SSE subscribers (one operator's events never reach another's). */
  sseClients: Set<ServerResponse>;
  /** Per-tenant Expo push tokens (closed-app alerts for THIS operator's phones). */
  pushTokens: Map<string, number>;
  lastRemoteNotify: number;
}

const EMPTY_DASHBOARD = {
  workspace: null, greetingProjects: [], gates: [], activeJobs: [], recentlyCompleted: [], schedule: [],
  budget: { cap: 200, spent: 0, byProject: [] },
};

const CMD_TIMEOUT_MS = 10 * 60 * 1000; // jobs run real models on the Mac — be generous

/** Per-request decoration so handlers can read the deck the caller authenticated to. */
type ReqWithDeck = FastifyRequest & { deck?: Deck };

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(cors, { origin: true });

  // Tolerate empty JSON bodies on bodyless POSTs (approve/deny/toggle).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const s = typeof body === 'string' ? body : '';
    if (s.trim() === '') { done(null, undefined); return; }
    try { done(null, JSON.parse(s)); } catch (err) { done(err instanceof Error ? err : new Error('invalid json'), undefined); }
  });

  app.register(websocket);

  // Multi-tenant: one Deck per operator's Mac, keyed by deckId. A phone's
  // pairToken (= deck.accessToken) selects WHICH deck a request routes to.
  const decks = new Map<string, Deck>();
  // Global dedup for push notifications. Keys are random ids, so it's safe
  // to share across operators (collisions are vanishingly unlikely).
  const pushSeen = new Set<string>();

  function rememberPushKey(k: string): boolean {
    if (pushSeen.has(k)) return false;
    pushSeen.add(k);
    if (pushSeen.size > 1000) { const first = pushSeen.values().next().value; if (first) pushSeen.delete(first); }
    return true;
  }

  /** Find the deck that owns this access token (= the phone's pairing code). */
  function deckByAccessToken(token: string): Deck | null {
    if (!token) return null;
    for (const d of decks.values()) if (d.accessToken === token) return d;
    return null;
  }

  // ── Remote-device presence + per-device control (per deck) ─────────
  // The Mac can't otherwise tell a read-only remote is connected (GETs are served
  // from the snapshot here, never reaching it). Each deck has its own registry so
  // operator A's Mac never sees operator B's phones, and a kick from A can't
  // touch a device that authed under B.
  function notifyRemote(deck: Deck, force = false): void {
    const t = Date.now();
    if (!force && t - deck.lastRemoteNotify < 1500) return;
    deck.lastRemoteNotify = t;
    try {
      deck.ws?.send(JSON.stringify({ type: 'remote', devices: deck.devices.list() }));
    } catch { /* socket closed */ }
  }
  // A remote presents its identity as a header (REST) or a query param (SSE, where
  // the browser EventSource can't set headers).
  const deviceIdOf = (req: FastifyRequest): string | null => {
    const h = req.headers['x-maestro-device-id'];
    if (typeof h === 'string' && h) return h;
    const q = (req.query as { did?: string } | undefined)?.did;
    return typeof q === 'string' && q ? q : null;
  };
  const deviceNameOf = (req: FastifyRequest): string | null => {
    const h = req.headers['x-maestro-device'];
    if (typeof h === 'string' && h) return h;
    const q = (req.query as { device?: string } | undefined)?.device;
    return typeof q === 'string' && q ? q : null;
  };

  // ── Pairing-token auth on the whole remote surface ─────────────────
  // The presented token selects WHICH deck (= which Mac) this request routes
  // to. /health and / stay open. /api/turn-credentials is open by design
  // (TURN creds are public per the secret-rotation HMAC contract).
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '';
    if (!url.startsWith('/api/')) return;
    if (decks.size === 0) return reply.code(503).send({ error: 'No Mac paired yet — open the Maestro desktop app' });
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const qtoken = (req.query as { token?: string } | undefined)?.token ?? '';
    const presented = bearer || qtoken;
    const myDeck = deckByAccessToken(presented);
    if (!myDeck) return reply.code(401).send({ error: 'Unauthorized — pair with the code shown in the Maestro desktop app' });
    // Disconnected from the Mac → make this device re-pair (distinct code so the
    // remote can show "reconnect" instead of a generic auth error).
    const deviceId = deviceIdOf(req);
    if (myDeck.devices.isRevoked(deviceId)) {
      return reply.code(401).send({ error: 'This device was disconnected — enter the code to reconnect.', code: 'device-revoked' });
    }
    // Authenticated remote activity → let the Mac know this device is alive.
    myDeck.devices.touch(deviceId, deviceNameOf(req));
    notifyRemote(myDeck);
    (req as ReqWithDeck).deck = myDeck;
  });

  /** Pull the deck the caller authenticated to off the request. */
  const deckOf = (req: FastifyRequest): Deck | null => (req as ReqWithDeck).deck ?? null;
  /** Convenience: this caller's snapshot (or null if no Mac connected for this deck). */
  const stReq = (req: FastifyRequest): Snapshot | null => deckOf(req)?.state ?? null;

  // ── SSE fan-out PER DECK ───────────────────────────────────────────
  function sseSend(deck: Deck, event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of deck.sseClients) {
      try { res.write(payload); } catch { deck.sseClients.delete(res); }
    }
  }
  // Device-targeted SSE (WebRTC signaling to ONE remote, not a broadcast).
  function sseSendTo(deck: Deck, did: string | null | undefined, event: string, data: unknown): void {
    if (!did) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of deck.devices.streamsFor(did)) {
      try { res.write(payload); } catch { /* closed */ }
    }
  }

  // ── Expo push (alerts while the phone app is CLOSED) — PER DECK ────
  // SSE only reaches a running app; a closed phone misses every event. The phone
  // registers its Expo push token here against ITS deck, and we mirror that
  // deck's job/approval/schedule events to Expo's push service so a closed app
  // still gets a real OS notification. Operator A's phones never see B's alerts.
  async function sendExpoPush(deck: Deck, title: string, body: string): Promise<void> {
    const tokens = [...deck.pushTokens.keys()];
    if (!tokens.length) return;
    const messages = tokens.map((to) => ({ to, title, body, sound: 'default', priority: 'high', channelId: 'alerts' }));
    try {
      const res = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(messages),
      });
      // Expo returns per-message receipts; prune any token it reports as gone.
      const json = (await res.json().catch(() => null)) as { data?: { status?: string; details?: { error?: string } }[] } | null;
      if (Array.isArray(json?.data)) {
        json!.data!.forEach((r, i) => {
          if (r?.status === 'error' && r.details?.error === 'DeviceNotRegistered') deck.pushTokens.delete(tokens[i]);
        });
      }
    } catch { /* push service unreachable — SSE still carries foreground alerts */ }
  }
  // Mirror the alert-worthy events to push, matching the phone's in-app LiveNotifier.
  function maybePush(deck: Deck, name: string, data: unknown): void {
    if (!deck.pushTokens.size) return;
    if (name === 'job') {
      const j = data as { id?: string; status?: string; title?: string } | null;
      if (!j?.id) return;
      if (j.status === 'done' && rememberPushKey(`${deck.deckId}:${j.id}:done`)) void sendExpoPush(deck, 'Conversation complete', j.title || 'A run finished on your Mac.');
      else if (j.status === 'failed' && rememberPushKey(`${deck.deckId}:${j.id}:failed`)) void sendExpoPush(deck, 'Job failed', j.title || 'A run failed on your Mac.');
    } else if (name === 'approval') {
      const a = data as { id?: string; status?: string; title?: string } | null;
      if (a?.id && a.status === 'pending' && rememberPushKey(`${deck.deckId}:appr:${a.id}`)) void sendExpoPush(deck, 'Needs your attention', a.title || 'An approval is waiting.');
    } else if (name === 'schedule-late') {
      const s = data as { id?: string; title?: string; firedAt?: number } | null;
      if (rememberPushKey(`${deck.deckId}:late:${s?.id ?? ''}:${s?.firedAt ?? ''}`)) void sendExpoPush(deck, 'Scheduled task ran late', s?.title ? `“${s.title}” caught up.` : 'A schedule caught up after a missed time.');
    }
  }

  // ── Forward a command to the caller's Mac and await its result ────
  // Scoped to a specific deck so a command for operator A never lands on B's WS.
  function cmd<T = unknown>(deck: Deck, method: string, params: Record<string, unknown>): Promise<T> {
    if (!deck.online || !deck.ws) {
      return Promise.reject(Object.assign(new Error('Your Mac is offline — open the Maestro desktop app'), { statusCode: 503 }));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        deck.pending.delete(id);
        reject(Object.assign(new Error('Your Mac did not respond in time'), { statusCode: 504 }));
      }, CMD_TIMEOUT_MS);
      deck.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        deck.ws!.send(JSON.stringify({ type: 'cmd', id, method, params }));
      } catch {
        clearTimeout(timer);
        deck.pending.delete(id);
        reject(Object.assign(new Error('Relay write failed'), { statusCode: 502 }));
      }
    });
  }

  async function forward(req: FastifyRequest, reply: FastifyReply, method: string, params: Record<string, unknown>) {
    const deck = deckOf(req);
    if (!deck) return reply.code(503).send({ error: 'No Mac paired' }); // auth hook would normally catch this
    try {
      return await cmd(deck, method, params);
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  }

  // ── WebSocket: each Mac registers here as host ─────────────────────
  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (conn: unknown) => {
      const ws = ((conn as { socket?: WebSocket }).socket ?? conn) as WebSocket;
      // myDeck is the deck THIS WS owns. Every host message after the hello
      // is applied against myDeck only — never the global map — so a stale
      // socket from operator B can't write into operator A's snapshot.
      let myDeck: Deck | null = null;

      ws.on('message', (buf: Buffer | string) => {
        let m: { type?: string; role?: string; deckId?: string; secret?: string; accessToken?: string; state?: Snapshot; name?: string; data?: unknown; id?: string; ok?: boolean; result?: unknown; error?: string; statusCode?: number; deviceId?: string; did?: string; signal?: unknown };
        try { m = JSON.parse(String(buf)) as typeof m; } catch { return; }

        if (m.type === 'hello' && m.role === 'host' && m.deckId) {
          const existing = decks.get(m.deckId);
          if (existing && existing.secret && m.secret && m.secret !== existing.secret) {
            ws.send(JSON.stringify({ type: 'denied', reason: 'bad secret' }));
            ws.close();
            return;
          }
          if (!existing) {
            const deck: Deck = {
              deckId: m.deckId,
              secret: m.secret ?? '',
              accessToken: m.accessToken ?? '',
              ws,
              online: true,
              lastSeen: Date.now(),
              state: null, // never inherit another deck's snapshot — was the cross-tenant leak
              pending: new Map(),
              devices: new DeviceRegistry(),
              sseClients: new Set(),
              pushTokens: new Map(),
              lastRemoteNotify: 0,
            };
            decks.set(m.deckId, deck);
            myDeck = deck;
          } else {
            // Same deck reconnecting (or replacing its own stale ws). Close the
            // previous ws so the old socket stops trying to push events into us.
            if (existing.ws && existing.ws !== ws) {
              try { existing.ws.close(); } catch { /* already closed */ }
            }
            existing.ws = ws;
            existing.online = true;
            existing.lastSeen = Date.now();
            if (m.accessToken && m.accessToken !== existing.accessToken) {
              existing.accessToken = m.accessToken;
              existing.devices.reset(); // pairing code rotated → every remote must re-pair
            }
            myDeck = existing;
          }
          ws.send(JSON.stringify({ type: 'hello-ok' }));
          sseSend(myDeck, 'host', { online: true });
          notifyRemote(myDeck, true); // tell the freshly-connected Mac about its current remotes
          return;
        }

        // Hard isolation: after hello, host messages only mutate THIS ws's deck.
        // Even if another tenant's stale ws sends a 'state' frame, it lands on
        // its own deck (or is ignored when myDeck is null), never ours.
        if (!myDeck) return;
        // If our deck was concurrently re-bound to a different ws (e.g. the same
        // Mac reconnected after a brief dropout), stop applying frames from us —
        // the new ws is now the source of truth for this deck.
        if (myDeck.ws !== ws) return;
        const deck = myDeck;

        if (m.type === 'state' && m.state) {
          deck.state = m.state;
          deck.lastSeen = Date.now();
        } else if (m.type === 'event' && m.name) {
          sseSend(deck, m.name, m.data);
          maybePush(deck, m.name, m.data); // closed-app OS notification (live SSE handles the open app)
        } else if (m.type === 'result' && m.id) {
          const p = deck.pending.get(m.id);
          if (p) {
            clearTimeout(p.timer);
            deck.pending.delete(m.id);
            if (m.ok) p.resolve(m.result);
            else p.reject(Object.assign(new Error(m.error ?? 'failed'), { statusCode: m.statusCode ?? 500 }));
          }
        } else if (m.type === 'pong') {
          deck.lastSeen = Date.now();
        } else if (m.type === 'kick' && m.deviceId) {
          for (const res of deck.devices.kick(m.deviceId)) { try { res.end(); } catch { /* already closed */ } }
          notifyRemote(deck, true);
        } else if (m.type === 'signal' && m.did) {
          // WebRTC signaling from this Mac to one specific remote (offer/answer/ICE).
          sseSendTo(deck, m.did, 'signal', m.signal);
        }
      });

      ws.on('close', () => {
        if (myDeck && myDeck.ws === ws) {
          myDeck.online = false;
          myDeck.ws = null;
          for (const [, p] of myDeck.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Mac disconnected'), { statusCode: 503 })); }
          myDeck.pending.clear();
          sseSend(myDeck, 'host', { online: false });
        }
      });
    });
  });

  const keepalive = setInterval(() => {
    for (const deck of decks.values()) {
      try { deck.ws?.send(JSON.stringify({ type: 'ping' })); } catch { /* closed */ }
    }
  }, 25000);
  app.addHook('onClose', async () => clearInterval(keepalive));

  // ── Health / meta ──────────────────────────────────────────────────
  app.get('/health', async () => {
    let online = 0;
    let withState = 0;
    let lastSeen = 0;
    for (const d of decks.values()) {
      if (d.online) online += 1;
      if (d.state) withState += 1;
      if (d.lastSeen > lastSeen) lastSeen = d.lastSeen;
    }
    return {
      ok: true, name: 'maestro-relay', version: '0.4.0', mode: 'relay-multitenant',
      decks: decks.size,
      // Aggregate-only — per-tenant detail is gated behind the per-deck pair token.
      host: { online: online > 0, lastSeen: lastSeen || null, hasState: withState > 0 },
      time: Date.now(),
    };
  });
  app.get('/', async () => ({
    ok: true, service: 'maestro-relay',
    docs: 'GETs mirror the Mac’s snapshot; POSTs execute ON the Mac. /ws is the host socket.',
  }));

  // ── Reads — served from THIS caller's deck snapshot ───────────────
  app.get('/api/dashboard', async (req) => stReq(req)?.dashboard ?? EMPTY_DASHBOARD);
  app.get('/api/budget', async (req) => stReq(req)?.budget ?? EMPTY_DASHBOARD.budget);
  app.get('/api/costs', async (req) => stReq(req)?.costs ?? { today: 0, thisMonth: 0, projectedMonth: 0, byDay: [], byProject: [], byEngine: [], includedCodexRuns: 0, claudeRuns: 0 });
  app.get('/api/events', async (req) => stReq(req)?.events ?? []);
  app.get('/api/settings', async (req) => stReq(req)?.settings ?? null);
  app.get('/api/engine-status', async (req) => stReq(req)?.engineStatus ?? { claude: { engine: 'claude', available: false, method: 'none', detail: 'Mac offline', reason: 'Desktop not connected.' }, codex: { engine: 'codex', available: false, method: 'none', detail: 'Mac offline', reason: 'Desktop not connected.' } });
  // ── Media Studio (assets mirror; generation forwards to the Mac's fal key) ──
  app.get('/api/assets', async (req) => {
    const projectId = (req.query as { projectId?: string }).projectId;
    const assets = stReq(req)?.assets ?? [];
    return projectId ? assets.filter((a) => a.projectId === projectId) : assets;
  });
  app.get('/api/media/rates', async (req) => stReq(req)?.mediaRates ?? []);
  // ── Trends (briefs mirror; runs forward to the Mac's research engine) ──
  app.get('/api/briefs', async (req) => stReq(req)?.briefs ?? []);
  app.get('/api/research-runs', async (req) => stReq(req)?.researchRuns ?? []);
  app.post('/api/research/run', async (req, reply) => forward(req, reply, 'runResearch', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/briefs/:id/sent', async (req, reply) => forward(req, reply, 'markBriefSent', { id: (req.params as { id: string }).id }));
  // ── Publishing (drafts mirror; actions forward to the Mac's local pipeline) ──
  app.get('/api/publish/drafts', async (req) => stReq(req)?.publishDrafts ?? []);
  app.get('/api/publish/ledger', async (req) => stReq(req)?.publishLedger ?? []);
  app.post('/api/publish/drafts', async (req, reply) => forward(req, reply, 'createDraft', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/publish/drafts/:id/update', async (req, reply) => forward(req, reply, 'updateDraft', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/publish/drafts/:id/schedule', async (req, reply) => forward(req, reply, 'scheduleDraft', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/publish/drafts/:id/export', async (req, reply) => forward(req, reply, 'exportDraft', { id: (req.params as { id: string }).id }));
  app.post('/api/publish/drafts/:id/published', async (req, reply) => forward(req, reply, 'markPublished', { id: (req.params as { id: string }).id }));
  app.post('/api/publish/drafts/:id/delete', async (req, reply) => forward(req, reply, 'deleteDraft', { id: (req.params as { id: string }).id }));
  // ── Comms (Telegram) — status/bindings mirror; actions forward to the Mac ──
  app.get('/api/comms/status', async (req) => stReq(req)?.commsStatus ?? { telegram: { connected: false, botUsername: null, tokenLast4: null, messagesToday: 0, bindings: 0, pending: 0 }, whatsapp: { connected: false } });
  app.get('/api/comms/bindings', async (req) => stReq(req)?.chatBindings ?? []);
  app.get('/api/comms/pending', async (req) => stReq(req)?.pendingChats ?? []);
  app.get('/api/comms/events', async (req) => stReq(req)?.commEvents ?? []);
  // ── Feedback (mirror the Mac's list; submit/triage forward to the Mac) ──
  app.get('/api/feedback', async (req) => stReq(req)?.feedback ?? []);
  app.post('/api/comms/telegram/connect', async (req, reply) => forward(req, reply, 'connectTelegram', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/comms/telegram/disconnect', async (req, reply) => forward(req, reply, 'disconnectTelegram', {}));
  app.post('/api/comms/bind', async (req, reply) => forward(req, reply, 'bindChat', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/comms/unbind', async (req, reply) => forward(req, reply, 'unbindChat', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/comms/permissions', async (req, reply) => forward(req, reply, 'setChatPermissions', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/assets/generate', async (req, reply) => forward(req, reply, 'generateAsset', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/assets/:id/cancel', async (req, reply) => forward(req, reply, 'cancelAsset', { id: (req.params as { id: string }).id }));
  app.post('/api/assets/:id/approve', async (req, reply) => forward(req, reply, 'approveAsset', { id: (req.params as { id: string }).id }));
  app.post('/api/assets/:id/delete', async (req, reply) => forward(req, reply, 'deleteAsset', { id: (req.params as { id: string }).id }));
  app.get('/api/workspaces', async (req) => stReq(req)?.workspaces ?? []);
  app.get('/api/projects', async (req) => stReq(req)?.projects ?? []);
  app.get('/api/projects/:id', async (req, reply) => {
    const p = (stReq(req)?.projects ?? []).find((x) => x.id === (req.params as { id: string }).id);
    return p ?? reply.code(404).send({ error: 'project not found' });
  });
  // Repo info is computed by git ON THE MAC; remotes get a best-effort view from
  // the mirrored project (branch unknown remotely → null).
  app.get('/api/projects/:id/repo', async (req) => {
    const p = (stReq(req)?.projects ?? []).find((x) => x.id === (req.params as { id: string }).id) as { path?: string; repoUrl?: string } | undefined;
    return { branch: null, remote: p?.repoUrl ?? null, isRepo: !!p?.path };
  });
  app.get('/api/jobs', async (req) => {
    const { projectId, sessionId } = req.query as { projectId?: string; sessionId?: string };
    const jobs = stReq(req)?.jobs ?? [];
    if (sessionId) return jobs.filter((j) => j.sessionId === sessionId);
    return projectId ? jobs.filter((j) => j.projectId === projectId) : jobs;
  });
  app.get('/api/sessions', async (req) => {
    const projectId = (req.query as { projectId?: string }).projectId;
    const sessions = stReq(req)?.sessions ?? [];
    return projectId ? sessions.filter((s) => s.projectId === projectId) : sessions;
  });
  app.get('/api/jobs/:id', async (req, reply) => {
    const j = (stReq(req)?.jobs ?? []).find((x) => x.id === (req.params as { id: string }).id);
    return j ?? reply.code(404).send({ error: 'job not found' });
  });
  // Diff is computed by git ON THE MAC (read-only) — forward and return its result.
  app.get('/api/jobs/:id/diff', async (req, reply) => forward(req, reply, 'getJobDiff', { id: (req.params as { id: string }).id }));
  app.get('/api/approvals', async (req) => {
    const status = (req.query as { status?: string }).status;
    const approvals = stReq(req)?.approvals ?? [];
    return status ? approvals.filter((a) => a.status === status) : approvals;
  });
  app.get('/api/schedules', async (req) => stReq(req)?.schedules ?? []);
  app.get('/api/skills', async (req) => stReq(req)?.skills ?? []);
  app.get('/api/templates', async (req) => stReq(req)?.templates ?? []);
  app.get('/api/providers', async (req) => stReq(req)?.providers ?? []);
  app.get('/api/routing', async (req) => (stReq(req) as { routing?: unknown } | null)?.routing ?? { master: 'claude', reviewer: 'off', image: 'codex', video: 'codex' });
  app.get('/api/models', async (req) => (stReq(req) as { models?: unknown } | null)?.models ?? []);

  // ── Writes — forwarded to MY Mac, executed there ──────────────────
  app.post('/api/workspaces', async (req, reply) => forward(req, reply, 'createWorkspace', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/workspaces/:id/budget', async (req, reply) =>
    forward(req, reply, 'setBudgetCap', { ...(req.body ?? {}) as Record<string, unknown>, workspaceId: (req.params as { id: string }).id }));
  app.post('/api/projects', async (req, reply) => forward(req, reply, 'createProject', (req.body ?? {}) as Record<string, unknown>));
  // Read-only folder browser on the Mac (for the phone's new-project location picker).
  app.get('/api/browse', async (req, reply) => forward(req, reply, 'browseDir', { path: (req.query as { path?: string }).path }));
  app.post('/api/projects/:id/update', async (req, reply) =>
    forward(req, reply, 'updateProject', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/projects/reorder', async (req, reply) => forward(req, reply, 'reorderProjects', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/projects/clone', async (req, reply) => forward(req, reply, 'cloneRepo', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/projects/:id/delete', async (req, reply) => forward(req, reply, 'deleteProject', { id: (req.params as { id: string }).id }));
  app.post('/api/chat', async (req, reply) => forward(req, reply, 'sendChat', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/sessions/:id/rename', async (req, reply) =>
    forward(req, reply, 'renameSession', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/sessions/:id/delete', async (req, reply) => forward(req, reply, 'deleteSession', { id: (req.params as { id: string }).id }));
  app.post('/api/sessions/:id/pin', async (req, reply) =>
    forward(req, reply, 'pinSession', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/sessions/:id/archive', async (req, reply) =>
    forward(req, reply, 'archiveSession', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/settings', async (req, reply) => forward(req, reply, 'setSettings', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/jobs', async (req, reply) => forward(req, reply, 'createJob', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/jobs/run', async (req, reply) => forward(req, reply, 'createAndRunJob', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/jobs/:id/run', async (req, reply) =>
    forward(req, reply, 'runJob', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/jobs/:id/cancel', async (req, reply) => forward(req, reply, 'cancelJob', { id: (req.params as { id: string }).id }));
  app.post('/api/jobs/:id/delete', async (req, reply) => forward(req, reply, 'deleteJob', { id: (req.params as { id: string }).id }));
  app.post('/api/approvals/:id/approve', async (req, reply) => forward(req, reply, 'approveApproval', { id: (req.params as { id: string }).id }));
  app.post('/api/approvals/:id/deny', async (req, reply) => forward(req, reply, 'denyApproval', { id: (req.params as { id: string }).id }));
  app.post('/api/schedules', async (req, reply) => forward(req, reply, 'createSchedule', (req.body ?? {}) as Record<string, unknown>));
  app.patch('/api/schedules/:id', async (req, reply) =>
    forward(req, reply, 'updateSchedule', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/schedules/check', async (req, reply) => forward(req, reply, 'scheduleCheck', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/schedules/:id/toggle', async (req, reply) =>
    forward(req, reply, 'toggleSchedule', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/schedules/:id/delete', async (req, reply) => forward(req, reply, 'deleteSchedule', { id: (req.params as { id: string }).id }));
  app.post('/api/skills/:id/toggle', async (req, reply) => forward(req, reply, 'toggleSkill', { id: (req.params as { id: string }).id }));
  app.post('/api/providers/:provider/connect', async (req, reply) =>
    forward(req, reply, 'connectProvider', { ...(req.body ?? {}) as Record<string, unknown>, provider: (req.params as { provider: string }).provider }));
  app.post('/api/providers/:provider/disconnect', async (req, reply) =>
    forward(req, reply, 'disconnectProvider', { ...(req.body ?? {}) as Record<string, unknown>, provider: (req.params as { provider: string }).provider }));
  app.post('/api/routing', async (req, reply) => forward(req, reply, 'setRouting', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/roles', async (req, reply) => forward(req, reply, 'setRoles', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/feedback', async (req, reply) => forward(req, reply, 'submitFeedback', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/feedback/:id/update', async (req, reply) =>
    forward(req, reply, 'updateFeedback', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/feedback/:id/delete', async (req, reply) => forward(req, reply, 'deleteFeedback', { id: (req.params as { id: string }).id }));

  // ── WebRTC signaling passthrough + TURN creds (P2P transport setup) ──
  // Signaling rides the already-authenticated relay: the phone POSTs its SDP/ICE
  // here, we hand it to ITS Mac (host WS), and the Mac's replies come back over
  // the device's own SSE stream as `event: signal`. No new server, no second QR.
  app.post('/api/signal', async (req, reply) => {
    const deck = deckOf(req);
    if (!deck || !deck.online || !deck.ws) {
      return reply.code(503).send({ error: 'Your Mac is offline — open the Maestro desktop app' });
    }
    const did = deviceIdOf(req);
    const body = (req.body ?? {}) as { signal?: unknown };
    try {
      deck.ws.send(JSON.stringify({ type: 'signal', did, signal: body.signal }));
    } catch {
      return reply.code(502).send({ error: 'relay write failed' });
    }
    return { ok: true };
  });
  // Time-limited TURN creds (HMAC); all-null when coturn isn't configured → clients use public STUN.
  app.get('/api/turn-credentials', async () => turnConfigFromEnv());

  // ── Push registration (phone registers its Expo token for closed-app alerts) ──
  app.post('/api/push/register', async (req) => {
    const deck = deckOf(req);
    const { token } = (req.body ?? {}) as { token?: string };
    if (deck && typeof token === 'string' && token.trim()) deck.pushTokens.set(token.trim(), Date.now());
    return { ok: true, devices: deck?.pushTokens.size ?? 0 };
  });
  app.post('/api/push/unregister', async (req) => {
    const deck = deckOf(req);
    const { token } = (req.body ?? {}) as { token?: string };
    if (deck && typeof token === 'string') deck.pushTokens.delete(token.trim());
    return { ok: true, devices: deck?.pushTokens.size ?? 0 };
  });

  // ── SSE stream — scoped to THIS caller's deck (operator A never sees B's events) ──
  app.get('/api/stream', (req, reply) => {
    const deck = deckOf(req);
    if (!deck) { reply.code(503).send({ error: 'No Mac paired' }); return; }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, hostOnline: !!deck.online })}\n\n`);
    const deviceId = deviceIdOf(req);
    deck.sseClients.add(res);
    deck.devices.addStream(deviceId, deviceNameOf(req), res);
    notifyRemote(deck, true); // a live remote stream opened
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 25000);
    req.raw.on('close', () => {
      clearInterval(ping);
      deck.sseClients.delete(res);
      deck.devices.removeStream(deviceId, res);
      notifyRemote(deck, true); // stream closed → presence drops
    });
  });

  // Skill registry (read-only reference content, public, /registry/* — see registry.ts).
  registerRegistry(app);

  return app;
}
