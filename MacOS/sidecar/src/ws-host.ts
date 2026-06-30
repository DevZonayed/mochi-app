// Minimal, dependency-free RFC6455 WebSocket server. Keeps the sidecar zero-dependency for
// the P0 foundation (robust regardless of node_modules install state, and smaller). The wire
// protocol mirrors the old Electron IPC exactly:
//   →  {"t":"call","id":N,"method":"…","params":{…}}
//   ←  {"t":"res","id":N,"ok":true,"data":…}  /  {"ok":false,"error":"…","status":N}
//   ←  {"t":"event","name":"…","data":…}
// Loopback only, token-gated via the `x-maestro-token` upgrade header.

import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

type Dispatch = (method: string, params: Record<string, unknown>) => unknown | Promise<unknown>;

export interface WsHost {
  port: number;
  token: string;
  emit(name: string, data: unknown): void;
  close(): void;
}

interface Frame { fin: boolean; opcode: number; payload: Buffer; rest: Buffer; }

function decodeFrame(buf: Buffer): Frame | null {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) { if (buf.length < off + 2) return null; len = buf.readUInt16BE(off); off += 2; }
  else if (len === 127) { if (buf.length < off + 8) return null; len = Number(buf.readBigUInt64BE(off)); off += 8; }
  let mask: Buffer | null = null;
  if (masked) { if (buf.length < off + 4) return null; mask = buf.subarray(off, off + 4); off += 4; }
  if (buf.length < off + len) return null;
  let payload = buf.subarray(off, off + len);
  if (mask) {
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    payload = out;
  }
  return { fin, opcode, payload: Buffer.from(payload), rest: buf.subarray(off + len) };
}

function encodeFrame(payload: Buffer, opcode: number): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) header = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { header = Buffer.allocUnsafe(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.allocUnsafe(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

/** Optional plain-HTTP handler (e.g. the design-preview route). Returns true if it wrote a response. */
type HttpHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<boolean>;

export function startWsHost(dispatch: Dispatch, httpHandler?: HttpHandler): Promise<WsHost> {
  const token = randomBytes(24).toString('hex');
  const clients = new Set<Socket>();

  const server = createServer((req, res) => {
    void (async () => {
      try { if (httpHandler && await httpHandler(req, res)) return; } catch { /* fall through */ }
      res.writeHead(426); res.end('upgrade required');
    })();
  });

  server.on('upgrade', (req, socket: Socket) => {
    const key = req.headers['sec-websocket-key'] as string | undefined;
    const headerToken = req.headers['x-maestro-token'];
    let queryToken: string | null = null;
    try { queryToken = new URL(req.url ?? '', 'http://127.0.0.1').searchParams.get('token'); } catch { /* noop */ }
    if (!key || (headerToken !== token && queryToken !== token)) { socket.destroy(); return; }
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    clients.add(socket);
    attach(socket);
  });

  function attach(socket: Socket) {
    let buf = Buffer.alloc(0);
    let fragOpcode = 0;
    let fragChunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      let frame: Frame | null;
      while ((frame = decodeFrame(buf))) {
        buf = frame.rest;
        const { fin, opcode, payload } = frame;
        if (opcode === 0x8) { try { socket.end(); } catch { /* noop */ } return; }
        if (opcode === 0x9) { try { socket.write(encodeFrame(payload, 0xA)); } catch { /* noop */ } continue; }
        if (opcode === 0xA) continue; // pong
        if (opcode === 0x0) { // continuation
          fragChunks.push(payload);
          if (fin) { const full = Buffer.concat(fragChunks); fragChunks = []; deliver(socket, fragOpcode, full); }
          continue;
        }
        // text(0x1)/binary(0x2)
        if (!fin) { fragOpcode = opcode; fragChunks = [payload]; continue; }
        deliver(socket, opcode, payload);
      }
    });
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
  }

  function deliver(socket: Socket, _opcode: number, payload: Buffer) {
    void handleMessage(socket, payload.toString('utf8'));
  }

  async function handleMessage(socket: Socket, text: string) {
    let msg: { t?: string; id?: number; method?: string; params?: Record<string, unknown> };
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.t !== 'call' || typeof msg.method !== 'string') return;
    const id = msg.id;
    try {
      const data = await dispatch(msg.method, msg.params ?? {});
      send(socket, { t: 'res', id, ok: true, data });
    } catch (e) {
      const err = e as { message?: string; statusCode?: number };
      send(socket, { t: 'res', id, ok: false, error: err?.message ?? 'error', status: err?.statusCode ?? 500 });
    }
  }

  function send(socket: Socket, obj: unknown) {
    try { socket.write(encodeFrame(Buffer.from(JSON.stringify(obj)), 0x1)); } catch { /* noop */ }
  }

  function emit(name: string, data: unknown) {
    const frame = encodeFrame(Buffer.from(JSON.stringify({ t: 'event', name, data })), 0x1);
    for (const c of clients) { try { c.write(frame); } catch { /* noop */ } }
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, token, emit, close: () => { for (const c of clients) c.destroy(); server.close(); } });
    });
  });
}
