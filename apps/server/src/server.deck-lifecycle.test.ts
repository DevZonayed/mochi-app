/* Deck lifecycle — preventing the "split-brain" failure mode.

   Symptom seen in the wild (multi-tenant relay, post #35): a phone kept showing
   infinite loading and the Mac showed "no devices", even though the Mac was
   online and the relay was healthy. Root cause: the relay never evicts an
   offline deck, and `deckByAccessToken()` returned the FIRST token match in
   insertion order. So when an operator's Mac re-registered under a NEW deckId
   while keeping the SAME pairing code (reinstall / data-dir change), the stale
   offline deck (inserted first) shadowed the live one — the phone routed to a
   dead deck while the live Mac's events fanned out to nobody.

   These tests prove:
   1. When two decks share a token, a read routes to the ONLINE deck, never a
      stale offline one (so the phone heals onto the live Mac automatically).
   2. A deck that stays offline past the eviction window is removed entirely
      (so a dead deck can never shadow a live one, and memory can't grow without
      bound). */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type AddressInfo } from 'ws';

vi.mock('./registry.js', () => ({ registerRegistry: () => { /* no-op */ } }));

import { buildServer } from './server.js';

interface HostRig {
  ws: WebSocket;
  ready: Promise<{ ok: true } | { ok: false; reason: string }>;
  send: (obj: unknown) => void;
  pushState: (state: Record<string, unknown>) => void;
  close: () => void;
}

function openHost(port: number, opts: { deckId: string; secret: string; accessToken: string }): HostRig {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const send = (obj: unknown): void => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
  const ready = new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
    ws.on('message', (buf) => {
      let m: { type?: string; reason?: string };
      try { m = JSON.parse(String(buf)) as typeof m; } catch { return; }
      if (m.type === 'hello-ok') resolve({ ok: true });
      else if (m.type === 'denied') resolve({ ok: false, reason: m.reason ?? 'denied' });
    });
    ws.on('open', () => send({ type: 'hello', role: 'host', ...opts }));
  });
  return { ws, ready, send, pushState: (state) => send({ type: 'state', state }), close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

async function fetchProjects(port: number, token: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    headers: { authorization: `Bearer ${token}`, 'x-maestro-device-id': `t-${token}` },
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

async function waitForProjects(
  port: number,
  token: string,
  predicate: (projects: { id?: string; name?: string }[]) => boolean,
  attempts = 40,
): Promise<{ id?: string; name?: string }[]> {
  for (let i = 0; i < attempts; i++) {
    const { body } = await fetchProjects(port, token);
    const projects = (body as { id?: string; name?: string }[]) ?? [];
    if (Array.isArray(projects) && predicate(projects)) return projects;
    await new Promise((r) => setTimeout(r, 20));
  }
  const final = await fetchProjects(port, token);
  throw new Error(`waitForProjects gave up: ${JSON.stringify(final)}`);
}

async function health(port: number): Promise<{ decks: number; host: { online: boolean } }> {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  return (await res.json()) as { decks: number; host: { online: boolean } };
}

describe('deck lifecycle — prefer-online routing', () => {
  let port: number;
  let app: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    app = buildServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    port = (app.server.address() as AddressInfo).port;
  });
  afterEach(async () => { await app.close(); });

  it('routes a phone to the ONLINE deck when a stale offline deck shares its token', async () => {
    // Operator's first session: pairing code CODE, deckId deck-old. It pushes
    // state, then the Mac quits (reinstall) — deck-old stays offline in the map.
    const stale = openHost(port, { deckId: 'deck-old', secret: 's1', accessToken: 'CODE' });
    await stale.ready;
    stale.pushState({ projects: [{ id: 'p-old', name: 'stale' }] });
    await waitForProjects(port, 'CODE', (ps) => ps.some((p) => p.name === 'stale'));
    stale.close();
    await new Promise((r) => setTimeout(r, 40)); // let the close → offline land

    // Second session: a NEW deckId but the SAME pairing code (code persisted).
    const live = openHost(port, { deckId: 'deck-new', secret: 's2', accessToken: 'CODE' });
    await live.ready;
    live.pushState({ projects: [{ id: 'p-new', name: 'live' }] });

    // Two decks now share token CODE; the phone must land on the LIVE one.
    const seen = await waitForProjects(port, 'CODE', (ps) => ps.some((p) => p.name === 'live'));
    expect(seen.map((p) => p.name)).toEqual(['live']);

    live.close();
  });
});

describe('deck lifecycle — eviction of long-offline decks', () => {
  it('removes a deck that stays offline past the eviction window', async () => {
    // Tiny eviction window so the test runs fast.
    const app = buildServer({ deckEvictionMs: 40, deckSweepMs: 15 });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    try {
      const h = openHost(port, { deckId: 'deck-A', secret: 's', accessToken: 'CODE-A' });
      await h.ready;
      h.pushState({ projects: [{ id: 'p1', name: 'alpha' }] });
      await waitForProjects(port, 'CODE-A', (ps) => ps.length === 1);
      expect((await health(port)).decks).toBe(1);

      h.close();
      // After offline > evictionMs and a sweep tick, the deck is gone.
      for (let i = 0; i < 50 && (await health(port)).decks > 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await health(port)).decks).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('does NOT evict a deck that is briefly offline within the window', async () => {
    // A long window: a quick disconnect must keep the snapshot (the Mac's relay
    // client reconnects with backoff up to 30s — we must not drop it).
    const app = buildServer({ deckEvictionMs: 60_000, deckSweepMs: 15 });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;
    try {
      const h = openHost(port, { deckId: 'deck-A', secret: 's', accessToken: 'CODE-A' });
      await h.ready;
      h.pushState({ projects: [{ id: 'p1', name: 'alpha' }] });
      await waitForProjects(port, 'CODE-A', (ps) => ps.length === 1);
      h.close();
      // Several sweep ticks pass, but the window is huge → deck survives, snapshot intact.
      await new Promise((r) => setTimeout(r, 120));
      expect((await health(port)).decks).toBe(1);
      const { status, body } = await fetchProjects(port, 'CODE-A');
      expect(status).toBe(200);
      expect((body as { name?: string }[]).map((p) => p.name)).toEqual(['alpha']);
    } finally {
      await app.close();
    }
  });
});
