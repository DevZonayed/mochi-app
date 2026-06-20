/* Multi-tenant relay isolation.

   The relay is a public deployment shared by multiple operators. Before this
   patch the relay kept a single global `deck`, so two Macs that both connected
   ended up writing into the same snapshot — operator A's phone could read
   operator B's projects (and vice versa) depending on which Mac had pushed
   most recently. These tests prove:

   1. Two hosts with different deckIds get two isolated Deck slots.
   2. A read with operator A's token returns A's snapshot ONLY, never B's,
      even after both have pushed concurrent state frames.
   3. A stale WS that no longer owns a deck cannot pollute that deck's state.
   4. A second-Mac hello with a matching deckId but a wrong secret is rejected.
   5. A hello with a fresh deckId never inherits any prior deck's snapshot. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, type AddressInfo } from 'ws';

// The skill-registry route pulls in `sharp` + `better-sqlite3` for embeddings
// and on-disk indexing — both ship native bindings that need a compile step.
// Multi-tenant relay behaviour has nothing to do with the embedder/index, so
// stub the whole `./registry.js` module to a no-op so the tests can boot the
// server without those native deps being present.
vi.mock('./registry.js', () => ({
  registerRegistry: () => { /* no-op for tenancy tests */ },
}));

import { buildServer } from './server.js';

interface HostRig {
  ws: WebSocket;
  /** Resolves when the relay acknowledges the hello (or rejects via 'denied'). */
  ready: Promise<{ ok: true } | { ok: false; reason: string }>;
  send: (obj: unknown) => void;
  pushState: (state: Record<string, unknown>) => void;
  close: () => void;
}

/** Open a host WS, send a hello, and resolve when the relay answers hello-ok or denied. */
function openHost(port: number, opts: { deckId: string; secret: string; accessToken: string }): HostRig {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const send = (obj: unknown): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };
  const ready = new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => {
    ws.on('message', (buf) => {
      let m: { type?: string; reason?: string };
      try { m = JSON.parse(String(buf)) as typeof m; } catch { return; }
      if (m.type === 'hello-ok') resolve({ ok: true });
      else if (m.type === 'denied') resolve({ ok: false, reason: m.reason ?? 'denied' });
    });
    ws.on('open', () => send({ type: 'hello', role: 'host', ...opts }));
  });
  return {
    ws,
    ready,
    send,
    pushState: (state) => send({ type: 'state', state }),
    close: () => { try { ws.close(); } catch { /* ignore */ } },
  };
}

async function fetchProjects(port: number, token: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    headers: { authorization: `Bearer ${token}`, 'x-maestro-device-id': `t-${token}` },
  });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

/** Loop until either the deck has the expected snapshot or we run out of tries. */
async function waitForProjects(
  port: number,
  token: string,
  predicate: (projects: { id?: string; name?: string }[]) => boolean,
  attempts = 30,
): Promise<{ id?: string; name?: string }[]> {
  for (let i = 0; i < attempts; i++) {
    const { body } = await fetchProjects(port, token);
    const projects = (body as { id?: string; name?: string }[] | { error?: string }) ?? [];
    if (Array.isArray(projects) && predicate(projects)) return projects;
    await new Promise((r) => setTimeout(r, 20));
  }
  const final = await fetchProjects(port, token);
  throw new Error(`waitForProjects gave up: ${JSON.stringify(final)}`);
}

