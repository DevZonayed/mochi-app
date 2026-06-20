/* Integration test for the mirror HTTP surface.
   We inject an InMemoryMirrorStore into buildServer so reads/writes round-
   trip without spinning up Postgres. Auth: same pairing-token gate as every
   other /api/* route — we fake a host hello first so the gate accepts our
   bearer. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './server.js';
import { createInMemoryMirrorStore, type MirrorStore } from './mirrorStore.js';

const TOKEN = 'tok-mirror';

let app: FastifyInstance;
let mirror: MirrorStore;
let baseUrl = '';

beforeAll(async () => {
  mirror = createInMemoryMirrorStore();
  app = buildServer({ mirrorStore: mirror });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (!addr || typeof addr === 'string') throw new Error('listen failed');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  // Fake a host hello to set deck.accessToken so the /api/* auth gate accepts
  // our bearer. Pattern matches server.streamws.test.ts.
  const host = new WebSocket(`ws://127.0.0.1:${addr.port}/ws`);
  await new Promise<void>((resolve, reject) => {
    host.once('open', () => resolve());
    host.once('error', reject);
  });
  host.send(JSON.stringify({ type: 'hello', role: 'host', deckId: 'd1', secret: 's', accessToken: TOKEN }));
  await new Promise((r) => setTimeout(r, 100));
  // Stash so afterAll can close it.
  (globalThis as { __mirHost?: WebSocket }).__mirHost = host;
});

afterAll(async () => {
  try { (globalThis as { __mirHost?: WebSocket }).__mirHost?.close(); } catch { /* fine */ }
  await app.close();
});

const req = async (path: string, init: RequestInit = {}) => {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'content-type': 'application/json',
    ...(init.headers as Record<string, string> | undefined ?? {}),
  };
  return fetch(baseUrl + path, { ...init, headers });
};

describe('/api/mirror/*', () => {
  it('401s when the pairing token is missing', async () => {
    const res = await fetch(baseUrl + '/api/mirror/chats');
    expect(res.status).toBe(401);
  });

  it('POST /api/mirror/chat upserts and GET /api/mirror/chats reads back', async () => {
    const post = await req('/api/mirror/chat', {
      method: 'POST',
      body: JSON.stringify({ id: 'c1', projectId: 'p1', title: 'Conv 1' }),
    });
    expect(post.status).toBe(200);
    const list = await (await req('/api/mirror/chats?projectId=p1')).json() as { id: string; title: string }[];
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('c1');
    expect(list[0].title).toBe('Conv 1');
  });

  it('POST /api/mirror/chat without id returns 400', async () => {
    const res = await req('/api/mirror/chat', { method: 'POST', body: JSON.stringify({ title: 'no id' }) });
    expect(res.status).toBe(400);
  });

  it('POST /api/mirror/chats/:id/messages appends and stamps chatId from the URL', async () => {
    await req('/api/mirror/chat', { method: 'POST', body: JSON.stringify({ id: 'c2', projectId: 'p2', title: 'Conv 2' }) });
    const res = await req('/api/mirror/chats/c2/messages', {
      method: 'POST',
      body: JSON.stringify({
        messages: [
          // Note: this row's body chatId says 'wrong'. The endpoint MUST
          // overwrite with 'c2' from the URL — otherwise a misconfigured
          // client could insert messages under the wrong chat.
          { id: 'm1', chatId: 'wrong', role: 'user', content: 'hi', createdAt: 1000 },
          { id: 'm2', chatId: 'wrong', role: 'assistant', content: 'hello', createdAt: 1001 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; written: number };
    expect(body.written).toBe(2);

    const page = await (await req('/api/mirror/chats/c2/messages?limit=10')).json() as {
      messages: { id: string; chatId: string }[]; hasMore: boolean;
    };
    expect(page.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    // chatId was forced from URL, not the body.
    expect(page.messages[0].chatId).toBe('c2');
  });

  it('POST messages with empty array returns 400', async () => {
    const res = await req('/api/mirror/chats/c2/messages', { method: 'POST', body: JSON.stringify({ messages: [] }) });
    expect(res.status).toBe(400);
  });

  it('GET /api/mirror/chats/:id 404s for an unknown chat', async () => {
    const res = await req('/api/mirror/chats/nope');
    expect(res.status).toBe(404);
  });

  it('memory: POST /api/mirror/memory + GET /api/mirror/memories?projectId round-trip', async () => {
    await req('/api/mirror/memory', { method: 'POST', body: JSON.stringify({ projectId: 'p9', kind: 'state', content: 'A' }) });
    await req('/api/mirror/memory', { method: 'POST', body: JSON.stringify({ projectId: 'p9', kind: 'state', content: 'B' }) });
    const list = await (await req('/api/mirror/memories?projectId=p9')).json() as { content: string }[];
    expect(list).toHaveLength(1);
    expect(list[0].content).toBe('B'); // state is single-row per project; latest wins
  });

  it('GET /api/mirror/memories requires projectId', async () => {
    const res = await req('/api/mirror/memories');
    expect(res.status).toBe(400);
  });
});
