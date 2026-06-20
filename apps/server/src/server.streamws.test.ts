/* Integration test for /api/stream-ws — the WebSocket transport that mirrors
   the SSE event stream. We spin up the real Fastify instance on an ephemeral
   port, fake a host hello so auth passes, then verify:
     1. The first frame is `{ event: 'hello' }`.
     2. A host event fans out to the stream-ws client.
     3. Unauthorized connects are rejected with 401.

   Frame collection uses a persistent `'message'` listener that pushes every
   parsed frame into an array — the prior implementation's add/remove dance
   leaked the first message of test 2 onto the cleanup of test 1's socket. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import { buildServer } from './server.js';
import type { FastifyInstance } from 'fastify';

const PAIR_TOKEN = 'tok-streamws';
const DECK_ID = 'deck-streamws';

let app: FastifyInstance;
let port = 0;
let hostSock: WebSocket;

beforeAll(async () => {
  app = buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('listen failed');
  port = addr.port;

  // Fake a host hello so the pairing-token gate accepts test traffic.
  hostSock = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  await once(hostSock, 'open');
  hostSock.send(JSON.stringify({ type: 'hello', role: 'host', deckId: DECK_ID, secret: 'sec', accessToken: PAIR_TOKEN }));
  // Give the server a tick to register the deck (we don't need to read the
  // ack — the broadcast test below confirms the deck is paired).
  await new Promise((r) => setTimeout(r, 100));
});

afterAll(async () => {
  try { hostSock?.close(); } catch { /* fine */ }
  await app.close();
});

describe('/api/stream-ws', () => {
  it('sends a hello frame on connect', async () => {
    const c = await connectStream();
    try {
      const f = await c.next((m) => m.event === 'hello');
      expect(f.event).toBe('hello');
      expect((f.data as { ok?: boolean }).ok).toBe(true);
    } finally {
      c.close();
    }
  });

  it('rejects an unauthenticated upgrade with 401', async () => {
    const url = `ws://127.0.0.1:${port}/api/stream-ws`;
    const sock = new WebSocket(url);
    // Swallow the inevitable "ECONNRESET" / "closed before established" error
    // — the relay correctly nukes the upgrade with a 401 response, which `ws`
    // surfaces as a connection error too.
    sock.on('error', () => { /* expected */ });
    const code = await new Promise<number>((resolve) => {
      sock.once('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      sock.once('open', () => resolve(0));
      setTimeout(() => resolve(-1), 1500);
    });
    expect(code).toBe(401);
    // Don't call sock.close() — the upgrade was rejected, the socket is
    // already in CLOSING/CLOSED. Calling close() throws "WebSocket was closed
    // before the connection was established", which vitest treats as an
    // unhandled error.
  });

  it('fans out a host event to a connected client', async () => {
    const c = await connectStream();
    try {
      await c.next((m) => m.event === 'hello'); // drain the greeting
      // Emit a host event — sseSend() pushes it to both SSE and WS clients.
      hostSock.send(JSON.stringify({ type: 'event', name: 'job', data: { id: 'j1', status: 'done', title: 'Test' } }));
      const f = await c.next((m) => m.event === 'job');
      expect(f.event).toBe('job');
      expect((f.data as { id?: string }).id).toBe('j1');
    } finally {
      c.close();
    }
  });

  it('drops a closed client from the fan-out set', async () => {
    // Indirectly: open + close one client, then verify a NEW client still
    // receives the next broadcast (i.e. the dead one didn't take the set
    // with it).
    const a = await connectStream();
    await a.next((m) => m.event === 'hello');
    a.close();
    await new Promise((r) => setTimeout(r, 50));

    const b = await connectStream();
    try {
      await b.next((m) => m.event === 'hello');
      hostSock.send(JSON.stringify({ type: 'event', name: 'job', data: { id: 'j2', status: 'done', title: 'Another' } }));
      const f = await b.next((m) => m.event === 'job');
      expect((f.data as { id?: string }).id).toBe('j2');
    } finally {
      b.close();
    }
  });
});

/* ── test helpers ────────────────────────────────────────────────────── */

interface Frame { event?: string; data?: unknown; type?: string }

/** A WS wrapper that buffers every frame so callers can `next(pred)` for the
    first matching one, no listener lifecycle to track. */
interface StreamClient {
  next(pred: (m: Frame) => boolean): Promise<Frame>;
  close(): void;
}

async function connectStream(): Promise<StreamClient> {
  const url = `ws://127.0.0.1:${port}/api/stream-ws?token=${encodeURIComponent(PAIR_TOKEN)}&did=test-dev&device=Test`;
  const sock = new WebSocket(url);
  const buf: Frame[] = [];
  const waiters: { pred: (m: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  sock.on('message', (raw: Buffer | string) => {
    let m: Frame;
    try { m = JSON.parse(String(raw)) as Frame; } catch { return; }
    buf.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) {
        waiters[i].resolve(m);
        waiters.splice(i, 1);
        const idx = buf.indexOf(m);
        if (idx >= 0) buf.splice(idx, 1);
      }
    }
  });
  await once(sock, 'open');
  return {
    next(pred) {
      // First, check the already-buffered frames.
      for (let i = 0; i < buf.length; i++) {
        if (pred(buf[i])) {
          const m = buf[i];
          buf.splice(i, 1);
          return Promise.resolve(m);
        }
      }
      return new Promise<Frame>((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const idx = waiters.indexOf(w);
          if (idx >= 0) { waiters.splice(idx, 1); reject(new Error('timeout waiting for matching frame')); }
        }, 3000);
      });
    },
    close() { try { sock.close(); } catch { /* fine */ } },
  };
}

function once(sock: WebSocket, ev: 'open' | 'close'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${ev}`)), 3000);
    sock.once(ev, () => { clearTimeout(t); resolve(); });
    sock.once('error', (e: Error) => { clearTimeout(t); reject(e); });
  });
}
