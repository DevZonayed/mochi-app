/* WhatsApp — a real link to the operator's OWN number, owned by this Mac (a
   sibling to telegram.ts). The desktop holds one Baileys socket; incoming
   messages in tracked chats are captured to the store and (re)arm that chat's
   15-minute quiet timer. When a chat finally goes silent the cron analyzer reads
   it and sends a summary to the operator's own number ("note to self").

   Baileys is imported LAZILY inside realMakeSocket so unit tests inject a mock
   socket and never load the heavy dep or touch the network — the same strategy
   the mochi:comms plugin uses, whose provider this adapts. Auth lives under
   userData/whatsapp/<account>/auth and never enters the relay snapshot. */

import { app, powerMonitor } from 'electron';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Store } from './store.js';

const ACCOUNT = 'primary';

// ── normalize: baileys WAMessage → the fields the store needs ───────────────
// Ported from the plugin's normalize.js (envelope unwrap, media classify, Long
// timestamp coercion). Output ts is MILLISECONDS (the store's clock), not the
// plugin's epoch-seconds.

type Raw = {
  key?: { remoteJid?: string; participant?: string; fromMe?: boolean; id?: string };
  message?: Record<string, unknown> | null;
  messageTimestamp?: number | string | { low: number; high: number } | { toNumber(): number };
  pushName?: string;
  verifiedBizName?: string;
};

export interface WaNormalized {
  chatId: string; msgId: string; fromMe: boolean; senderName: string;
  text: string; kind: string; ts: number; isGroup: boolean;
}

function unwrap(message: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  let m = message as Record<string, unknown> | null | undefined;
  let guard = 0;
  while (m && guard++ < 8) {
    const wrapKey = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'deviceSentMessage', 'documentWithCaptionMessage'].find(k => m && m[k]);
    if (!wrapKey) break;
    m = (m[wrapKey] as { message?: Record<string, unknown> } | undefined)?.message ?? null;
  }
  return m ?? null;
}

function toEpochSeconds(t: Raw['messageTimestamp']): number {
  if (t == null) return 0;
  if (typeof t === 'number') return Math.floor(t);
  if (typeof t === 'string') { const n = Number(t); return Number.isFinite(n) ? Math.floor(n) : 0; }
  if (typeof t === 'object' && 'low' in t && typeof t.low === 'number') return (t.high * 4294967296) + (t.low >>> 0);
  if (typeof t === 'object' && 'toNumber' in t && typeof t.toNumber === 'function') return Math.floor(t.toNumber());
  return 0;
}

function classify(node: Record<string, unknown> | null): { kind: string; text: string } {
  if (!node) return { kind: 'system', text: '' };
  const n = node as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (n.conversation) return { kind: 'text', text: String(n.conversation) };
  if (n.extendedTextMessage) return { kind: 'text', text: String(n.extendedTextMessage.text || '') };
  if (n.imageMessage) return { kind: 'image', text: String(n.imageMessage.caption || '') };
  if (n.videoMessage) return { kind: 'video', text: String(n.videoMessage.caption || '') };
  if (n.audioMessage) return { kind: 'audio', text: '' };
  if (n.documentMessage) return { kind: 'document', text: String(n.documentMessage.caption || n.documentMessage.fileName || '') };
  if (n.locationMessage) { const l = n.locationMessage; return { kind: 'location', text: `${l.name ? l.name + ' ' : ''}(${l.degreesLatitude},${l.degreesLongitude})` }; }
  if (n.pollCreationMessage || n.pollCreationMessageV3) { const p = n.pollCreationMessage || n.pollCreationMessageV3; return { kind: 'poll', text: String(p.name || '') }; }
  return { kind: 'system', text: '' };
}

export function normalizeWaMessage(raw: Raw): WaNormalized | null {
  const key = raw.key || {};
  const chatId = key.remoteJid || '';
  if (!chatId) return null;
  const isGroup = chatId.endsWith('@g.us');
  const { kind, text } = classify(unwrap(raw.message));
  return {
    chatId,
    msgId: key.id || '',
    fromMe: !!key.fromMe,
    senderName: raw.pushName || raw.verifiedBizName || '',
    text,
    kind,
    ts: toEpochSeconds(raw.messageTimestamp) * 1000,
    isGroup,
  };
}

/** Human-readable line for the transcript: plain text, or a `[kind] caption` note
    for media. Empty system/protocol messages return '' (we don't capture them). */
export function displayText(m: WaNormalized): string {
  if (m.kind === 'text') return m.text;
  if (m.kind === 'system') return '';
  return m.text ? `[${m.kind}] ${m.text}` : `[${m.kind}]`;
}

/** The linked number's own JID with any device suffix (":3") stripped — where
    summaries are sent. '15551234567:3@s.whatsapp.net' → '15551234567@s.whatsapp.net'. */
