/* HostClient.pushSnapshot throttle contract — the root cause of the 0.1.19
   39-minute V8 OOM crash. emit() in main.ts calls host?.pushSnapshot() on
   every non-live event; during a streaming chat that fires once per second.
   Each snapshot is ~70 MB of JSON for a heavy user (200 jobs with trimmed
   transcripts), and worse, the old code built that snapshot EVEN WHEN THE
   WS WAS CLOSED. Throttling + short-circuit makes the per-event call safe.

   Strategy: don't mock the 'ws' module — just inject a fake WebSocket into
   the private `ws` field. Avoids hoist-order issues and tests the EXACT
   pushSnapshot path. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HostClient } from './hostClient.js';

const OPEN = 1;
const CLOSED = 3;

interface FakeWS { readyState: number; send: (s: string) => void; sent: string[] }
const makeWS = (state = OPEN): FakeWS => ({
  readyState: state, sent: [],
  send(s: string) { this.sent.push(s); },
});

interface ClientInternals { ws: FakeWS | null; lastSnapshotAt: number; snapshotTrailer: ReturnType<typeof setTimeout> | null }

describe('HostClient.pushSnapshot throttle (root cause of 0.1.19 V8 OOM)', () => {
  let client: HostClient;
  let internals: ClientInternals;
  let snapshotBuilds: number;

  beforeEach(() => {
    vi.useFakeTimers();
    snapshotBuilds = 0;
    client = new HostClient({
      url: 'wss://example.test',
      sessionToken: 'tok',
      deviceId: 'dev',
      name: 'Mac',
      deckId: 'deck',
      getSnapshot: () => { snapshotBuilds++; return { jobs: [] }; },
      onCommand: async () => ({}),
    });
    // Inject a fake OPEN WS directly. We deliberately do NOT call start() so
    // no real WS is created.
    internals = client as unknown as ClientInternals;
    internals.ws = makeWS(OPEN);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does NOT build the snapshot when WS is not OPEN (the call site does not know)', () => {
    internals.ws!.readyState = CLOSED;
    client.pushSnapshot();
    client.pushSnapshot();
    client.pushSnapshot();
    expect(snapshotBuilds).toBe(0); // critical: don't pay the JSON cost for nothing
  });

  it('collapses a burst of pushes into ONE immediate + ONE trailer', () => {
    // 100 emit-driven pushes in rapid succession (simulates 100 events during
    // streaming, which is the realistic case the old code crashed on).
    for (let i = 0; i < 100; i++) client.pushSnapshot();
    expect(snapshotBuilds).toBe(1); // only the first fires immediately
    vi.advanceTimersByTime(5000);   // trailer fires once after the window
    expect(snapshotBuilds).toBe(2);
  });

  it('allows a new push after the throttle window elapses', () => {
    client.pushSnapshot();
    expect(snapshotBuilds).toBe(1);
    vi.advanceTimersByTime(5100);
    client.pushSnapshot();
    expect(snapshotBuilds).toBe(2);
  });
});
