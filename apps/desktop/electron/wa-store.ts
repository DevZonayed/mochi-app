/* WaStore — the desktop's full WhatsApp chat + message store.

   Chat metadata lives in chats.json (small, kept in memory); each chat's messages
   live in an append-only JSONL log at messages/<safeId>.jsonl, bounded by a cap and
   compacted in place when it grows past it. This is the single source of truth
   behind the WhatsApp screen, the agent's wa_* tools, and the quiet-timer
   summarizer. Mac-local; never enters the relay snapshot.

   Why JSONL and not the monolithic maestro-store.json: capturing EVERY chat's
   history (not just bound ones) would bloat a file that is loaded and rewritten
   wholesale on every change. Per-chat append-only logs keep writes O(1). */

import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';

export type WaChatKind = 'dm' | 'group' | 'channel';

export interface WaChatMeta {
  chatId: string;
  name: string;
  kind: WaChatKind;
  avatarUrl?: string | null;
  lastMessageAt: number;
  lastMessageText: string;
  lastMessageFromMe: boolean;
  unreadCount: number;
  pinned?: boolean;
  muted?: boolean;
  /** Whether the JID is a known address-book contact (vs an unknown number). */
  isContact?: boolean;
  /** Quiet-timer watermark: ts of the newest message already folded into a summary. */
  lastReportedAt: number;
}

export interface WaReaction { emoji: string; fromMe: boolean }
/** A media attachment: a small inline thumbnail (shown immediately) + the descriptor
    needed to download the full bytes on demand. */
export interface WaMediaRef {
  kind: string;                 // image | video | audio | document | sticker
  mimetype?: string;
  fileName?: string;
  seconds?: number;             // audio/video duration
  sizeBytes?: number;
  /** base64 JPEG preview from WhatsApp (no download needed). */
  thumbBase64?: string;
  // ── on-demand full download (Baileys downloadContentFromMessage) ──
  mediaType?: string;           // baileys content type (image|video|audio|document|sticker)
  directPath?: string;
  url?: string;
  mediaKeyB64?: string;
  /** Cached path once the full media has been downloaded. */
  localPath?: string;
}

export interface WaStoredMessage {
  id: string;
  /** WhatsApp's own message id — used for dedupe, reactions and replies. */
  msgId?: string;
  chatId: string;
  fromMe: boolean;
  senderId?: string;
  senderName: string;
  text: string;
  kind: string;
  ts: number;
  quotedText?: string;
  reactions?: WaReaction[];
  media?: WaMediaRef;
  status?: 'sent' | 'delivered' | 'read';
}

export type WaMessageInput = Omit<WaStoredMessage, 'id' | 'kind'> & { id?: string; kind?: string };

export interface WaStoreOpts {
  /** Target messages kept per chat on disk. */
  msgCap?: number;
  /** Slack above msgCap before a compaction rewrite fires (amortizes writes). */
  compactMargin?: number;
}

const DEFAULT_MSG_CAP = 5000;
const DEFAULT_COMPACT_MARGIN = 500;

export class WaStore {
  private chatsFile: string;
  private msgDir: string;
  private chats = new Map<string, WaChatMeta>();
  private seen = new Map<string, Set<string>>(); // chatId → seen msgIds (lazy)
  private counts = new Map<string, number>();     // chatId → on-disk line count (lazy)
  private msgCap: number;
  private compactMargin: number;
  private deferSave = false; // during bulk(): coalesce chats.json writes
  private chatsDirty = false;

  constructor(baseDir: string, opts: WaStoreOpts = {}) {
    this.msgCap = opts.msgCap ?? DEFAULT_MSG_CAP;
    this.compactMargin = opts.compactMargin ?? DEFAULT_COMPACT_MARGIN;
    this.chatsFile = join(baseDir, 'chats.json');
    this.msgDir = join(baseDir, 'messages');
    mkdirSync(this.msgDir, { recursive: true });
    this.loadChats();
  }

  // ── chat metadata (in memory, mirrored to chats.json) ───────────────────
  private loadChats(): void {
    try {
      const raw = JSON.parse(readFileSync(this.chatsFile, 'utf8')) as Record<string, WaChatMeta>;
      for (const [k, v] of Object.entries(raw)) this.chats.set(k, v);
    } catch { /* first run / corrupt — start empty */ }
  }
  /** Recreate the store dir before a write — self-heals if it was deleted out from
      under us (e.g. an unlink rm -rf), so writes never silently vanish into a gone dir. */
  private ensureDir(): void { try { mkdirSync(this.msgDir, { recursive: true }); } catch { /* */ } }

