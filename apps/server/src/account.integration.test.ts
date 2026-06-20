import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { runMigrations, getDb, closeDb } from './db.js';
import { auth, migrateAuth } from './auth.js';
import { buildAccountServer } from './accountServer.js';

const HAS_DB = !!process.env.TEST_DATABASE_URL;

function wsOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => { ws.once('open', () => resolve()); ws.once('error', reject); });
}
function nextMsg(ws: WebSocket, type: string, timeoutMs = 4000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', h); reject(new Error('timeout waiting for ' + type)); }, timeoutMs);
    const h = (buf: Buffer): void => {
      let m: Record<string, unknown>; try { m = JSON.parse(String(buf)); } catch { return; }
      if (m.type === type) { clearTimeout(t); ws.off('message', h); resolve(m); }
    };
    ws.on('message', h);
  });
}
async function api(port: number, token: string, path: string): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function apiPost(port: number, token: string, path: string, body: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function signup(email: string): Promise<{ token: string; userId: string }> {
  const r = await auth.api.signUpEmail({ body: { email, password: 'pw-12345678', name: 'U' } });
  return { token: r.token as string, userId: r.user.id };
}

describe.skipIf(!HAS_DB)('account server e2e', () => {
  let app: ReturnType<typeof buildAccountServer>;
  let port: number;
  beforeAll(async () => {
    await runMigrations();
    await migrateAuth();
    await getDb().deleteFrom('device').execute();
    app = buildAccountServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });
  afterAll(async () => { await app.close(); await closeDb(); });

  it('host registers → online to owner, hidden from others; event + command flow; isolation', async () => {
    const A = await signup(`a${Date.now()}@x.dev`);
    const B = await signup(`b${Date.now()}@x.dev`);
    const hostId = 'mac-' + Date.now();

    const hostWs = new WebSocket(`ws://127.0.0.1:${port}/ws/host?token=${A.token}&did=${hostId}`);
    await wsOpen(hostWs);
    hostWs.on('message', (buf: Buffer) => {
      let m: Record<string, unknown>; try { m = JSON.parse(String(buf)); } catch { return; }
      if (m.type === 'cmd') hostWs.send(JSON.stringify({ type: 'result', cmdId: m.cmdId, ok: true, result: { echo: m.method } }));
    });
    const helloOk = nextMsg(hostWs, 'hello-ok');
    hostWs.send(JSON.stringify({ type: 'hello', name: 'My Mac', platform: 'macos', deckId: 'd1' }));
    await helloOk;

    // owner sees it online; other account does not (isolation)
    const devsA = await api(port, A.token, '/api/devices');
    expect(devsA.status).toBe(200);
    expect(devsA.body.find((d: { id: string }) => d.id === hostId)?.online).toBe(true);
    const devsB = await api(port, B.token, '/api/devices');
    expect(devsB.body.find((d: { id: string }) => d.id === hostId)).toBeUndefined();

    // remote (A) targets the host and receives a live event
    const remoteWs = new WebSocket(`ws://127.0.0.1:${port}/ws/remote?token=${A.token}&did=phone-${Date.now()}&host=${hostId}`);
    await wsOpen(remoteWs);
    await nextMsg(remoteWs, 'hello');
    const evP = nextMsg(remoteWs, 'event');
    hostWs.send(JSON.stringify({ type: 'event', eventName: 'job', data: { id: 'j1' } }));
    expect((await evP).name).toBe('job');

    // command round-trips through the server
    const res = await apiPost(port, A.token, '/api/cmd', { hostId, method: 'ping', params: {} });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ echo: 'ping' });

    // isolation: B cannot command A's host
    const cross = await apiPost(port, B.token, '/api/cmd', { hostId, method: 'ping', params: {} });
    expect(cross.status).toBe(404);

    hostWs.close();
    remoteWs.close();
  });
});
