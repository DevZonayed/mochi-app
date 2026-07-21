/* Phase 3B0 NOTE-3 — the relay must never echo a raw exception (path / stack /
   SQL / Postgres+HTTPS connection string with userinfo/password/token) back to a
   client. `forward()`'s catch used to `send({ error: err.message })` for any
   statusCode-less failure. These tests inject exact canaries through a
   statusCode-less / internal-500 host error and prove the HTTP body is generic,
   while a typed-safe 4xx domain message still passes through unchanged. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type AddressInfo } from 'ws';

vi.mock('./registry.js', () => ({ registerRegistry: () => { /* no-op */ } }));

import { buildServer } from './server.js';
import { sanitizeForwardError } from './errorSanitize.js';

const CANARIES = [
  '/Users/jonayedahamed/Maestro/secret/app.db not found',
  'TypeError: boom\n    at db (/app/src/store.ts:42:9)',
  'connect ECONNREFUSED postgres://maestro:s3cr3tPass@10.0.0.5:5432/maestro',
  'fetch https://svc:tok0123456789abcdef0123@api.internal/v1 500',
  'Bearer sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 rejected',
];

/** A host WS that replies to every forwarded `cmd` with a scripted error. */
function openErroringHost(port: number, token: string, reply: { error: string; statusCode?: number }) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const send = (o: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
  const ready = new Promise<void>((resolve) => {
    ws.on('message', (buf) => {
      let m: { type?: string; id?: string };
      try { m = JSON.parse(String(buf)) as typeof m; } catch { return; }
      if (m.type === 'hello-ok') resolve();
      else if (m.type === 'cmd' && m.id) send({ type: 'result', id: m.id, ok: false, error: reply.error, statusCode: reply.statusCode });
    });
    ws.on('open', () => send({ type: 'hello', role: 'host', deckId: `deck-${token}`, secret: 's', accessToken: token }));
  });
  return { ws, ready, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

async function postDraft(port: number, token: string): Promise<{ status: number; body: { error?: string; code?: string } }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/publish/drafts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-maestro-device-id': `d-${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'x' }),
  });
  let body: { error?: string; code?: string } = {};
  try { body = (await res.json()) as typeof body; } catch { /* not json */ }
  return { status: res.status, body };
}

describe('sanitizeForwardError — unit', () => {
  it('collapses statusCode-less and internal-500 errors to a generic 500', () => {
    for (const raw of CANARIES) {
      expect(sanitizeForwardError(new Error(raw))).toEqual({ statusCode: 500, message: 'internal error', code: 'internal' });
      expect(sanitizeForwardError(Object.assign(new Error(raw), { statusCode: 500 }))).toEqual({ statusCode: 500, message: 'internal error', code: 'internal' });
    }
  });

  it('sanitizes a typed 4xx whose message carries a canary, but keeps a safe typed message', () => {
    for (const raw of CANARIES) {
      const out = sanitizeForwardError(Object.assign(new Error(raw), { statusCode: 400 }));
      expect(out.statusCode).toBe(400);
      expect(out.message).toBe('internal error');
    }
    expect(sanitizeForwardError(Object.assign(new Error('Your Mac is offline — open the Maestro desktop app'), { statusCode: 503 })))
      .toEqual({ statusCode: 503, message: 'Your Mac is offline — open the Maestro desktop app', code: 'request_failed' });
  });
});

describe('forward() — no raw error crosses the HTTP boundary', () => {
  let app: ReturnType<typeof buildServer>;
  let port: number;
  beforeEach(async () => { app = buildServer(); await app.listen({ host: '127.0.0.1', port: 0 }); port = (app.server.address() as AddressInfo).port; });
  afterEach(async () => { await app.close(); });

  it('returns a generic 500 body for a statusCode-less host error carrying a canary', async () => {
    for (const raw of CANARIES) {
      const host = openErroringHost(port, `tk${CANARIES.indexOf(raw)}`, { error: raw }); // no statusCode → internal
      await host.ready;
      const { status, body } = await postDraft(port, `tk${CANARIES.indexOf(raw)}`);
      expect(status).toBe(500);
      expect(body.error).toBe('internal error');
      expect(body.code).toBe('internal');
      expect(JSON.stringify(body)).not.toContain('secret');
      expect(JSON.stringify(body)).not.toContain('postgres');
      expect(JSON.stringify(body)).not.toContain('sk-');
      expect(JSON.stringify(body)).not.toContain('/Users/');
      host.close();
    }
  });

  it('preserves a safe typed 4xx domain message end-to-end', async () => {
    const host = openErroringHost(port, 'tksafe', { error: 'draft not found', statusCode: 404 });
    await host.ready;
    const { status, body } = await postDraft(port, 'tksafe');
    expect(status).toBe(404);
    expect(body.error).toBe('draft not found');
    host.close();
  });
});
