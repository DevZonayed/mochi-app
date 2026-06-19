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
import type { WaChatKind, WaStoredMessage, WaMediaRef } from './wa-store.js';
import { flushSummaries } from './whatsapp-analyze.js';

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
  /** Sender JID — the group participant, or the chat itself for a DM. */
  senderId: string;
  text: string; kind: string; ts: number; isGroup: boolean;
  /** Quoted/replied-to message text, if any. */
  quotedText?: string;
  /** Media attachment descriptor (image/video/audio/document/sticker). */
  media?: WaMediaRef;
}

/** Shapes from baileys' contacts.upsert / chats.upsert / messaging-history.set
    (a subset — these events carry far more we don't need). */
type ContactRec = { id?: string; name?: string; notify?: string; verifiedName?: string };
type ChatRec = {
  id?: string; name?: string; subject?: string;
  conversationTimestamp?: Raw['messageTimestamp'];
  unreadCount?: number; pinned?: number; muteEndTime?: number;
};

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

/* eslint-disable @typescript-eslint/no-explicit-any */
/** A WhatsApp number/Long → JS number. */
function numFrom(v: any): number | undefined {
  if (v == null) return undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : undefined; }
  if (typeof v.toNumber === 'function') { try { return v.toNumber(); } catch { return undefined; } }
  if (typeof v.low === 'number') return (v.high * 4294967296) + (v.low >>> 0);
  return undefined;
}
const b64 = (v: any): string | undefined => (v ? Buffer.from(v as Uint8Array).toString('base64') : undefined);
/** Build the media descriptor (thumbnail + download keys) from a baileys media node. */
function mediaOf(mm: any, mediaType: WaMediaRef['mediaType']): WaMediaRef {
  return {
    kind: mediaType!, mediaType,
    mimetype: mm.mimetype ? String(mm.mimetype) : undefined,
    fileName: mm.fileName ? String(mm.fileName) : undefined,
    seconds: numFrom(mm.seconds),
    sizeBytes: numFrom(mm.fileLength),
    thumbBase64: b64(mm.jpegThumbnail),
    directPath: mm.directPath ? String(mm.directPath) : undefined,
    url: mm.url ? String(mm.url) : undefined,
    mediaKeyB64: b64(mm.mediaKey),
  };
}

function classify(node: Record<string, unknown> | null): { kind: string; text: string; media?: WaMediaRef } {
  if (!node) return { kind: 'system', text: '' };
  const n = node as Record<string, any>;
  if (n.conversation) return { kind: 'text', text: String(n.conversation) };
  if (n.extendedTextMessage) return { kind: 'text', text: String(n.extendedTextMessage.text || '') };
  if (n.imageMessage) return { kind: 'image', text: String(n.imageMessage.caption || ''), media: mediaOf(n.imageMessage, 'image') };
  if (n.videoMessage) return { kind: 'video', text: String(n.videoMessage.caption || ''), media: mediaOf(n.videoMessage, 'video') };
  if (n.audioMessage) return { kind: 'audio', text: '', media: mediaOf(n.audioMessage, 'audio') };
  if (n.documentMessage) return { kind: 'document', text: String(n.documentMessage.caption || ''), media: mediaOf(n.documentMessage, 'document') };
  if (n.stickerMessage) return { kind: 'sticker', text: '', media: mediaOf(n.stickerMessage, 'sticker') };
  if (n.contactMessage) return { kind: 'contact', text: String(n.contactMessage.displayName || 'Contact') };
  if (n.contactsArrayMessage) { const c = n.contactsArrayMessage; return { kind: 'contact', text: String(c.displayName || `${(c.contacts || []).length} contacts`) }; }
  if (n.locationMessage || n.liveLocationMessage) { const l = n.locationMessage || n.liveLocationMessage; return { kind: 'location', text: `${l.name ? l.name + ' ' : ''}(${l.degreesLatitude},${l.degreesLongitude})` }; }
  if (n.pollCreationMessage || n.pollCreationMessageV3) { const p = n.pollCreationMessage || n.pollCreationMessageV3; return { kind: 'poll', text: String(p.name || '') }; }
  return { kind: 'system', text: '' };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** A file extension for downloaded media (from the filename, else the mimetype). */
function extOf(mimetype: string, fileName?: string): string {
  if (fileName && fileName.includes('.')) return '.' + fileName.split('.').pop();
  const map: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'application/pdf': '.pdf' };
  const base = mimetype.split(';')[0];
  return map[base] || (base.split('/')[1] ? '.' + base.split('/')[1] : '.bin');
}

