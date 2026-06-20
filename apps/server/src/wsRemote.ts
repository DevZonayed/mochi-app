/* Remote WS (/ws/remote) — a phone/web connects here for its ACTIVE host
   (?host=<hostId>), authenticated by its account session (?token=, ?did=). It
   receives that host's snapshot + live events, plus WebRTC signals aimed at it.

   Synchronous handler + early message listener (see wsHost.ts for the rationale). */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { userFromReq, deviceIdOf } from './authHook.js';
import { assertHostInAccount, upsertDevice } from './accountDevices.js';
import { markOnline, markOffline, getSnapshot, subscribe } from './redis.js';
import { routeSignal } from './webrtc.js';

interface RemoteMsg { type?: string; toDeviceId?: string; signal?: unknown; }

export function registerRemoteWs(app: FastifyInstance): void {
  app.get('/ws/remote', { websocket: true }, (conn: unknown, req) => {
    const ws = ((conn as { socket?: WebSocket }).socket ?? conn) as WebSocket;
    let userId: string | null = null;
    let deviceId: string | null = null;
    let unsubEvents: (() => void) | null = null;
    let unsubSignal: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const buffer: RemoteMsg[] = [];

    function handle(m: RemoteMsg): void {
      if (m.type === 'signal' && m.toDeviceId) {
        void routeSignal(userId as string, deviceId as string, m.toDeviceId, m.signal).catch(() => { /* not in account */ });
      }
    }

    ws.on('message', (buf: Buffer | string) => {
      let m: RemoteMsg; try { m = JSON.parse(String(buf)) as RemoteMsg; } catch { return; }
      if (!userId) { buffer.push(m); return; }
      handle(m);
    });
    ws.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      unsubEvents?.();
      unsubSignal?.();
      if (deviceId) void markOffline(deviceId);
    });

    void (async () => {
      const u = await userFromReq(req);
      const did = deviceIdOf(req);
      const hostId = (req.query as { host?: string } | undefined)?.host;
      if (!u || !did || !hostId) { try { ws.close(1008, 'unauthorized'); } catch { /* */ } return; }
      try { await assertHostInAccount(u.userId, hostId); } catch { try { ws.close(1008, 'host not in account'); } catch { /* */ } return; }

      userId = u.userId; deviceId = did;
      const q = req.query as { name?: string; platform?: string } | undefined;
      await upsertDevice({ id: did, userId: u.userId, role: 'remote', name: q?.name || 'Remote', platform: q?.platform || 'web' });
      await markOnline(did);

      // Subscribe BEFORE hello so an event fired right after connect isn't missed.
      unsubEvents = subscribe(`events:host:${hostId}`, (raw) => {
        const e = raw as { name: string; data: unknown };
        try { ws.send(JSON.stringify({ type: 'event', name: e.name, data: e.data })); } catch { /* */ }
      });
      unsubSignal = subscribe(`signal:device:${did}`, (raw) => {
        const s = raw as { fromDeviceId: string; signal: unknown };
        try { ws.send(JSON.stringify({ type: 'signal', fromDeviceId: s.fromDeviceId, signal: s.signal })); } catch { /* */ }
      });
      heartbeat = setInterval(() => { void markOnline(did); }, 20000);

      const snap = await getSnapshot(hostId);
      try { ws.send(JSON.stringify({ type: 'hello', hostId, snapshot: snap })); } catch { /* */ }

      for (const m of buffer) handle(m);
      buffer.length = 0;
    })();
  });
}
