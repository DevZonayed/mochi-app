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

import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { WebSocket } from 'ws';

interface Snapshot {
  workspace?: unknown;
  workspaces?: unknown[];
  projects?: { id?: string }[];
  jobs?: { id?: string; projectId?: string }[];
  approvals?: { id?: string; status?: string }[];
  schedules?: unknown[];
  skills?: unknown[];
  templates?: unknown[];
  budget?: unknown;
  dashboard?: unknown;
  providers?: unknown[];
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

  // Single-operator product: one deck (the most recent Mac to register).
  let deck: Deck | null = null;

  // ── SSE fan-out to web clients ─────────────────────────────────────
  const sseClients = new Set<ServerResponse>();
  function sseSend(event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch { sseClients.delete(res); }
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
        let m: { type?: string; role?: string; deckId?: string; secret?: string; state?: Snapshot; name?: string; data?: unknown; id?: string; ok?: boolean; result?: unknown; error?: string; statusCode?: number };
        try { m = JSON.parse(String(buf)) as typeof m; } catch { return; }

        if (m.type === 'hello' && m.role === 'host' && m.deckId) {
          if (deck && deck.deckId === m.deckId && deck.secret && m.secret !== deck.secret) {
            ws.send(JSON.stringify({ type: 'denied', reason: 'bad secret' }));
            ws.close();
            return;
          }
          if (!deck || deck.deckId !== m.deckId) {
            deck = { deckId: m.deckId, secret: m.secret ?? '', ws, online: true, lastSeen: Date.now(), state: deck?.state ?? null, pending: new Map() };
          } else {
            deck.ws = ws; deck.online = true; deck.lastSeen = Date.now();
          }
          isHost = true;
          ws.send(JSON.stringify({ type: 'hello-ok' }));
          sseSend('host', { online: true });
          return;
        }
        if (!isHost || !deck) return;

        if (m.type === 'state' && m.state) {
          deck.state = m.state;
          deck.lastSeen = Date.now();
        } else if (m.type === 'event' && m.name) {
          sseSend(m.name, m.data);
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
  app.get('/api/workspaces', async () => st()?.workspaces ?? []);
  app.get('/api/projects', async () => st()?.projects ?? []);
  app.get('/api/projects/:id', async (req, reply) => {
    const p = (st()?.projects ?? []).find((x) => x.id === (req.params as { id: string }).id);
    return p ?? reply.code(404).send({ error: 'project not found' });
  });
  app.get('/api/jobs', async (req) => {
    const projectId = (req.query as { projectId?: string }).projectId;
    const jobs = st()?.jobs ?? [];
    return projectId ? jobs.filter((j) => j.projectId === projectId) : jobs;
  });
  app.get('/api/jobs/:id', async (req, reply) => {
    const j = (st()?.jobs ?? []).find((x) => x.id === (req.params as { id: string }).id);
    return j ?? reply.code(404).send({ error: 'job not found' });
  });
  app.get('/api/approvals', async (req) => {
    const status = (req.query as { status?: string }).status;
    const approvals = st()?.approvals ?? [];
    return status ? approvals.filter((a) => a.status === status) : approvals;
  });
  app.get('/api/schedules', async () => st()?.schedules ?? []);
  app.get('/api/skills', async () => st()?.skills ?? []);
  app.get('/api/templates', async () => st()?.templates ?? []);
  app.get('/api/providers', async () => st()?.providers ?? []);

  // ── Writes — forwarded to the Mac, executed there ──────────────────
  app.post('/api/workspaces', async (req, reply) => forward(reply, 'createWorkspace', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/workspaces/:id/budget', async (req, reply) =>
    forward(reply, 'setBudgetCap', { ...(req.body ?? {}) as Record<string, unknown>, workspaceId: (req.params as { id: string }).id }));
  app.post('/api/projects', async (req, reply) => forward(reply, 'createProject', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/jobs', async (req, reply) => forward(reply, 'createJob', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/jobs/run', async (req, reply) => forward(reply, 'createAndRunJob', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/jobs/:id/run', async (req, reply) =>
    forward(reply, 'runJob', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/approvals/:id/approve', async (req, reply) => forward(reply, 'approveApproval', { id: (req.params as { id: string }).id }));
  app.post('/api/approvals/:id/deny', async (req, reply) => forward(reply, 'denyApproval', { id: (req.params as { id: string }).id }));
  app.post('/api/schedules', async (req, reply) => forward(reply, 'createSchedule', (req.body ?? {}) as Record<string, unknown>));
  app.post('/api/schedules/:id/toggle', async (req, reply) =>
    forward(reply, 'toggleSchedule', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
  app.post('/api/skills/:id/toggle', async (req, reply) => forward(reply, 'toggleSkill', { id: (req.params as { id: string }).id }));
  app.post('/api/providers/:provider/connect', async (req, reply) =>
    forward(reply, 'connectProvider', { ...(req.body ?? {}) as Record<string, unknown>, provider: (req.params as { provider: string }).provider }));
  app.post('/api/providers/:provider/disconnect', async (req, reply) =>
    forward(reply, 'disconnectProvider', { ...(req.body ?? {}) as Record<string, unknown>, provider: (req.params as { provider: string }).provider }));

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
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true, hostOnline: !!deck?.online })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* closed */ }
    }, 25000);
    req.raw.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  return app;
}