  private saveChats(): void {
    if (this.deferSave) { this.chatsDirty = true; return; } // flushed once by bulk()
    const obj: Record<string, WaChatMeta> = {};
    for (const [k, v] of this.chats) obj[k] = v;
    this.ensureDir();
    try { writeFileSync(this.chatsFile, JSON.stringify(obj)); } catch (e) { console.error('[wa-store] saveChats failed:', e); }
  }

  /** Apply many mutations writing chats.json only once at the end. Used by history
      sync so a multi-thousand-message batch doesn't rewrite the chat index per row. */
  bulk(fn: () => void): void {
    const wasDeferring = this.deferSave;
    this.deferSave = true;
    try { fn(); } finally {
      if (!wasDeferring) {
        this.deferSave = false;
        if (this.chatsDirty) { this.chatsDirty = false; this.saveChats(); }
      }
    }
  }

  listChats(): WaChatMeta[] {
    return [...this.chats.values()].map(c => ({ ...c })).sort((a, b) => {
      const pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;            // pinned first
      return b.lastMessageAt - a.lastMessageAt; // then newest activity
    });
  }
  getChat(chatId: string): WaChatMeta | undefined {
    const c = this.chats.get(chatId);
    return c ? { ...c } : undefined;
  }
  upsertChat(meta: { chatId: string } & Partial<WaChatMeta>): WaChatMeta {
    const cur = this.chats.get(meta.chatId);
    const next: WaChatMeta = {
      chatId: meta.chatId,
      name: meta.name ?? cur?.name ?? meta.chatId,
      kind: meta.kind ?? cur?.kind ?? 'dm',
      avatarUrl: meta.avatarUrl !== undefined ? meta.avatarUrl : cur?.avatarUrl,
      lastMessageAt: meta.lastMessageAt ?? cur?.lastMessageAt ?? 0,
      lastMessageText: meta.lastMessageText ?? cur?.lastMessageText ?? '',
      lastMessageFromMe: meta.lastMessageFromMe ?? cur?.lastMessageFromMe ?? false,
      unreadCount: meta.unreadCount ?? cur?.unreadCount ?? 0,
      pinned: meta.pinned ?? cur?.pinned,
      muted: meta.muted ?? cur?.muted,
      isContact: meta.isContact ?? cur?.isContact,
      lastReportedAt: meta.lastReportedAt ?? cur?.lastReportedAt ?? 0,
    };
    this.chats.set(meta.chatId, next);
    this.saveChats();
    return { ...next };
  }
  markRead(chatId: string): void {
    const c = this.chats.get(chatId);
    if (c && c.unreadCount !== 0) { c.unreadCount = 0; this.saveChats(); }
  }
  setUnread(chatId: string, n: number): void {
    const c = this.chats.get(chatId);
    if (c) { c.unreadCount = Math.max(0, n | 0); this.saveChats(); }
  }
  markReported(chatId: string, ts: number): void {
    const c = this.chats.get(chatId);
    if (c) { c.lastReportedAt = Math.max(c.lastReportedAt, ts); this.saveChats(); }
  }

  // ── per-chat JSONL message log ──────────────────────────────────────────
  private safeId(chatId: string): string { return chatId.replace(/[^a-zA-Z0-9._-]/g, '_'); }
  private msgFile(chatId: string): string { return join(this.msgDir, `${this.safeId(chatId)}.jsonl`); }

