/* maestro-relay — the server owns NOTHING and computes NOTHING.

   Its only job is to connect the operator's devices:
   - The Mac (desktop app) dials in over WebSocket as the HOST, pushes state
     snapshots, and executes every command locally.
   - Phones / web remotes keep using the same REST surface as before: GETs are
     served from the host's last pushed snapshot; POSTs are forwarded to the
     Mac over the socket and answered with the Mac's result.
   - SSE relays the host's live events to web clients.
   No database, no engine, no credentials — if the Mac is offline, commands
   return 503 and reads serve the last mirrored snapshot. */

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { WebSocket } from 'ws';
import { registerRegistry } from './registry.js';
import { DeviceRegistry } from './devices.js';
import { turnConfigFromEnv } from './turn.js';
import { createPushTokenStore, type PushTokenStore } from './pushTokens.js';
import { EventBuffer, type BufferedEvent } from './eventBuffer.js';
import {
  createMirrorStore,
  type MirrorStore,
  type UpsertChat,
  type UpsertMessage,
  type UpsertMemory,
} from './mirrorStore.js';

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
}

const EMPTY_DASHBOARD = {
  workspace: null, greetingProjects: [], gates: [], activeJobs: [], recentlyCompleted: [], schedule: [],
  budget: { cap: 200, spent: 0, byProject: [] },
};

const CMD_TIMEOUT_MS = 10 * 60 * 1000; // jobs run real models on the Mac — be generous

export interface BuildServerOptions {
  /** Inject the push-token store (tests pass ':memory:' via createPushTokenStore). */
  pushTokenStore?: PushTokenStore;
  /** Inject the chat+memory mirror store (tests pass an InMemoryMirrorStore).
      When omitted, the relay picks Postgres if MAESTRO_PG_URL is set, otherwise
      a process-local in-memory store. The Mac stays the source of truth either
      way — the mirror is read-through cache only. */
  mirrorStore?: MirrorStore;
}

