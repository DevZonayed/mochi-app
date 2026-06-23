/* Host WS (/ws/host) — a Mac connects here, authenticated by its account session
   (?token=) and identifying itself (?did=). On hello it registers as a host; then
   it streams its snapshot + events up and receives forwarded commands + signals.

   The handler is SYNCHRONOUS and attaches the message listener immediately, then
   authenticates and drains buffered messages — otherwise a `hello` sent right after
   the socket opens is dropped while the (async) auth is still resolving. */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { userFromReq, deviceIdOf } from './authHook.js';
import { upsertDevice } from './accountDevices.js';
import { markOnline, markOffline, setSnapshot, subscribe } from './redis.js';
import { submitResult, publishEvent } from './routing.js';
import { routeSignal } from './webrtc.js';
import { maybePush } from './push.js';

interface HostMsg {
  type?: string; deckId?: string; name?: string; platform?: string;
  state?: unknown; eventName?: string; data?: unknown;
  cmdId?: string; ok?: boolean; result?: unknown; error?: string; statusCode?: number;
  toDeviceId?: string; signal?: unknown;
}

export function registerHostWs(app: FastifyInstance): void {
  app.get('/ws/host', { websocket: true }, (conn: unknown, req) => {
    const ws = ((conn as { socket?: WebSocket }).socket ?? conn) as WebSocket;
    let userId: string | null = null;
    let deviceId: string | null = null;
    let unsubCmd: (() => void) | null = null;
    let unsubSignal: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const buffer: HostMsg[] = [];

    async function onHello(m: HostMsg): Promise<void> {
      const id = deviceId as string;
      await upsertDevice({ id, userId: userId as string, role: 'host', name: m.name || 'Mac', platform: m.platform || 'macos', deckId: m.deckId ?? null });
      await markOnline(id);
      unsubCmd = subscribe(`cmd:host:${id}`, (raw) => {
        const c = raw as { cmdId: string; method: string; params: unknown };
        try { ws.send(JSON.stringify({ type: 'cmd', cmdId: c.cmdId, method: c.method, params: c.params })); } catch { /* */ }
      });
      unsubSignal = subscribe(`signal:device:${id}`, (raw) => {
        const s = raw as { fromDeviceId: string; signal: unknown };
        try { ws.send(JSON.stringify({ type: 'signal', fromDeviceId: s.fromDeviceId, signal: s.signal })); } catch { /* */ }
      });
      heartbeat = setInterval(() => { void markOnline(id); }, 20000);
      try { ws.send(JSON.stringify({ type: 'hello-ok' })); } catch { /* */ }
    }

    function handle(m: HostMsg): void {
      const id = deviceId as string;
      if (m.type === 'hello') { void onHello(m); return; }
      if (m.type === 'state') { void setSnapshot(id, m.state); void markOnline(id); return; }
      if (m.type === 'event' && m.eventName) {
        publishEvent(id, m.eventName, m.data);
        // Mirror alert-worthy events (job:done/failed, approval, schedule-late)
        // into Expo push so a CLOSED phone gets an OS notification — SSE only
        // reaches a running app. Best-effort; never blocks the WS handler.
        void maybePush(userId as string, id, m.eventName, m.data).catch(() => { /* push is best-effort */ });
        return;
      }
      if (m.type === 'result' && m.cmdId) { submitResult(m.cmdId, !!m.ok, m.result, m.error, m.statusCode); return; }
      if (m.type === 'signal' && m.toDeviceId) { void routeSignal(userId as string, id, m.toDeviceId, m.signal).catch(() => { /* not in account */ }); return; }
      if (m.type === 'pong') { void markOnline(id); return; }
    }

    ws.on('message', (buf: Buffer | string) => {
      let m: HostMsg; try { m = JSON.parse(String(buf)) as HostMsg; } catch { return; }
      if (!userId) { buffer.push(m); return; }
      handle(m);
    });
    ws.on('close', () => {
      if (heartbeat) clearInterval(heartbeat);
      unsubCmd?.();
      unsubSignal?.();
      if (deviceId) void markOffline(deviceId);
    });

    void (async () => {
      const u = await userFromReq(req);
      const did = deviceIdOf(req);
      if (!u || !did) { try { ws.close(1008, 'unauthorized'); } catch { /* */ } return; }
      userId = u.userId; deviceId = did;
      for (const m of buffer) handle(m);
      buffer.length = 0;
    })();
  });
}