function ownJidOf(sock: WaSocket | null): string | null {
  const id = sock?.user?.id;
  if (!id) return null;
  const at = id.indexOf('@');
  const user = (at === -1 ? id : id.slice(0, at)).split(':')[0];
  const domain = at === -1 ? 's.whatsapp.net' : id.slice(at + 1);
  return `${user}@${domain}`;
}

// ── the socket surface we depend on (a subset of baileys' WASocket) ──────────
export interface WaSocket {
  ev: { on(event: string, cb: (payload: any) => void): void }; // eslint-disable-line @typescript-eslint/no-explicit-any
  user?: { id: string; name?: string };
  sendMessage(jid: string, content: { text: string }): Promise<unknown>;
  requestPairingCode?(phone: string): Promise<string>;
  end?(err?: unknown): void;
}

export type LinkResult = { method: 'qr'; dataUrl: string } | { method: 'pairing'; code: string };

interface WaDeps {
  makeSocket?: (authDir: string) => Promise<WaSocket>;
  qrToDataUrl?: (qr: string) => Promise<string>;
}

// Permanent-failure close codes that must NOT auto-reconnect (adapted from the
// plugin): loggedOut, connectionReplaced, badSession.
const NO_RECONNECT = new Set([401, 440, 500]);
const MAX_RECONNECTS = 5;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class WhatsAppClient {
  private sock: WaSocket | null = null;
  private wantConnected = false;
  private reconnects = 0;
  private lastQr: string | null = null;
  private pendingQr: ((r: LinkResult) => void) | null = null;

  constructor(private store: Store, private emit: (name: string, data: unknown) => void, private deps: WaDeps = {}) {
    try {
      powerMonitor.on('resume', () => { if (this.wantConnected && !this.sock) void this.connect().catch(() => {}); });
      powerMonitor.on('suspend', () => { try { this.sock?.end?.(); } catch { /* */ } this.sock = null; });
    } catch { /* powerMonitor absent (tests) */ }
  }

  status() { return this.store.whatsappState(); }
  currentQr(): string | null { return this.lastQr; }

  private authDir(): string {
    const dir = join(app.getPath('userData'), 'whatsapp', ACCOUNT, 'auth');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Route one captured message: capture + (re)arm timer for a tracked chat;
      surface an unknown chat as pending so the operator can choose to track it. */
  ingest(raw: Raw): void {
    const msg = normalizeWaMessage(raw);
    if (!msg) return;
    // Ignore our own note-to-self chat — that's where summaries land, and letting
    // it echo back in would pend the self-chat (and could feed itself).
    const own = this.store.whatsappState().jid;
    if (own && msg.chatId === own) return;
    const text = displayText(msg);
    if (!text) return; // skip empty system/protocol frames
    const binding = this.store.getChatBinding(msg.chatId);
    if (!binding || binding.provider !== 'whatsapp') {
      this.store.upsertPendingChat({ chatId: msg.chatId, name: msg.senderName || msg.chatId, kind: msg.isGroup ? 'group' : 'dm', firstText: text.slice(0, 200) });
      this.emit('comms', this.store.commsStatus());
      return;
    }
    this.store.recordWaMessage({
      chatId: msg.chatId, name: binding.name, kind: binding.kind,
      fromMe: msg.fromMe, senderName: msg.fromMe ? 'You' : (msg.senderName || binding.name),
      text, ts: msg.ts || Date.now(),
    });
    this.store.armWhatsappTimer({ chatId: msg.chatId, projectId: binding.projectId, sessionId: binding.sessionId ?? undefined });
    this.emit('comms', this.store.commsStatus());
  }

  /** Open the socket (mock-injectable) and wire capture + lifecycle. */
  async connect(): Promise<void> {
    if (this.sock) return;
    this.wantConnected = true;
    const make = this.deps.makeSocket ?? ((authDir: string) => this.realMakeSocket(authDir));
    const sock = await make(this.authDir());
    this.sock = sock;
    sock.ev.on('messages.upsert', (payload: { messages?: Raw[] }) => {
      for (const raw of payload?.messages ?? []) { try { this.ingest(raw); } catch { /* one bad message can't stop capture */ } }
    });
    sock.ev.on('connection.update', (u: { connection?: string; qr?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } } }) => this.onConnectionUpdate(u));
  }

  /** Begin linking: returns a QR data-URL (default) or a pairing code (if phone
      given). The UI shows it; scanning flips the account to connected via the
      connection.update 'open' event. */
  async link(opts: { phone?: string } = {}): Promise<LinkResult> {
    await this.connect();
    if (opts.phone && this.sock?.requestPairingCode) {
      const code = await this.sock.requestPairingCode(opts.phone.replace(/[^0-9]/g, ''));
      return { method: 'pairing', code };
    }
    if (this.lastQr) return { method: 'qr', dataUrl: this.lastQr };
    return await new Promise<LinkResult>((resolve, reject) => {
      this.pendingQr = resolve;
      setTimeout(() => { if (this.pendingQr) { this.pendingQr = null; reject(Object.assign(new Error('QR not emitted in time'), { statusCode: 504 })); } }, 60_000);
    });
  }

  /** Send a message to the operator's own number (the summary destination). */
  async sendToSelf(text: string): Promise<boolean> {
    const jid = this.store.whatsappState().jid;
    if (!this.sock || !jid) return false;
    try {
      await this.sock.sendMessage(jid, { text });
      this.store.addCommEvent({ dir: 'out', chatId: jid, chatName: 'Note to Self', payload: text.slice(0, 500), status: 'sent' });
      this.emit('comms', this.store.commsStatus());
      return true;
    } catch {
      this.store.addCommEvent({ dir: 'out', chatId: jid, chatName: 'Note to Self', payload: text.slice(0, 500), status: 'failed' });
      return false;
    }
  }

  /** Reconnect on boot if a number was previously linked. */
  resumeOnBoot(): void {
    if (this.store.whatsappState().linkedAt != null) { this.wantConnected = true; void this.connect().catch(() => {}); }
  }

  /** Stop the socket but keep auth (a transient disconnect). */
  disconnect(): void {
    this.wantConnected = false;
    try { this.sock?.end?.(); } catch { /* */ }
    this.sock = null;
    this.lastQr = null;
    this.store.setWhatsappState({ connected: false });
    this.emit('comms', this.store.commsStatus());
  }

  /** Fully unlink: drop the socket, wipe auth, forget the number + send approval. */
  async unlink(): Promise<void> {
    this.disconnect();
    try { const { rm } = await import('node:fs/promises'); await rm(join(app.getPath('userData'), 'whatsapp', ACCOUNT), { recursive: true, force: true }); } catch { /* */ }
    this.store.setWhatsappState({ connected: false, jid: null, name: null, linkedAt: null, sendApproved: false });
    this.emit('comms', this.store.commsStatus());
  }

  private async onConnectionUpdate(u: { connection?: string; qr?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } } }): Promise<void> {
    if (u.qr) await this.handleQr(u.qr);
    if (u.connection === 'open') {
      this.reconnects = 0;
      const prev = this.store.whatsappState();
      this.store.setWhatsappState({ connected: true, jid: ownJidOf(this.sock) ?? prev.jid, name: this.sock?.user?.name ?? prev.name, linkedAt: prev.linkedAt ?? Date.now() });
      this.emit('comms', this.store.commsStatus());
      return;
    }
    if (u.connection === 'close') await this.onClose(u);
  }

  private async handleQr(qr: string): Promise<void> {
    const toData = this.deps.qrToDataUrl ?? (async (s: string) => {
      try { const qrcode = (await import('qrcode')).default; return await qrcode.toDataURL(s); }
      catch { return `data:text/plain;base64,${Buffer.from(s).toString('base64')}`; }
    });
    this.lastQr = await toData(qr);
    this.emit('whatsapp-qr', { dataUrl: this.lastQr });
    if (this.pendingQr) { const resolve = this.pendingQr; this.pendingQr = null; resolve({ method: 'qr', dataUrl: this.lastQr }); }
  }

  private async onClose(u: { lastDisconnect?: { error?: { output?: { statusCode?: number } } } }): Promise<void> {
    this.sock = null;
    const code = u.lastDisconnect?.error?.output?.statusCode ?? null;
    if (code === 401) { await this.unlink(); return; }                  // logged out → forget
    this.store.setWhatsappState({ connected: false });
    this.emit('comms', this.store.commsStatus());
    if (!this.wantConnected || (code != null && NO_RECONNECT.has(code))) return;
    if (++this.reconnects > MAX_RECONNECTS) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (this.reconnects - 1), RECONNECT_MAX_MS);
    await new Promise(r => setTimeout(r, delay));
    if (this.wantConnected && !this.sock) await this.connect().catch(() => {});
  }

  /** Real baileys socket — lazily imported so tests never load it. */
  private async realMakeSocket(authDir: string): Promise<WaSocket> {
    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = (baileys as unknown as { default: (cfg: unknown) => WaSocket; makeWASocket?: (cfg: unknown) => WaSocket }).default
      ?? (baileys as unknown as { makeWASocket: (cfg: unknown) => WaSocket }).makeWASocket;
    const { useMultiFileAuthState, fetchLatestBaileysVersion } = baileys as unknown as {
      useMultiFileAuthState(dir: string): Promise<{ state: unknown; saveCreds: () => Promise<void> }>;
      fetchLatestBaileysVersion(): Promise<{ version: number[] }>;
    };
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version } = await fetchLatestBaileysVersion();
    const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, syncFullHistory: false, shouldSyncHistoryMessage: () => false });
    sock.ev.on('creds.update', saveCreds);
    return sock;
  }
}