export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(cors, { origin: true });

  // Tolerate empty JSON bodies on bodyless POSTs (approve/deny/toggle).
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const s = typeof body === 'string' ? body : '';
    if (s.trim() === '') { done(null, undefined); return; }
    try { done(null, JSON.parse(s)); } catch (err) { done(err instanceof Error ? err : new Error('invalid json'), undefined); }
  });

  app.register(websocket);

  // Single-operator product: one deck (the most recent Mac to register).
  let deck: Deck | null = null;

  // ── Remote-device presence + per-device control ────────────────────
  // The Mac can't otherwise tell a read-only remote is connected (GETs are served
  // from the snapshot here, never reaching it). The registry gives every remote a
  // stable identity (sent as `x-maestro-device-id` header / `?did=` query) so the
  // desktop's Devices pane can list each device and disconnect any single one.
  const devices = new DeviceRegistry();
  let lastRemoteNotify = 0;
  function notifyRemote(force = false): void {
    const t = Date.now();
    if (!force && t - lastRemoteNotify < 1500) return;
    lastRemoteNotify = t;
    try {
      deck?.ws?.send(JSON.stringify({ type: 'remote', devices: devices.list() }));
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
  // The Mac sets the token (host hello). Remotes send it as a Bearer header
  // or ?token= (the SSE EventSource can't set headers). /health and / stay open.
  app.addHook('onRequest', async (req, reply) => {
    const url = req.raw.url ?? '';
    if (!url.startsWith('/api/')) return;
    const expected = deck?.accessToken;
    if (!expected) return reply.code(503).send({ error: 'No Mac paired yet — open the Maestro desktop app' });
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const qtoken = (req.query as { token?: string } | undefined)?.token ?? '';
    const presented = bearer || qtoken;
    if (presented !== expected) return reply.code(401).send({ error: 'Unauthorized — pair with the code shown in the Maestro desktop app' });
    // Disconnected from the Mac → make this device re-pair (distinct code so the
    // remote can show "reconnect" instead of a generic auth error).
    const deviceId = deviceIdOf(req);
    if (devices.isRevoked(deviceId)) {
      return reply.code(401).send({ error: 'This device was disconnected — enter the code to reconnect.', code: 'device-revoked' });
    }
    // Authenticated remote activity → let the Mac know this device is alive.
    devices.touch(deviceId, deviceNameOf(req));
    notifyRemote();
  });

  // ── SSE + WS fan-out to web clients ────────────────────────────────
  // Two transports for the same event stream:
  //   - SSE (`/api/stream`) — long-lived HTTP, what web clients use today
  //   - WS  (`/api/stream-ws`) — full-duplex, lower latency, used by the mobile
  //     app to stream token-by-token chat output without the SSE reconnect tax.
  // sseSend() now fans out to BOTH so adding the WS endpoint didn't require
  // touching every call site.
  const sseClients = new Set<ServerResponse>();
  const wsStreamClients = new Set<WebSocket>();
  /* Event replay buffer — see eventBuffer.ts. Every broadcast event is
     stamped with a monotonic `seq` and remembered for the last N events
     (default 2000, ≈ several minutes of normal traffic). A reconnecting
     client sends `?since=<lastSeq>` and we replay the gap, so the phone
     never returns to a stale screen after a network blink or going from
     subway to wifi. Some events the user opted to ignore (heavy assets,
     mid-stream snapshots) we don't buffer — they're either replayed by
     the Mac's snapshot push or are too verbose to be worth catching up. */
  const eventBuffer = new EventBuffer(2000);
  /** Event names worth buffering for replay. Listed exhaustively so a
   *  reconnecting client (mobile after AppState resume, web-desktop after
   *  a page reload or network blink) doesn't miss anything material.
   *
   *  Excluded by design:
   *   - high-volume mid-stream frames the next snapshot push covers (state,
   *     dashboard)
   *   - one-shot lifecycle frames where catch-up is meaningless (clone
   *     progress completes or aborts; github-device finishes the OAuth dance
   *     within ~minutes of starting and a new request would issue a fresh
   *     code anyway)
   *
   *  We intentionally include `bg` / `project` / `publishDraft` / `feedback`
   *  even though they originated as desktop-renderer concerns — the relay
   *  fans them all out and a web-desktop client legitimately depends on
   *  them. Mobile ignores names it doesn't recognise. */
  const REPLAYABLE = new Set([
    'job', 'session', 'approval', 'asset', 'comms', 'briefs',
    'schedule', 'schedule-late', 'git-status', 'extension', 'host',
    // Newly added for desktop-web reconnect alignment:
    'project', 'bg', 'publishDraft', 'feedback',
  ]);
  function sseSend(event: string, data: unknown) {
    // Record before broadcast: if the broadcast fails for a single client,
    // the buffer is still accurate for everyone else's reconnect.
    const seq = REPLAYABLE.has(event) ? eventBuffer.push(event, data) : 0;
    const ssePayload = seq
      ? `id: ${seq}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`
      : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(ssePayload); } catch { sseClients.delete(res); }
    }
    // WS clients get the same event shape as a single JSON frame. Mobile parses
    // `{ event, data, seq }` whether it arrived via SSE or WS, so the consumer
    // code stays identical. `seq` is omitted for non-replayable events.
    if (wsStreamClients.size) {
      const wsPayload = JSON.stringify(seq ? { event, data, seq } : { event, data });
      for (const sock of wsStreamClients) {
        try { sock.send(wsPayload); } catch { wsStreamClients.delete(sock); }
      }
    }
  }
  /** Replay events newer than `since` to a single SSE response stream. Used
   *  by /api/stream when the client passes `?since=<seq>`. */
  function replaySse(res: ServerResponse, since: number): void {
    const r = eventBuffer.since(since);
    if (r.bufferOverflow) {
      // Client missed too much — tell them to do a full snapshot refetch.
      // SSE comment-style frame so the consumer can match by `event: buffer-overflow`.
      res.write(`event: buffer-overflow\ndata: ${JSON.stringify({ latestSeq: r.latestSeq, since })}\n\n`);
      return;
    }
    for (const ev of r.events) {
      res.write(`id: ${ev.seq}\nevent: ${ev.name}\ndata: ${JSON.stringify(ev.data)}\n\n`);
    }
  }
  /** Same for a single WS client. */
  function replayWs(sock: WebSocket, since: number): void {
    const r = eventBuffer.since(since);
    if (r.bufferOverflow) {
      try { sock.send(JSON.stringify({ event: 'buffer-overflow', data: { latestSeq: r.latestSeq, since } })); } catch { /* closed */ }
      return;
    }
    for (const ev of r.events) {
      try { sock.send(JSON.stringify({ event: ev.name, data: ev.data, seq: ev.seq })); } catch { /* closed */ }
    }
  }
  /** Parse the `since` query into a non-negative integer; junk → 0 (= no replay). */
  function parseSince(q: unknown): number {
    if (typeof q !== 'string') return 0;
    const n = Number.parseInt(q, 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  /** Suppress the unused-symbol warning for the BufferedEvent re-export when
   *  the import isn't directly consumed by sseSend (it's used in replay). */
  void (null as unknown as BufferedEvent | null);
  // Device-targeted SSE (WebRTC signaling to ONE remote, not a broadcast).
  function sseSendTo(did: string | null | undefined, event: string, data: unknown) {
    if (!did) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of devices.streamsFor(did)) {
      try { res.write(payload); } catch { /* closed */ }
    }
  }

  // ── Expo push (alerts while the phone app is CLOSED) ───────────────
  // SSE only reaches a running app; a closed phone misses every event. The phone
  // registers its Expo push token here, and we mirror the Mac's job/approval/
  // schedule events to Expo's push service so a closed app still gets a real OS
  // notification. Tokens persist via better-sqlite3 (see pushTokens.ts) so a
  // Dokploy redeploy doesn't wipe the device list and a closed phone keeps
  // receiving alerts without needing to be opened first. Mac still owns the
  // domain events themselves — this is pure transport.
  const pushTokens = opts.pushTokenStore ?? createPushTokenStore();
  app.addHook('onClose', async () => pushTokens.close());

  // ── Chat + project-memory mirror ───────────────────────────────────
  // The desktop pushes deltas to /api/mirror/*; mobile reads from /api/mirror/*
  // when the Mac is asleep. The store is created lazily so a missing
  // MAESTRO_PG_URL doesn't block boot — `createMirrorStore` falls back to
  // in-memory in that case (see mirrorStore.ts comments).
  let mirror: MirrorStore | null = opts.mirrorStore ?? null;
  const mirrorReady: Promise<MirrorStore> = mirror
    ? Promise.resolve(mirror)
    : createMirrorStore().then((s) => { mirror = s; return s; });
  app.addHook('onClose', async () => { if (mirror) await mirror.close(); });

  const pushSeen = new Set<string>(); // dedupe keys (bounded, in-memory is fine — keys are derived)
  function rememberPushKey(k: string): boolean {
    if (pushSeen.has(k)) return false;
    pushSeen.add(k);
    if (pushSeen.size > 1000) { const first = pushSeen.values().next().value; if (first) pushSeen.delete(first); }
    return true;
  }
  async function sendExpoPush(title: string, body: string): Promise<void> {
    const tokens = pushTokens.list();
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
        const dead: string[] = [];
        json!.data!.forEach((r, i) => {
          if (r?.status === 'error' && r.details?.error === 'DeviceNotRegistered') dead.push(tokens[i]);
        });
        if (dead.length) pushTokens.prune(dead);
      }
    } catch { /* push service unreachable — SSE still carries foreground alerts */ }
  }
  // Mirror the alert-worthy events to push, matching the phone's in-app LiveNotifier.
  function maybePush(name: string, data: unknown): void {
    if (!pushTokens.size()) return;
    if (name === 'job') {
      const j = data as { id?: string; status?: string; title?: string } | null;
      if (!j?.id) return;
      if (j.status === 'done' && rememberPushKey(`${j.id}:done`)) void sendExpoPush('Conversation complete', j.title || 'A run finished on your Mac.');
      else if (j.status === 'failed' && rememberPushKey(`${j.id}:failed`)) void sendExpoPush('Job failed', j.title || 'A run failed on your Mac.');
    } else if (name === 'approval') {
      const a = data as { id?: string; status?: string; title?: string } | null;
      if (a?.id && a.status === 'pending' && rememberPushKey(`appr:${a.id}`)) void sendExpoPush('Needs your attention', a.title || 'An approval is waiting.');
    } else if (name === 'schedule-late') {
      const s = data as { id?: string; title?: string; firedAt?: number } | null;
      if (rememberPushKey(`late:${s?.id ?? ''}:${s?.firedAt ?? ''}`)) void sendExpoPush('Scheduled task ran late', s?.title ? `“${s.title}” caught up.` : 'A schedule caught up after a missed time.');
    }
  }

  // ── Forward a command to the Mac and await its result ─────────────
  function cmd<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    if (!deck || !deck.online || !deck.ws) {
      return Promise.reject(Object.assign(new Error('Your Mac is offline — open the Maestro desktop app'), { statusCode: 503 }));
    }
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        deck?.pending.delete(id);
        reject(Object.assign(new Error('Your Mac did not respond in time'), { statusCode: 504 }));
      }, CMD_TIMEOUT_MS);
      deck!.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        deck!.ws!.send(JSON.stringify({ type: 'cmd', id, method, params }));
      } catch {
        clearTimeout(timer);
        deck!.pending.delete(id);
        reject(Object.assign(new Error('Relay write failed'), { statusCode: 502 }));
      }
    });
  }

  async function forward(reply: FastifyReply, method: string, params: Record<string, unknown>) {
    try {
      return await cmd(method, params);
    } catch (e) {
      const err = e as Error & { statusCode?: number };
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }
  }

  // ── WebSocket: the Mac registers here as host ──────────────────────
  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (conn: unknown) => {
      const ws = ((conn as { socket?: WebSocket }).socket ?? conn) as WebSocket;
      let isHost = false;

      ws.on('message', (buf: Buffer | string) => {
        let m: { type?: string; role?: string; deckId?: string; secret?: string; accessToken?: string; state?: Snapshot; name?: string; data?: unknown; id?: string; ok?: boolean; result?: unknown; error?: string; statusCode?: number; deviceId?: string; did?: string; signal?: unknown };
        try { m = JSON.parse(String(buf)) as typeof m; } catch { return; }

        if (m.type === 'hello' && m.role === 'host' && m.deckId) {
          if (deck && deck.deckId === m.deckId && deck.secret && m.secret !== deck.secret) {
            ws.send(JSON.stringify({ type: 'denied', reason: 'bad secret' }));
            ws.close();
            return;
          }
          if (!deck || deck.deckId !== m.deckId) {
            deck = { deckId: m.deckId, secret: m.secret ?? '', accessToken: m.accessToken ?? '', ws, online: true, lastSeen: Date.now(), state: deck?.state ?? null, pending: new Map() };
            devices.reset(); // fresh deck → forget any prior devices/revocations
            eventBuffer.reset(); // and the replay buffer — old seqs are meaningless under a new deck
          } else {
            deck.ws = ws; deck.online = true; deck.lastSeen = Date.now();
            if (m.accessToken && m.accessToken !== deck.accessToken) {
              deck.accessToken = m.accessToken;
              devices.reset(); // code regenerated → new pairing epoch; every remote must re-pair
            }
          }
          isHost = true;
          ws.send(JSON.stringify({ type: 'hello-ok' }));
          sseSend('host', { online: true });
          notifyRemote(true); // tell the freshly-connected Mac about current remotes
          return;
        }
        if (!isHost || !deck) return;

        if (m.type === 'state' && m.state) {
          deck.state = m.state;
          deck.lastSeen = Date.now();
        } else if (m.type === 'event' && m.name) {
          sseSend(m.name, m.data);
          maybePush(m.name, m.data); // closed-app OS notification (live SSE handles the open app)
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
          for (const res of devices.kick(m.deviceId)) { try { res.end(); } catch { /* already closed */ } }
          notifyRemote(true);
        } else if (m.type === 'signal' && m.did) {
          // WebRTC signaling from the Mac to one specific remote (offer/answer/ICE).
          sseSendTo(m.did, 'signal', m.signal);
        }
      });

      ws.on('close', () => {
        if (isHost && deck && deck.ws === ws) {
          deck.online = false;
          deck.ws = null;
          for (const [, p] of deck.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error('Mac disconnected'), { statusCode: 503 })); }
          deck.pending.clear();
          sseSend('host', { online: false });
        }
      });
    });
  });

  const keepalive = setInterval(() => {
    try { deck?.ws?.send(JSON.stringify({ type: 'ping' })); } catch { /* closed */ }
  }, 25000);
  app.addHook('onClose', async () => clearInterval(keepalive));

  // ── /api/stream-ws — WebSocket transport for the event stream ──────
  // Same shape as `/api/stream` (SSE), just a full-duplex socket so we can
  // stream token-by-token chat output without the SSE reconnect tax on mobile.
  // Auth: rides the `/api/*` onRequest hook above, so the same pairing-token
  // bearer/?token= check applies — no separate auth surface.
  app.register(async (scope) => {
    scope.get('/api/stream-ws', { websocket: true }, (conn: unknown, req) => {
      const sock = ((conn as { socket?: WebSocket }).socket ?? conn) as WebSocket;
      wsStreamClients.add(sock);
      const deviceId = deviceIdOf(req);
      const deviceName = deviceNameOf(req);
      // Track presence the same way SSE does so the desktop Devices pane sees
      // a WS-connected phone as "live", not just "last seen".
      // (devices.touch already happened in onRequest; we don't have a "live
      // stream" marker for WS yet — that's a future cleanup if needed.)
      devices.touch(deviceId, deviceName);
      notifyRemote(true);

      // Mirror SSE's first frame so the client knows it's ready to consume.
      // `latestSeq` lets a fresh client start tracking from the right point.
      try { sock.send(JSON.stringify({ event: 'hello', data: { ok: true, hostOnline: !!deck?.online, latestSeq: eventBuffer.latestSeq } })); } catch { /* closed */ }
      // Catch up missed events if the client passed `?since=<seq>`. Same
      // semantics as the SSE replay — see replayWs() above.
      const since = parseSince((req.query as { since?: unknown }).since);
      if (since > 0) replayWs(sock, since);

      // Heartbeat — keeps Dokploy/intermediate proxies from idle-closing us at
      // ~30s. The browser's WebSocket layer answers pings automatically; mobile
      // libraries (react-native ws) do too.
      const heartbeat = setInterval(() => {
        try { sock.send('{"event":"ping","data":{}}'); } catch { /* closed */ }
      }, 25000);

      sock.on('message', (buf: Buffer | string) => {
        // Best-effort echo for client-side liveness probes. We don't currently
        // accept any commands over the stream socket — POSTs still go through
        // the REST surface for predictable error handling.
        try {
          const m = JSON.parse(String(buf)) as { type?: string };
          if (m.type === 'ping') sock.send('{"event":"pong","data":{}}');
        } catch { /* ignore garbage */ }
      });

      sock.on('close', () => {
        clearInterval(heartbeat);
        wsStreamClients.delete(sock);
        notifyRemote(true);
      });
      sock.on('error', () => {
        clearInterval(heartbeat);
        wsStreamClients.delete(sock);
      });
    });
  });

  const st = (): Snapshot | null => deck?.state ?? null;

  // ── Health / meta ──────────────────────────────────────────────────
  app.get('/health', async () => ({
    ok: true, name: 'maestro-relay', version: '0.3.0', mode: 'relay',
    host: { online: !!deck?.online, lastSeen: deck?.lastSeen ?? null, hasState: !!deck?.state },
    time: Date.now(),
  }));
  app.get('/', async () => ({
    ok: true, service: 'maestro-relay',
    docs: 'GETs mirror the Mac’s snapshot; POSTs execute ON the Mac. /ws is the host socket.',
  }));

  // ── Reads — served from the Mac's mirrored snapshot ───────────────
  app.get('/api/dashboard', async () => st()?.dashboard ?? EMPTY_DASHBOARD);
  app.get('/api/budget', async () => st()?.budget ?? EMPTY_DASHBOARD.budget);
  app.get('/api/costs', async () => st()?.costs ?? { today: 0, thisMonth: 0, projectedMonth: 0, byDay: [], byProject: [], byEngine: [], includedCodexRuns: 0, claudeRuns: 0 });
  app.get('/api/events', async () => st()?.events ?? []);
  app.get('/api/settings', async () => st()?.settings ?? null);
  app.get('/api/engine-status', async () => st()?.engineStatus ?? { claude: { engine: 'claude', available: false, method: 'none', detail: 'Mac offline', reason: 'Desktop not connected.' }, codex: { engine: 'codex', available: false, method: 'none', detail: 'Mac offline', reason: 'Desktop not connected.' } });
  // ── Media Studio (assets mirror; generation forwards to the Mac's fal key) ──
  app.get('/api/assets', async (req) => {
    const projectId = (req.query as { projectId?: string }).projectId;
    const assets = st()?.assets ?? [];
    return projectId ? assets.filter((a) => a.projectId === projectId) : assets;
  });
  app.get('/api/media/rates', async () => st()?.mediaRates ?? []);
  // ── Trends (briefs mirror; runs forward to the Mac's research engine) ──
  app.get('/api/briefs', async () => st()?.briefs ?? []);
  app.get('/api/research-runs', async () => st()?.researchRuns ?? []);
  app.post('/api/research/run', async (req, reply) => forward(reply, 'runResearch', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/briefs/:id/sent', async (req, reply) => forward(reply, 'markBriefSent', { id: (req.params as { id: string }).id }));
  // ── Publishing (drafts mirror; actions forward to the Mac's local pipeline) ──
  app.get('/api/publish/drafts', async () => st()?.publishDrafts ?? []);
  app.get('/api/publish/ledger', async () => st()?.publishLedger ?? []);
  app.post('/api/publish/drafts', async (req, reply) => forward(reply, 'createDraft', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/publish/drafts/:id/update', async (req, reply) => forward(reply, 'updateDraft', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/publish/drafts/:id/schedule', async (req, reply) => forward(reply, 'scheduleDraft', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/publish/drafts/:id/export', async (req, reply) => forward(reply, 'exportDraft', { id: (req.params as { id: string }).id }));
  app.post('/api/publish/drafts/:id/published', async (req, reply) => forward(reply, 'markPublished', { id: (req.params as { id: string }).id }));
  app.post('/api/publish/drafts/:id/delete', async (req, reply) => forward(reply, 'deleteDraft', { id: (req.params as { id: string }).id }));
  // ── Comms (Telegram) — status/bindings mirror; actions forward to the Mac ──
  app.get('/api/comms/status', async () => st()?.commsStatus ?? { telegram: { connected: false, botUsername: null, tokenLast4: null, messagesToday: 0, bindings: 0, pending: 0 }, whatsapp: { connected: false } });
  app.get('/api/comms/bindings', async () => st()?.chatBindings ?? []);
  app.get('/api/comms/pending', async () => st()?.pendingChats ?? []);
  app.get('/api/comms/events', async () => st()?.commEvents ?? []);
  // ── Feedback (mirror the Mac's list; submit/triage forward to the Mac) ──
  app.get('/api/feedback', async () => st()?.feedback ?? []);
  app.post('/api/comms/telegram/connect', async (req, reply) => forward(reply, 'connectTelegram', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/comms/telegram/disconnect', async (_req, reply) => forward(reply, 'disconnectTelegram', {}));
  app.post('/api/comms/bind', async (req, reply) => forward(reply, 'bindChat', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/comms/unbind', async (req, reply) => forward(reply, 'unbindChat', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/comms/permissions', async (req, reply) => forward(reply, 'setChatPermissions', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/assets/generate', async (req, reply) => forward(reply, 'generateAsset', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/assets/:id/cancel', async (req, reply) => forward(reply, 'cancelAsset', { id: (req.params as { id: string }).id }));
  app.post('/api/assets/:id/approve', async (req, reply) => forward(reply, 'approveAsset', { id: (req.params as { id: string }).id }));
  app.post('/api/assets/:id/delete', async (req, reply) => forward(reply, 'deleteAsset', { id: (req.params as { id: string }).id }));
  app.get('/api/workspaces', async () => st()?.workspaces ?? []);
  app.get('/api/projects', async () => st()?.projects ?? []);
  app.get('/api/projects/:id', async (req, reply) => {
    const p = (st()?.projects ?? []).find((x) => x.id === (req.params as { id: string }).id);
    return p ?? reply.code(404).send({ error: 'project not found' });
  });
  // Repo info is computed by git ON THE MAC; remotes get a best-effort view from
  // the mirrored project (branch unknown remotely → null).
  app.get('/api/projects/:id/repo', async (req) => {
    const p = (st()?.projects ?? []).find((x) => x.id === (req.params as { id: string }).id) as { path?: string; repoUrl?: string } | undefined;
    return { branch: null, remote: p?.repoUrl ?? null, isRepo: !!p?.path };
  });
  app.get('/api/jobs', async (req) => {
    const { projectId, sessionId } = req.query as { projectId?: string; sessionId?: string };
    const jobs = st()?.jobs ?? [];
    if (sessionId) return jobs.filter((j) => j.sessionId === sessionId);
    return projectId ? jobs.filter((j) => j.projectId === projectId) : jobs;
  });
  app.get('/api/sessions', async (req) => {
    const projectId = (req.query as { projectId?: string }).projectId;
    const sessions = st()?.sessions ?? [];
    return projectId ? sessions.filter((s) => s.projectId === projectId) : sessions;
  });
  app.get('/api/jobs/:id', async (req, reply) => {
    const j = (st()?.jobs ?? []).find((x) => x.id === (req.params as { id: string }).id);
    return j ?? reply.code(404).send({ error: 'job not found' });
  });
  // Diff is computed by git ON THE MAC (read-only) — forward and return its result.
  app.get('/api/jobs/:id/diff', async (req, reply) => forward(reply, 'getJobDiff', { id: (req.params as { id: string }).id }));
  app.get('/api/approvals', async (req) => {
    const status = (req.query as { status?: string }).status;
    const approvals = st()?.approvals ?? [];
    return status ? approvals.filter((a) => a.status === status) : approvals;
  });
  app.get('/api/schedules', async () => st()?.schedules ?? []);
  app.get('/api/skills', async () => st()?.skills ?? []);
  app.get('/api/templates', async () => st()?.templates ?? []);
  app.get('/api/providers', async () => st()?.providers ?? []);
  app.get('/api/routing', async () => (st() as { routing?: unknown } | null)?.routing ?? { master: 'claude', reviewer: 'off', image: 'codex', video: 'codex' });
  app.get('/api/models', async () => (st() as { models?: unknown } | null)?.models ?? []);

  // ── Writes — forwarded to the Mac, executed there ──────────────────
  app.post('/api/workspaces', async (req, reply) => forward(reply, 'createWorkspace', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/workspaces/:id/budget', async (req, reply) =>
    forward(reply, 'setBudgetCap', { ...(req.body ?? {}) as Record<string, unknown>, workspaceId: (req.params as { id: string }).id }));
  app.post('/api/projects', async (req, reply) => forward(reply, 'createProject', (req.body ?? {}) as Record<string, unknown>));
  // Read-only folder browser on the Mac (for the phone's new-project location picker).
  app.get('/api/browse', async (req, reply) => forward(reply, 'browseDir', { path: (req.query as { path?: string }).path }));
  app.post('/api/projects/:id/update', async (req, reply) =>
    forward(reply, 'updateProject', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/projects/reorder', async (req, reply) => forward(reply, 'reorderProjects', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/projects/clone', async (req, reply) => forward(reply, 'cloneRepo', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/projects/:id/delete', async (req, reply) => forward(reply, 'deleteProject', { id: (req.params as { id: string }).id }));
  app.post('/api/chat', async (req, reply) => forward(reply, 'sendChat', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/sessions/:id/rename', async (req, reply) =>
    forward(reply, 'renameSession', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/sessions/:id/delete', async (req, reply) => forward(reply, 'deleteSession', { id: (req.params as { id: string }).id }));
  app.post('/api/sessions/:id/pin', async (req, reply) =>
    forward(reply, 'pinSession', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/sessions/:id/archive', async (req, reply) =>
    forward(reply, 'archiveSession', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/settings', async (req, reply) => forward(reply, 'setSettings', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/jobs', async (req, reply) => forward(reply, 'createJob', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/jobs/run', async (req, reply) => forward(reply, 'createAndRunJob', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/jobs/:id/run', async (req, reply) =>
    forward(reply, 'runJob', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/jobs/:id/cancel', async (req, reply) => forward(reply, 'cancelJob', { id: (req.params as { id: string }).id }));
  app.post('/api/jobs/:id/delete', async (req, reply) => forward(reply, 'deleteJob', { id: (req.params as { id: string }).id }));
  app.post('/api/approvals/:id/approve', async (req, reply) => forward(reply, 'approveApproval', { id: (req.params as { id: string }).id }));
  app.post('/api/approvals/:id/deny', async (req, reply) => forward(reply, 'denyApproval', { id: (req.params as { id: string }).id }));
  app.post('/api/schedules', async (req, reply) => forward(reply, 'createSchedule', (req.body ?? {}) as Record<string, unknown>));
  app.patch('/api/schedules/:id', async (req, reply) =>
    forward(reply, 'updateSchedule', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/schedules/check', async (req, reply) => forward(reply, 'scheduleCheck', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/schedules/:id/toggle', async (req, reply) =>
    forward(reply, 'toggleSchedule', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/schedules/:id/delete', async (req, reply) => forward(reply, 'deleteSchedule', { id: (req.params as { id: string }).id }));
  app.post('/api/skills/:id/toggle', async (req, reply) => forward(reply, 'toggleSkill', { id: (req.params as { id: string }).id }));
  app.post('/api/providers/:provider/connect', async (req, reply) =>
    forward(reply, 'connectProvider', { ...(req.body ?? {}) as Record<string, unknown>, provider: (req.params as { provider: string }).provider }));
  app.post('/api/providers/:provider/disconnect', async (req, reply) =>
    forward(reply, 'disconnectProvider', { ...(req.body ?? {}) as Record<string, unknown>, provider: (req.params as { provider: string }).provider }));
  app.post('/api/routing', async (req, reply) => forward(reply, 'setRouting', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/roles', async (req, reply) => forward(reply, 'setRoles', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/feedback', async (req, reply) => forward(reply, 'submitFeedback', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/feedback/:id/update', async (req, reply) =>
    forward(reply, 'updateFeedback', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/feedback/:id/delete', async (req, reply) => forward(reply, 'deleteFeedback', { id: (req.params as { id: string }).id }));

  // ── WebRTC signaling passthrough + TURN creds (P2P transport setup) ──
  // Signaling rides the already-authenticated relay: the phone POSTs its SDP/ICE
  // here, we hand it to the Mac (host WS), and the Mac's replies come back over
  // the device's own SSE stream as `event: signal`. No new server, no second QR.
  app.post('/api/signal', async (req, reply) => {
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
  // Tokens persist (see pushTokens.ts) — a redeploy no longer wipes the device list.
  // We also stash the calling device id/name so the desktop can correlate "which
  // phone is registered for push" against the Devices pane.
  app.post('/api/push/register', async (req) => {
    const { token } = (req.body ?? {}) as { token?: string };
    if (typeof token === 'string' && token.trim()) {
      pushTokens.upsert(token, { deviceId: deviceIdOf(req), deviceName: deviceNameOf(req) });
    }
    return { ok: true, devices: pushTokens.size() };
  });
  app.post('/api/push/unregister', async (req) => {
    const { token } = (req.body ?? {}) as { token?: string };
    if (typeof token === 'string') pushTokens.remove(token);
    return { ok: true, devices: pushTokens.size() };
  });
  // Mobile Settings → "Push status" pings this on focus to confirm the relay has
  // the phone's token (i.e. closed-app alerts will actually fire). Returns just
  // a boolean for the current token + the total registered device count, never
  // the raw list (don't leak other devices' tokens).
  app.post('/api/push/status', async (req) => {
    const { token } = (req.body ?? {}) as { token?: string };
    const t = typeof token === 'string' ? token.trim() : '';
    const registered = t ? pushTokens.list().includes(t) : false;
    return { ok: true, registered, devices: pushTokens.size() };
  });

  // ── SSE stream (host events relayed to web clients) ────────────────
  app.get('/api/stream', (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    // The hello frame carries `latestSeq` so a client connecting fresh (no
    // prior `since`) immediately knows what seq to start tracking from.
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, hostOnline: !!deck?.online, latestSeq: eventBuffer.latestSeq })}\n\n`);
    const deviceId = deviceIdOf(req);
    // Order matters: add to live set FIRST so events that fire mid-replay
    // are still delivered (sseSend is sync — there's no actual race window
    // in Node's single-threaded event loop, but this also gives us correct
    // ordering for tests). Replay happens immediately after.
    sseClients.add(res);
    devices.addStream(deviceId, deviceNameOf(req), res);
    notifyRemote(true); // a live remote stream opened
    // Catch up missed events. `?since=<seq>` from the client (defaults to 0 →
    // no replay). On buffer-overflow we send a `buffer-overflow` frame the
    // mobile uses as a "do a full refetch" signal.
    const since = parseSince((req.query as { since?: unknown }).since);
    if (since > 0) replaySse(res, since);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 25000);
    req.raw.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
      devices.removeStream(deviceId, res);
      notifyRemote(true); // stream closed → presence drops
    });
  });

  // ── Chat + memory mirror endpoints (Phase 2) ───────────────────────
  // Reads: mobile/web hit these when the Mac is asleep so the phone still
  // shows yesterday's chats and the project's current STATE.md.
  // Writes: the desktop SyncWorker (apps/desktop/electron/syncWorker.ts)
  // pushes deltas here as the agent writes new messages and checkpoints to
  // disk. Auth: same pairing-token gate as every other /api/* route — there's
  // no separate write surface today (single-tenant per Mac). When Better Auth
  // lands (per maestro-account-multitenant memory), POSTs will be gated to
  // the host's token specifically.
  app.get('/api/mirror/chats', async (req, reply) => {
    const m = await mirrorReady;
    const { projectId, accountId } = req.query as { projectId?: string; accountId?: string };
    const acc = accountId || 'self';
    // `projectId=` unset → ALL chats; `projectId=null` → workspace-level
    // chats; `projectId=<id>` → chats in that project.
    const proj = projectId === undefined ? undefined : projectId === 'null' ? null : projectId;
    try { return await m.listChats(acc, proj); }
    catch (e) { return reply.code(500).send({ error: e instanceof Error ? e.message : 'mirror read failed' }); }
  });

  app.get('/api/mirror/chats/:id', async (req, reply) => {
    const m = await mirrorReady;
    const id = (req.params as { id: string }).id;
    const chat = await m.getChat(id);
    return chat ?? reply.code(404).send({ error: 'chat not found in mirror' });
  });

  app.get('/api/mirror/chats/:id/messages', async (req, reply) => {
    const m = await mirrorReady;
    const id = (req.params as { id: string }).id;
    const { limit, before } = req.query as { limit?: string; before?: string };
    try {
      return await m.listMessages(id, {
        limit: limit ? Number(limit) : undefined,
        beforeCreatedAt: before ? Number(before) : undefined,
      });
    } catch (e) { return reply.code(500).send({ error: e instanceof Error ? e.message : 'mirror read failed' }); }
  });

  app.get('/api/mirror/memories', async (req, reply) => {
    const m = await mirrorReady;
    const { projectId, accountId } = req.query as { projectId?: string; accountId?: string };
    if (!projectId) return reply.code(400).send({ error: 'projectId is required' });
    try { return await m.listMemories(accountId || 'self', projectId); }
    catch (e) { return reply.code(500).send({ error: e instanceof Error ? e.message : 'mirror read failed' }); }
  });

  app.post('/api/mirror/chat', async (req, reply) => {
    const m = await mirrorReady;
    const body = (req.body ?? {}) as UpsertChat;
    if (!body.id) return reply.code(400).send({ error: 'id is required' });
    try { return await m.upsertChat(body); }
    catch (e) { return reply.code(500).send({ error: e instanceof Error ? e.message : 'mirror write failed' }); }
  });

  app.post('/api/mirror/chats/:id/messages', async (req, reply) => {
    const m = await mirrorReady;
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { messages?: UpsertMessage[] };
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    if (!msgs.length) return reply.code(400).send({ error: 'messages[] is required' });
    // Force chatId on every row (the URL is the truth, not the body) so a
    // misconfigured client can't insert messages under the wrong chat.
    const stamped = msgs.map((mm) => ({ ...mm, chatId: id }));
    try {
      const written = await m.upsertMessages(stamped);
      return { ok: true, written };
    } catch (e) { return reply.code(500).send({ error: e instanceof Error ? e.message : 'mirror write failed' }); }
  });

  app.post('/api/mirror/memory', async (req, reply) => {
    const m = await mirrorReady;
    const body = (req.body ?? {}) as UpsertMemory;
    if (!body.projectId || !body.kind) return reply.code(400).send({ error: 'projectId + kind are required' });
    try { return await m.upsertMemory(body); }
    catch (e) { return reply.code(500).send({ error: e instanceof Error ? e.message : 'mirror write failed' }); }
  });

  // Skill registry (read-only reference content, public, /registry/* — see registry.ts).
  registerRegistry(app);

  return app;
}