function quotedTextOf(node: Record<string, unknown> | null): string {
  if (!node) return '';
  const n = node as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const ctx = n.extendedTextMessage?.contextInfo || n.imageMessage?.contextInfo || n.videoMessage?.contextInfo || n.documentMessage?.contextInfo;
  const q = ctx?.quotedMessage;
  if (!q) return '';
  return String(q.conversation || q.extendedTextMessage?.text || (q.imageMessage ? '[image]' : '') || (q.videoMessage ? '[video]' : '') || '');
}

export function normalizeWaMessage(raw: Raw): WaNormalized | null {
  const key = raw.key || {};
  const chatId = key.remoteJid || '';
  if (!chatId) return null;
  const isGroup = chatId.endsWith('@g.us');
  const node = unwrap(raw.message);
  const { kind, text, media } = classify(node);
  const quoted = quotedTextOf(node);
  return {
    chatId,
    msgId: key.id || '',
    fromMe: !!key.fromMe,
    senderName: raw.pushName || raw.verifiedBizName || '',
    senderId: key.participant || chatId,
    text,
    kind,
    ts: toEpochSeconds(raw.messageTimestamp) * 1000,
    isGroup,
    ...(quoted ? { quotedText: quoted } : {}),
    ...(media ? { media } : {}),
  };
}

/** Human-friendly chat label from a JID when WhatsApp gives us no name. */
function prettyJid(jid: string): string {
  const user = (jid.split('@')[0] || jid).split(':')[0];
  return jid.endsWith('@s.whatsapp.net') ? `+${user}` : user;
}
/** Channel kind from a JID: groups end @g.us, channels @newsletter, else a DM. */
function kindOfJid(jid: string): WaChatKind {
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.endsWith('@newsletter')) return 'channel';
  return 'dm';
}

/** The user part of a JID, ignoring any device suffix ('1555:3@s.whatsapp.net' → '1555'). */
function userOf(jid: string): string { return (jid.split('@')[0] || '').split(':')[0]; }

/** Normalize a phone number (digits, optionally with +/spaces) to a WhatsApp JID. */
export function numberToJid(num: string): string {
  const d = (num || '').replace(/[^0-9]/g, '');
  return d ? `${d}@s.whatsapp.net` : '';
}

/** Agent send-gate: messaging any of YOUR OWN numbers (the linked account or the
    configured notify number) is always allowed; messaging anyone else requires the
    operator's opt-in (off by default — guards against an agent blasting your contacts). */