  private readMessages(chatId: string): WaStoredMessage[] {
    let raw = '';
    try { raw = readFileSync(this.msgFile(chatId), 'utf8'); } catch { return []; }
    const out: WaStoredMessage[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line) as WaStoredMessage); } catch { /* skip a corrupt line */ }
    }
    return out;
  }
  private writeMessages(chatId: string, msgs: WaStoredMessage[]): void {
    const body = msgs.map(m => JSON.stringify(m)).join('\n');
    this.ensureDir();
    try { writeFileSync(this.msgFile(chatId), body + (msgs.length ? '\n' : '')); } catch (e) { console.error('[wa-store] writeMessages failed:', e); }
    this.counts.set(chatId, msgs.length);
  }
  private lineCount(chatId: string): number {
    const cached = this.counts.get(chatId);
    if (cached != null) return cached;
    const n = this.readMessages(chatId).length;
    this.counts.set(chatId, n);
    return n;
  }
  private seenSet(chatId: string): Set<string> {
    let s = this.seen.get(chatId);
    if (!s) {
      s = new Set(this.readMessages(chatId).map(m => m.msgId).filter(Boolean) as string[]);
      this.seen.set(chatId, s);
    }
    return s;
  }

  /** Append a message. Dedupes by WhatsApp msgId (returns null on a repeat) and
      keeps the chat's preview/unread/last-activity meta in sync. Pass
      `{ bumpUnread:false }` for back-fill (history sync) so old reads don't inflate
      the unread badge — set the authoritative count via upsertChat afterward. */
  appendMessage(input: WaMessageInput, opts: { bumpUnread?: boolean } = {}): WaStoredMessage | null {
    const chatId = input.chatId;
    if (input.msgId) {
      const seen = this.seenSet(chatId);
      if (seen.has(input.msgId)) return null;
      seen.add(input.msgId);
    }
    const msg: WaStoredMessage = {
      id: input.id ?? randomUUID(),
      msgId: input.msgId,
      chatId,
      fromMe: input.fromMe,
      senderId: input.senderId,
      senderName: input.senderName,
      text: input.text,
      kind: input.kind ?? 'text',
      ts: input.ts,
      quotedText: input.quotedText,
      reactions: input.reactions,
      media: input.media,
      status: input.status,
    };
    // Count BEFORE the write: with a cold cache, lineCount reads the file — doing it
    // after the append would include the new line and over-count by one.
    const n = this.lineCount(chatId) + 1;
    this.ensureDir();
    try { appendFileSync(this.msgFile(chatId), JSON.stringify(msg) + '\n'); } catch (e) { console.error('[wa-store] append failed:', e); }
    this.counts.set(chatId, n);

    const cur = this.chats.get(chatId);
    const isNewer = !cur || msg.ts >= cur.lastMessageAt;
    const bump = opts.bumpUnread !== false && !msg.fromMe;
    this.upsertChat({
      chatId,
      ...(isNewer ? { lastMessageAt: msg.ts, lastMessageText: msg.text || `[${msg.kind}]`, lastMessageFromMe: msg.fromMe } : {}),
      unreadCount: (cur?.unreadCount ?? 0) + (bump ? 1 : 0),
    });

    if (n > this.msgCap + this.compactMargin) this.compact(chatId);
    return msg;
  }

  /** Read a chat's messages in chronological order. Filters: `sinceReported`
      (only after the summary watermark), `sinceTs` (≥), `before` (<). `limit`
      returns the most-recent N (for the UI's initial page). */
  getMessages(chatId: string, opts: { limit?: number; before?: number; sinceTs?: number; sinceReported?: boolean } = {}): WaStoredMessage[] {
    let msgs = this.readMessages(chatId);
    if (opts.sinceReported) {
      const wm = this.chats.get(chatId)?.lastReportedAt ?? 0;
      msgs = msgs.filter(m => m.ts > wm);
    }
    if (opts.sinceTs != null) msgs = msgs.filter(m => m.ts >= opts.sinceTs!);
    if (opts.before != null) msgs = msgs.filter(m => m.ts < opts.before!);
    msgs.sort((a, b) => a.ts - b.ts); // stable — preserves arrival order on ties
    if (opts.limit != null && msgs.length > opts.limit) msgs = msgs.slice(-opts.limit);
    return msgs;
  }

  /** Number of messages currently stored for a chat (lazily counted, then cached). */
  count(chatId: string): number { return this.lineCount(chatId); }

  /** Patch a stored message in place (reactions, delivery status, edits). */
  updateMessage(chatId: string, msgIdOrId: string, patch: Partial<WaStoredMessage>): void {
    const msgs = this.readMessages(chatId);
    let changed = false;
    for (const m of msgs) {
      if (m.msgId === msgIdOrId || m.id === msgIdOrId) { Object.assign(m, patch); changed = true; }
    }
    if (changed) this.writeMessages(chatId, msgs);
  }

  /** Drop a chat entirely — metadata and message log (on untrack / unlink). */
  forget(chatId: string): void {
    this.chats.delete(chatId);
    this.counts.delete(chatId);
    this.seen.delete(chatId);
    this.saveChats();
    try { rmSync(this.msgFile(chatId), { force: true }); } catch { /* already gone */ }
  }

  /** Wipe everything (on unlink). */
  clear(): void {
    for (const chatId of [...this.chats.keys()]) this.forget(chatId);
  }

  private compact(chatId: string): void {
    const kept = this.readMessages(chatId).slice(-this.msgCap);
    this.writeMessages(chatId, kept);
    this.seen.set(chatId, new Set(kept.map(m => m.msgId).filter(Boolean) as string[]));
  }
}
