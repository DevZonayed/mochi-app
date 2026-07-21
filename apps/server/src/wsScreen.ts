/* Screen relay WS endpoints — Phase 3D1 ephemeral, view-only.
 *
 *   /ws/host/screen    — a Mac (host) connects, authenticated by ?token= + ?did=.
 *                        It SENDS opaque binary frames and control JSON; it RECEIVES
 *                        the controller's control JSON (start/stop). No frame it
 *                        receives is ever interpreted as input.
 *   /ws/remote/screen  — a controller (phone) connects for its host (?host=), auth
 *                        ?token= + ?did=. It RECEIVES opaque binary frames + control
 *                        JSON and may SEND control JSON only. A binary message from a
 *                        controller is REJECTED — there is structurally no input path.
 *
 * Both mirror wsHost/wsRemote's synchronous-handler + early-listener + buffer-then-
 * auth shape. Frame bytes are opaque to the relay (it cannot decrypt) and never
 * persisted. Errors sent to a peer are generic. */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { userFromReq, deviceIdOf } from './authHook.js';
import { assertHostInAccount } from './accountDevices.js';
import { screenRelayHub, SCREEN_RELAY_TEARDOWN_STREAM_ID, type RelaySocket } from './screenRelay.js';

function toRelaySocket(ws: WebSocket): RelaySocket {
  return {
    send: (data, binary) => { try { ws.send(data, { binary }); } catch { /* */ } },
    bufferedAmount: () => ws.bufferedAmount,
    close: (code, reason) => { try { ws.close(code, reason); } catch { /* */ } },
  };
}

let sweepStarted = false;
function ensureSweep(): void {
  if (sweepStarted) return;
  sweepStarted = true;
  const timer = setInterval(() => { screenRelayHub.sweep(Date.now()); }, 5_000);
  // Never keep the process (or a test runner) alive on account of the sweep.
  if (typeof timer.unref === 'function') timer.unref();
}

interface Buffered { binary: boolean; data: Buffer }

export function registerScreenWs(app: FastifyInstance): void {
  ensureSweep();

  // ---- Host endpoint ------------------------------------------------------
  app.get('/ws/host/screen', { websocket: true }, (conn: unknown, req) => {
    const ws = ((conn as { socket?: WebSocket }).socket ?? conn) as WebSocket;
    const relay = toRelaySocket(ws);
    let key: string | null = null;
    const buffer: Buffered[] = [];

    function handle(b: Buffered): void {
      if (!key) return;
      if (b.binary) {
        screenRelayHub.routeFrame(key, new Uint8Array(b.data), Date.now());
      } else {
        if (b.data.length > 8 * 1024) return; // bounded control
        screenRelayHub.routeControl(key, 'host', b.data.toString('utf8'), Date.now());
      }
    }

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!key) { buffer.push({ binary: isBinary, data }); return; }
      handle({ binary: isBinary, data });
    });
    ws.on('close', () => { if (key) screenRelayHub.detachHost(key, relay, Date.now()); });

    void (async () => {
      const u = await userFromReq(req);
      const did = deviceIdOf(req);
      if (!u || !did) { try { ws.close(1008, 'unauthorized'); } catch { /* */ } return; }
      // M1: the connecting device MUST be a registered host device in this account
      // (mirrors the controller path's account binding). A spoofed/unregistered/revoked
      // host `did` is denied before it can attach to the hub. Never leaks cross-account.
      try { await assertHostInAccount(u.userId, did); } catch { try { ws.close(1008, 'host not in account'); } catch { /* */ } return; }
      key = `${u.userId}:${did}`;
      screenRelayHub.attachHost(key, did, relay, Date.now());
      for (const b of buffer) handle(b);
      buffer.length = 0;
    })();
  });

  // ---- Controller (remote) endpoint --------------------------------------
  app.get('/ws/remote/screen', { websocket: true }, (conn: unknown, req) => {
    const ws = ((conn as { socket?: WebSocket }).socket ?? conn) as WebSocket;
    const relay = toRelaySocket(ws);
    let key: string | null = null;
    let deviceId: string | null = null;
    const buffer: Buffered[] = [];

    function handle(b: Buffered): void {
      if (!key || !deviceId) return;
      // A controller may NEVER send binary — there is no remote-input path.
      if (b.binary) { try { ws.close(1008, 'input-not-permitted'); } catch { /* */ } return; }
      if (b.data.length > 8 * 1024) return;
      screenRelayHub.routeControl(key, 'controller', b.data.toString('utf8'), Date.now());
    }

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (!key) { buffer.push({ binary: isBinary, data }); return; }
      handle({ binary: isBinary, data });
    });
    ws.on('close', () => { if (key && deviceId) screenRelayHub.detachController(key, deviceId, Date.now()); });

    void (async () => {
      const u = await userFromReq(req);
      const did = deviceIdOf(req);
      const hostId = (req.query as { host?: string } | undefined)?.host;
      if (!u || !did || !hostId) { try { ws.close(1008, 'unauthorized'); } catch { /* */ } return; }
      try { await assertHostInAccount(u.userId, hostId); } catch { try { ws.close(1008, 'host not in account'); } catch { /* */ } return; }
      key = `${u.userId}:${hostId}`;
      deviceId = did;
      const attach = screenRelayHub.attachController(key, did, relay, Date.now());
      if (!attach.ok) {
        // Second viewer: tell it Busy (generic) and close; never steal the pair.
        try { ws.send(JSON.stringify({ kind: 'screen-status', v: 1, streamId: SCREEN_RELAY_TEARDOWN_STREAM_ID, status: 'busy', at: Date.now() })); } catch { /* */ }
        try { ws.close(1013, 'busy'); } catch { /* */ }
        key = null; deviceId = null;
        return;
      }
      for (const b of buffer) handle(b);
      buffer.length = 0;
    })();
  });
}