export function waSendAllowed(targetJid: string, selfJids: (string | null | undefined)[], canSendOthers: boolean): boolean {
  if (canSendOthers) return true;
  const t = userOf(targetJid);
  return selfJids.some(j => !!j && userOf(j) === t);
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
/* eslint-disable @typescript-eslint/no-explicit-any */
export type WaSendContent =
  | { text: string }
  | { image: Buffer | { url: string }; caption?: string }
  | { video: Buffer | { url: string }; caption?: string }
  | { audio: Buffer | { url: string }; mimetype?: string; ptt?: boolean }
  | { document: Buffer | { url: string }; mimetype?: string; fileName?: string; caption?: string }
  | { react: { text: string; key: any } };
export interface WaSocket {
  ev: { on(event: string, cb: (payload: any) => void): void };
  user?: { id: string; name?: string };
  sendMessage(jid: string, content: WaSendContent, options?: { quoted?: any }): Promise<any>;
  requestPairingCode?(phone: string): Promise<string>;
  /** Profile-picture URL (for chat avatars). Network call — used lazily. */
  profilePictureUrl?(jid: string, type?: 'image' | 'preview'): Promise<string | undefined>;
  /** Typing / online presence. */
  sendPresenceUpdate?(type: string, toJid?: string): Promise<void>;
  /** Mark messages read (blue ticks). */
  readMessages?(keys: any[]): Promise<void>;
  end?(err?: unknown): void;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

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
  /** jid → contact display name, learned from contacts.upsert / history sync. */
  private contacts = new Map<string, string>();

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

  /** Capture a message into the full WhatsApp store (every chat, Mac-local), keeping
      chat metadata (name, kind, preview, unread) in sync. Returns the stored message
      (null on a duplicate msgId). `live:false` = back-fill from history sync. */
  private capture(msg: WaNormalized, live: boolean): WaStoredMessage | null {
    const chatId = msg.chatId;
    // Skip protocol/unsupported frames with nothing to show — otherwise they render
    // as blank bubbles and pollute the chat's last-message preview.
    if (msg.kind === 'system' && !msg.text && !msg.media) return null;
    const kind = kindOfJid(chatId);
    const existing = this.store.waGetChat(chatId);
    // Resolve a human name: a known name wins; for a DM fall back to contact/pushName; else the JID.
    const dmName = kind === 'dm' ? (this.contacts.get(chatId) ?? (!msg.fromMe ? msg.senderName : '')) : '';
    const name = existing?.name || dmName || prettyJid(chatId);
    this.store.waUpsertChat({ chatId, name, kind });
    return this.store.waAppendMessage({
      chatId,
      msgId: msg.msgId || undefined,
      fromMe: msg.fromMe,
      senderId: msg.senderId,
      senderName: msg.fromMe ? 'You' : (msg.senderName || name),
      text: msg.text,
      kind: msg.kind,
      ts: msg.ts || Date.now(),
      ...(msg.quotedText ? { quotedText: msg.quotedText } : {}),
      ...(msg.media ? { media: msg.media } : {}),
    }, { bumpUnread: live });
  }

  /** Route one live message: capture it for the WhatsApp view (all chats), then —
      for a bound chat — (re)arm its quiet timer, or surface an unknown chat as
      pending so the operator can bind it. The own note-to-self chat is captured
      (so it shows in the view) but never pended or timed. */
  ingest(raw: Raw): void {
    const msg = normalizeWaMessage(raw);
    if (!msg) return;
    const stored = this.capture(msg, true);
    if (stored) this.emit('wa-message', { chatId: msg.chatId, message: stored, chat: this.store.waGetChat(msg.chatId) });
    const own = this.store.whatsappState().jid;
    if (own && msg.chatId === own) return; // own notes: shown, never pended/timed
    const text = displayText(msg);
    if (!text) return; // empty system/protocol frame — captured kind only
    const binding = this.store.getChatBinding(msg.chatId);
    if (binding && binding.provider === 'whatsapp') {
      this.store.armWhatsappTimer({ chatId: msg.chatId, projectId: binding.projectId, sessionId: binding.sessionId ?? undefined });
    } else {
      this.store.upsertPendingChat({ chatId: msg.chatId, name: msg.senderName || msg.chatId, kind: msg.isGroup ? 'group' : 'dm', firstText: text.slice(0, 200) });
    }
    this.emit('comms', this.store.commsStatus());
  }

  // ── chat-list + history sync (so the WhatsApp screen shows everything) ──────
  /** A history-sync batch (fired on link / reconnect): contacts, chats, messages. */
  private ingestHistory(payload: { contacts?: unknown[]; chats?: unknown[]; messages?: Raw[] }): void {
    // A history batch can carry thousands of rows — coalesce the chat-index writes.
    this.store.wa.bulk(() => {
      for (const c of payload.contacts ?? []) this.ingestContact(c as ContactRec);
      for (const c of payload.chats ?? []) this.ingestChatMeta(c as ChatRec);
      for (const raw of payload.messages ?? []) { const m = normalizeWaMessage(raw); if (m) this.capture(m, false); }
    });
    this.emit('wa-chats', null);
  }
  private ingestContact(c: ContactRec): void {
    if (!c?.id) return;
    const name = c.name || c.notify || c.verifiedName;
    if (!name) return;
    this.contacts.set(c.id, name);
    if (this.store.waGetChat(c.id)) this.store.waUpsertChat({ chatId: c.id, name });
  }
  private ingestChatMeta(c: ChatRec): void {
    if (!c?.id) return;
    const chatId = c.id;
    const existing = this.store.waGetChat(chatId);
    const name = c.name || c.subject || existing?.name || this.contacts.get(chatId) || prettyJid(chatId);
    const ts = toEpochSeconds(c.conversationTimestamp as Raw['messageTimestamp']) * 1000;
    this.store.waUpsertChat({
      chatId, name, kind: kindOfJid(chatId),
      ...(ts ? { lastMessageAt: ts } : {}),
      ...(typeof c.unreadCount === 'number' && c.unreadCount >= 0 ? { unreadCount: c.unreadCount } : {}),
      ...(c.pinned ? { pinned: true } : {}),
      ...(c.muteEndTime ? { muted: true } : {}),
    });
  }
  private ingestChats(chats: ChatRec[]): void {
    for (const c of chats ?? []) this.ingestChatMeta(c);
    if (chats?.length) this.emit('wa-chats', null);
  }
  /** A delivery-status / reaction update on an existing message. */
  private ingestMessageUpdates(updates: Array<{ key?: { remoteJid?: string; id?: string }; update?: { status?: number } }>): void {
    const touched = new Set<string>();
    for (const u of updates ?? []) {
      const chatId = u.key?.remoteJid, msgId = u.key?.id;
      if (!chatId || !msgId || typeof u.update?.status !== 'number') continue;
      const st = u.update.status;
      this.store.waUpdateMessage(chatId, msgId, { status: st >= 4 ? 'read' : st === 3 ? 'delivered' : 'sent' });
      touched.add(chatId);
    }
    for (const chatId of touched) this.emit('wa-message-update', { chatId }); // open thread refreshes its ticks
  }
  private ingestReactions(reactions: Array<{ key?: { remoteJid?: string; id?: string }; reaction?: { text?: string; key?: { fromMe?: boolean } } }>): void {
    const touched = new Set<string>();
    for (const r of reactions ?? []) {
      const chatId = r.key?.remoteJid, msgId = r.key?.id;
      if (!chatId || !msgId) continue;
      const emoji = r.reaction?.text || '';
      this.store.waUpdateMessage(chatId, msgId, { reactions: emoji ? [{ emoji, fromMe: !!r.reaction?.key?.fromMe }] : [] });
      touched.add(chatId);
    }
    for (const chatId of touched) this.emit('wa-message-update', { chatId }); // open thread re-renders reactions
  }

  /** Lazily fetch a chat's avatar (network) and cache it in the chat meta. */
  async fetchAvatar(chatId: string): Promise<string | null> {
    if (!this.sock?.profilePictureUrl) return null;
    try {
      const url = await this.sock.profilePictureUrl(chatId, 'image');
      this.store.waUpsertChat({ chatId, avatarUrl: url ?? null });
      this.emit('wa-chats', null);
      return url ?? null;
    } catch { return null; }
  }

  /** Open the socket (mock-injectable) and wire capture + lifecycle. */
  async connect(): Promise<void> {
    if (this.sock) return;
    this.wantConnected = true;
    const make = this.deps.makeSocket ?? ((authDir: string) => this.realMakeSocket(authDir));
    const sock = await make(this.authDir());
    this.sock = sock;
    const guard = (fn: () => void) => { try { fn(); } catch { /* one bad event can't stop capture */ } };
    sock.ev.on('messages.upsert', (payload: { messages?: Raw[]; type?: string }) => {
      for (const raw of payload?.messages ?? []) guard(() => this.ingest(raw));
    });
    sock.ev.on('messaging-history.set', (p: { contacts?: unknown[]; chats?: unknown[]; messages?: Raw[] }) => guard(() => this.ingestHistory(p)));
    sock.ev.on('chats.upsert', (chats: ChatRec[]) => guard(() => this.ingestChats(chats)));
    sock.ev.on('chats.update', (chats: ChatRec[]) => guard(() => this.ingestChats(chats)));
    sock.ev.on('contacts.upsert', (cs: ContactRec[]) => guard(() => { for (const c of cs ?? []) this.ingestContact(c); this.emit('wa-chats', null); }));
    sock.ev.on('contacts.update', (cs: ContactRec[]) => guard(() => { for (const c of cs ?? []) this.ingestContact(c); }));
    sock.ev.on('messages.update', (u: Array<{ key?: { remoteJid?: string; id?: string }; update?: { status?: number } }>) => guard(() => this.ingestMessageUpdates(u)));
    sock.ev.on('messages.reaction', (r: Array<{ key?: { remoteJid?: string; id?: string }; reaction?: { text?: string; key?: { fromMe?: boolean } } }>) => guard(() => this.ingestReactions(r)));
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

  /** Send a message to the operator's notify destination — their configured personal
      number if set, otherwise the linked account's own "note to self". */
  async sendToSelf(text: string): Promise<boolean> {
    const st = this.store.whatsappState();
    const jid = st.notifyJid || st.jid;
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

  /** Send a text message to any chat. Stores it locally immediately (so the UI
      shows it without waiting for the echo) and logs a comm event. The msgId from
      the send result lets the inbound echo dedupe against this stored copy. */
  async sendText(chatId: string, text: string): Promise<boolean> {
    if (!this.sock || !chatId || !text) return false;
    try {
      const res = await this.sock.sendMessage(chatId, { text }) as { key?: { id?: string } } | undefined;
      // Store locally (shows immediately) keyed on the real msgId so the inbound echo
      // dedupes. No commEvent: WhatsApp message bodies must stay Mac-local (commEvents
      // ride the relay snapshot). If there's no msgId, let the echo surface it instead
      // of storing an un-dedupable copy that would then duplicate.
      const stored = res?.key?.id ? this.store.waAppendMessage({ chatId, msgId: res.key.id, fromMe: true, senderName: 'You', text, kind: 'text', ts: Date.now(), status: 'sent' }) : null;
      if (stored) this.emit('wa-message', { chatId, message: stored, chat: this.store.waGetChat(chatId) });
      return true;
    } catch { return false; }
  }

  /** Send media (image/video/audio/document) to any chat from raw bytes. */
  async sendMedia(chatId: string, media: { kind: 'image' | 'video' | 'audio' | 'document'; data: Buffer; mimetype?: string; fileName?: string; caption?: string }): Promise<boolean> {
    if (!this.sock || !chatId) return false;
    try {
      const content: WaSendContent =
        media.kind === 'image' ? { image: media.data, caption: media.caption }
          : media.kind === 'video' ? { video: media.data, caption: media.caption }
            : media.kind === 'audio' ? { audio: media.data, mimetype: media.mimetype }
              : { document: media.data, mimetype: media.mimetype, fileName: media.fileName, caption: media.caption };
      const res = await this.sock.sendMessage(chatId, content) as { key?: { id?: string } } | undefined;
      // Mac-local only (no commEvent — see sendText). Dedupe the echo on the real msgId.
      const stored = res?.key?.id ? this.store.waAppendMessage({ chatId, msgId: res.key.id, fromMe: true, senderName: 'You', text: media.caption ?? '', kind: media.kind, ts: Date.now(), status: 'sent', media: { kind: media.kind, mimetype: media.mimetype, fileName: media.fileName } }) : null;
      if (stored) this.emit('wa-message', { chatId, message: stored, chat: this.store.waGetChat(chatId) });
      return true;
    } catch { return false; }
  }

  /** React to a message (empty emoji clears the reaction). */
  async sendReaction(chatId: string, msgId: string, emoji: string): Promise<boolean> {
    if (!this.sock || !chatId || !msgId) return false;
    const targetFromMe = this.store.waMessages(chatId, { limit: 200 }).find(m => m.msgId === msgId)?.fromMe ?? false;
    try {
      await this.sock.sendMessage(chatId, { react: { text: emoji, key: { remoteJid: chatId, id: msgId, fromMe: targetFromMe } } });
      this.store.waUpdateMessage(chatId, msgId, { reactions: emoji ? [{ emoji, fromMe: true }] : [] });
      this.emit('wa-chats', null);
      return true;
    } catch { return false; }
  }

  /** Show/clear a typing indicator in a chat. */
  async setTyping(chatId: string, on: boolean): Promise<void> {
    try { await this.sock?.sendPresenceUpdate?.(on ? 'composing' : 'paused', chatId); } catch { /* presence is best-effort */ }
  }

  /** Mark a chat read: clear the local unread badge and (if possible) send a read receipt. */
  async markRead(chatId: string): Promise<void> {
    this.store.waMarkRead(chatId);
    this.emit('wa-chats', null);
    try {
      const lastIn = this.store.waMessages(chatId, { limit: 20 }).filter(m => !m.fromMe).slice(-1)[0];
      if (lastIn?.msgId && this.sock?.readMessages) await this.sock.readMessages([{ remoteJid: chatId, id: lastIn.msgId, fromMe: false }]);
    } catch { /* read receipt is best-effort */ }
  }

  /** Download a media message's full bytes on demand (decrypt from WhatsApp's CDN
      using the stored keys), cache to disk, and return a data-URL the UI can render
      directly. Mac-local; null if the media is unavailable (e.g. an expired URL). */
  async downloadMedia(chatId: string, msgId: string): Promise<{ dataUrl: string; mimetype: string; fileName?: string } | null> {
    const m = this.store.waMessages(chatId, { limit: 5000 }).find(x => x.msgId === msgId || x.id === msgId);
    const media = m?.media;
    if (!media || !media.mediaType) return null;
    const mimetype = media.mimetype || 'application/octet-stream';
    const toDataUrl = (buf: Buffer) => `data:${mimetype};base64,${buf.toString('base64')}`;
    // Serve the cached copy if we already downloaded it.
    if (media.localPath) {
      try { const { readFile } = await import('node:fs/promises'); return { dataUrl: toDataUrl(await readFile(media.localPath)), mimetype, fileName: media.fileName }; }
      catch { /* cache gone — re-download */ }
    }
    if (!media.mediaKeyB64 || !(media.directPath || media.url)) return null;
    try {
      const baileys = await import('@whiskeysockets/baileys');
      const downloadContentFromMessage = (baileys as unknown as { downloadContentFromMessage: (m: unknown, t: string, o: unknown) => Promise<AsyncIterable<Buffer>> }).downloadContentFromMessage;
      const stream = await downloadContentFromMessage(
        { url: media.url, directPath: media.directPath, mediaKey: Buffer.from(media.mediaKeyB64, 'base64') },
        media.mediaType, {},
      );
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      const buf = Buffer.concat(chunks);
      try {
        const { mkdir, writeFile } = await import('node:fs/promises');
        const dir = join(app.getPath('userData'), 'whatsapp', ACCOUNT, 'store', 'media');
        await mkdir(dir, { recursive: true });
        const p = join(dir, `${(msgId || m!.id).replace(/[^a-zA-Z0-9._-]/g, '_')}${extOf(mimetype, media.fileName)}`);
        await writeFile(p, buf);
        this.store.waUpdateMessage(chatId, msgId, { media: { ...media, localPath: p } });
      } catch { /* caching is best-effort */ }
      return { dataUrl: toDataUrl(buf), mimetype, fileName: media.fileName };
    } catch { return null; }
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
    this.contacts.clear();
    try { this.store.wa.clear(); } catch { /* */ } // wipe captured chats/messages (keeps the store dir)
    // Remove ONLY the auth — NOT the whole `whatsapp/<account>` folder, which also
    // holds the message store dir the live WaStore writes to (deleting it made every
    // post-relink write silently fail into a gone directory).
    try { const { rm } = await import('node:fs/promises'); await rm(join(app.getPath('userData'), 'whatsapp', ACCOUNT, 'auth'), { recursive: true, force: true }); } catch { /* */ }
    this.store.setWhatsappState({ connected: false, jid: null, name: null, linkedAt: null, sendApproved: false, agentSendToOthers: false });
    this.emit('wa-chats', null);
    this.emit('comms', this.store.commsStatus());
  }

  private async onConnectionUpdate(u: { connection?: string; qr?: string; lastDisconnect?: { error?: { output?: { statusCode?: number } } } }): Promise<void> {
    if (u.qr) await this.handleQr(u.qr);
    if (u.connection === 'open') {
      this.reconnects = 0;
      const prev = this.store.whatsappState();
      this.store.setWhatsappState({ connected: true, jid: ownJidOf(this.sock) ?? prev.jid, name: this.sock?.user?.name ?? prev.name, linkedAt: prev.linkedAt ?? Date.now() });
      this.emit('comms', this.store.commsStatus());
      // Deliver any summaries queued while we were offline (e.g. a quiet-timer that
      // fired during a power-off and couldn't reach the socket yet). Retried here on
      // every (re)connect, so a missed window catches up at the next availability.
      void flushSummaries({ store: this.store, client: this, emit: this.emit });
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
    // Sync history so the WhatsApp screen can show existing chats + messages (not
    // just ones that arrive after linking). WhatsApp streams it in batches via
    // messaging-history.set; WaStore caps each chat so it stays bounded.
    const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, syncFullHistory: true, shouldSyncHistoryMessage: () => true, markOnlineOnConnect: false });
    sock.ev.on('creds.update', saveCreds);
    return sock;
  }
}