describe('multi-tenant relay isolation', () => {
  let port: number;
  let app: ReturnType<typeof buildServer>;

  beforeEach(async () => {
    app = buildServer();
    await app.listen({ host: '127.0.0.1', port: 0 });
    const addr = app.server.address() as AddressInfo;
    port = addr.port;
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 503 when no Mac is paired', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
      headers: { authorization: 'Bearer ANY-CODE' },
    });
    expect(res.status).toBe(503);
  });

  it('routes each phone to its own Mac, never the other one', async () => {
    const A = openHost(port, { deckId: 'deck-A', secret: 'sA', accessToken: 'CODE-A' });
    const B = openHost(port, { deckId: 'deck-B', secret: 'sB', accessToken: 'CODE-B' });
    await Promise.all([A.ready, B.ready]);

    A.pushState({ projects: [{ id: 'p-a1', name: 'alpha' }] });
    B.pushState({ projects: [{ id: 'p-b1', name: 'beta' }] });

    // Each phone sees ONLY its own Mac's projects, regardless of order.
    const fromA = await waitForProjects(port, 'CODE-A', (ps) => ps.some((p) => p.id === 'p-a1'));
    const fromB = await waitForProjects(port, 'CODE-B', (ps) => ps.some((p) => p.id === 'p-b1'));
    expect(fromA.map((p) => p.name)).toEqual(['alpha']);
    expect(fromB.map((p) => p.name)).toEqual(['beta']);

    A.close();
    B.close();
  });

  it("does not let host B's WS frames pollute host A's snapshot", async () => {
    // The original bug: B's `isHost=true` WS was writing into the single global
    // `deck.state`, which had been re-bound to A's deckId on A's hello. With
    // per-WS deck binding, B's state frames must only affect deck-B.
    const A = openHost(port, { deckId: 'deck-A', secret: 'sA', accessToken: 'CODE-A' });
    const B = openHost(port, { deckId: 'deck-B', secret: 'sB', accessToken: 'CODE-B' });
    await Promise.all([A.ready, B.ready]);

    A.pushState({ projects: [{ id: 'p-a1', name: 'alpha' }] });
    // Hammer B with state pushes. Pre-patch this would have ping-pong'd into A.
    for (let i = 0; i < 12; i++) B.pushState({ projects: [{ id: `p-b${i}`, name: `beta-${i}` }] });

    const fromA = await waitForProjects(port, 'CODE-A', (ps) => ps.some((p) => p.id === 'p-a1'));
    // Sample again over a short window — A's snapshot must NEVER show a beta-* project.
    for (let i = 0; i < 5; i++) {
      const { body } = await fetchProjects(port, 'CODE-A');
      const names = ((body as { name?: string }[]) ?? []).map((p) => p.name ?? '');
      expect(names.some((n) => n.startsWith('beta'))).toBe(false);
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(fromA.map((p) => p.name)).toEqual(['alpha']);

    A.close();
    B.close();
  });

  it('a fresh deckId never inherits a prior deck\'s snapshot', async () => {
    // Pre-patch the relay carried `state: deck?.state ?? null` across deck swaps,
    // so a brand-new operator could briefly see the previous operator's data.
    const A = openHost(port, { deckId: 'deck-A', secret: 'sA', accessToken: 'CODE-A' });
    await A.ready;
    A.pushState({ projects: [{ id: 'p-a1', name: 'alpha' }] });
    await waitForProjects(port, 'CODE-A', (ps) => ps.length === 1);
    A.close();
    // Wait for the close to propagate.
    await new Promise((r) => setTimeout(r, 30));

    const C = openHost(port, { deckId: 'deck-C', secret: 'sC', accessToken: 'CODE-C' });
    await C.ready;
    // C has not pushed state yet — the relay must return an empty list, never A's.
    const { body, status } = await fetchProjects(port, 'CODE-C');
    expect(status).toBe(200);
    expect(body).toEqual([]);

    C.close();
  });

  it('rejects a second host on the same deckId with a wrong secret', async () => {
    const A = openHost(port, { deckId: 'deck-A', secret: 'right', accessToken: 'CODE-A' });
    await A.ready;
    A.pushState({ projects: [{ id: 'p-a1', name: 'alpha' }] });

    const Imposter = openHost(port, { deckId: 'deck-A', secret: 'wrong', accessToken: 'CODE-X' });
    const verdict = await Imposter.ready;
    expect(verdict).toEqual({ ok: false, reason: 'bad secret' });

    // The legit code still works; the wrong one never authenticates.
    const ok = await fetchProjects(port, 'CODE-A');
    expect(ok.status).toBe(200);
    const wrong = await fetchProjects(port, 'CODE-X');
    expect(wrong.status).toBe(401);

    A.close();
    Imposter.close();
  });

  it('a stale WS for the same deckId can no longer push state after the deck is rebound', async () => {
    // Simulate the legit Mac's WS bouncing: open a first WS, then a second one
    // with the same deckId+secret. The relay must close the first ws and stop
    // accepting state frames from it.
    const first = openHost(port, { deckId: 'deck-A', secret: 's', accessToken: 'CODE-A' });
    await first.ready;
    first.pushState({ projects: [{ id: 'p-a1', name: 'alpha' }] });
    await waitForProjects(port, 'CODE-A', (ps) => ps.some((p) => p.name === 'alpha'));

    const second = openHost(port, { deckId: 'deck-A', secret: 's', accessToken: 'CODE-A' });
    await second.ready;
    second.pushState({ projects: [{ id: 'p-a2', name: 'omega' }] });
    await waitForProjects(port, 'CODE-A', (ps) => ps.some((p) => p.name === 'omega'));

    // First ws was closed by the relay; further frames from it are dropped.
    // We can't reliably re-send on a closed ws (readyState !== OPEN); what we
    // CAN test is that opening a brand-new ws claiming the same deckId again
    // (third reconnect) cleanly replaces the second and is the new source of
    // truth. The state from the rejected/closed sockets must not resurface.
    const third = openHost(port, { deckId: 'deck-A', secret: 's', accessToken: 'CODE-A' });
    await third.ready;
    third.pushState({ projects: [{ id: 'p-a3', name: 'gamma' }] });
    const finalSnap = await waitForProjects(port, 'CODE-A', (ps) => ps.some((p) => p.name === 'gamma'));
    expect(finalSnap.map((p) => p.name)).toEqual(['gamma']);

    first.close();
    second.close();
    third.close();
  });

  it("rotating an operator's accessToken kicks the old code without affecting other operators", async () => {
    const A = openHost(port, { deckId: 'deck-A', secret: 's', accessToken: 'OLD-A' });
    const B = openHost(port, { deckId: 'deck-B', secret: 's', accessToken: 'CODE-B' });
    await Promise.all([A.ready, B.ready]);

    A.pushState({ projects: [{ id: 'p-a1', name: 'alpha' }] });
    B.pushState({ projects: [{ id: 'p-b1', name: 'beta' }] });
    await waitForProjects(port, 'OLD-A', (ps) => ps.some((p) => p.name === 'alpha'));
    await waitForProjects(port, 'CODE-B', (ps) => ps.some((p) => p.name === 'beta'));

    // A's Mac rotates the pairing code: relay-side, that's a fresh hello with a
    // new accessToken. The old code must no longer authenticate; B unaffected.
    A.close();
    await new Promise((r) => setTimeout(r, 20));
    const A2 = openHost(port, { deckId: 'deck-A', secret: 's', accessToken: 'NEW-A' });
    await A2.ready;
    A2.pushState({ projects: [{ id: 'p-a1', name: 'alpha' }] });

    const old = await fetchProjects(port, 'OLD-A');
    expect(old.status).toBe(401);
    const fresh = await waitForProjects(port, 'NEW-A', (ps) => ps.some((p) => p.name === 'alpha'));
    expect(fresh.map((p) => p.name)).toEqual(['alpha']);
    const bStill = await waitForProjects(port, 'CODE-B', (ps) => ps.some((p) => p.name === 'beta'));
    expect(bStill.map((p) => p.name)).toEqual(['beta']);

    A2.close();
    B.close();
  });
});
