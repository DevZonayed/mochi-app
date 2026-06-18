/* WaStore — the desktop's full WhatsApp chat/message store: chat metadata in
   chats.json + per-chat append-only JSONL message logs (bounded), serving both
   the WhatsApp screen and the quiet-timer summarizer. Pure filesystem; no
   electron mock needed (the caller passes the base dir). */
import { describe, it, expect, beforeEach } from 'vitest';
import { rmSync } from 'node:fs';
import { WaStore } from './wa-store.js';

const base = `/tmp/maestro-wa-store-test-${process.pid}`;
beforeEach(() => rmSync(base, { recursive: true, force: true }));

describe('WaStore — chats', () => {
  it('upserts chat metadata and lists newest-first', () => {
    const wa = new WaStore(base);
    wa.upsertChat({ chatId: 'a@s', name: 'Alice', kind: 'dm', lastMessageAt: 100 });
    wa.upsertChat({ chatId: 'b@g', name: 'Group', kind: 'group', lastMessageAt: 300 });
    wa.upsertChat({ chatId: 'a@s', lastMessageAt: 200 }); // partial update keeps name
    const list = wa.listChats();
    expect(list.map(c => c.chatId)).toEqual(['b@g', 'a@s']);
    expect(list.find(c => c.chatId === 'a@s')!.name).toBe('Alice');
  });

  it('persists chats across reloads', () => {
    new WaStore(base).upsertChat({ chatId: 'a@s', name: 'Alice', kind: 'dm', lastMessageAt: 100 });
    const list = new WaStore(base).listChats();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Alice');
  });

  it('floats pinned chats to the top regardless of recency', () => {
    const wa = new WaStore(base);
    wa.upsertChat({ chatId: 'a@s', name: 'A', kind: 'dm', lastMessageAt: 100, pinned: true });
    wa.upsertChat({ chatId: 'b@s', name: 'B', kind: 'dm', lastMessageAt: 999 });
    expect(wa.listChats().map(c => c.chatId)).toEqual(['a@s', 'b@s']);
  });
});

describe('WaStore — messages', () => {
  it('appends and reads chronologically; updates chat preview + unread', () => {
    const wa = new WaStore(base);
    wa.appendMessage({ chatId: 'a@s', msgId: '1', fromMe: false, senderName: 'Alice', text: 'hi', ts: 100 });
    wa.appendMessage({ chatId: 'a@s', msgId: '2', fromMe: true, senderName: 'Me', text: 'yo', ts: 200 });
    const msgs = wa.getMessages('a@s');
    expect(msgs.map(m => m.text)).toEqual(['hi', 'yo']);
    const chat = wa.getChat('a@s')!;
    expect(chat.lastMessageText).toBe('yo');
    expect(chat.lastMessageAt).toBe(200);
    expect(chat.lastMessageFromMe).toBe(true);
    expect(chat.unreadCount).toBe(1); // only the inbound 'hi' counts toward unread
  });

  it('dedupes by msgId', () => {
    const wa = new WaStore(base);
    expect(wa.appendMessage({ chatId: 'a@s', msgId: 'x', fromMe: false, senderName: 'A', text: 'one', ts: 1 })).toBeTruthy();
    expect(wa.appendMessage({ chatId: 'a@s', msgId: 'x', fromMe: false, senderName: 'A', text: 'one', ts: 1 })).toBeNull();
    expect(wa.getMessages('a@s')).toHaveLength(1);
  });

  it('markRead clears unread', () => {
    const wa = new WaStore(base);
    wa.appendMessage({ chatId: 'a@s', msgId: '1', fromMe: false, senderName: 'A', text: 'hi', ts: 1 });
    wa.markRead('a@s');
    expect(wa.getChat('a@s')!.unreadCount).toBe(0);
  });

  it('getMessages supports limit (most recent) and before (older page)', () => {
    const wa = new WaStore(base);
    for (let i = 1; i <= 5; i++) wa.appendMessage({ chatId: 'a@s', msgId: String(i), fromMe: false, senderName: 'A', text: `m${i}`, ts: i });
    expect(wa.getMessages('a@s', { limit: 2 }).map(m => m.text)).toEqual(['m4', 'm5']);
    expect(wa.getMessages('a@s', { before: 3 }).map(m => m.text)).toEqual(['m1', 'm2']); // ts < 3
  });

  it('sinceReported returns only messages after the watermark', () => {
    const wa = new WaStore(base);
    wa.appendMessage({ chatId: 'a@s', msgId: '1', fromMe: false, senderName: 'A', text: 'old', ts: 100 });
    wa.markReported('a@s', 150);
    wa.appendMessage({ chatId: 'a@s', msgId: '2', fromMe: false, senderName: 'A', text: 'new', ts: 200 });
    expect(wa.getMessages('a@s', { sinceReported: true }).map(m => m.text)).toEqual(['new']);
  });

  it('caps stored messages, keeping the newest', () => {
    const wa = new WaStore(base, { msgCap: 5, compactMargin: 0 });
    for (let i = 1; i <= 8; i++) wa.appendMessage({ chatId: 'a@s', msgId: String(i), fromMe: false, senderName: 'A', text: `m${i}`, ts: i });
    const msgs = wa.getMessages('a@s');
    expect(msgs.length).toBeLessThanOrEqual(5);
    expect(msgs.at(-1)!.text).toBe('m8');
  });

  it('updateMessage patches a stored message in place (reactions/status)', () => {
    const wa = new WaStore(base);
    wa.appendMessage({ chatId: 'a@s', msgId: 'm1', fromMe: true, senderName: 'Me', text: 'hey', ts: 1 });
    wa.updateMessage('a@s', 'm1', { status: 'read', reactions: [{ emoji: '👍', fromMe: false }] });
    const m = wa.getMessages('a@s')[0];
    expect(m.status).toBe('read');
    expect(m.reactions).toEqual([{ emoji: '👍', fromMe: false }]);
  });

  it('bulk() applies many mutations and persists them with one flush', () => {
    const wa = new WaStore(base);
    wa.bulk(() => {
      wa.upsertChat({ chatId: 'a@s', name: 'A', kind: 'dm', lastMessageAt: 1 });
      wa.appendMessage({ chatId: 'b@s', msgId: '1', fromMe: false, senderName: 'B', text: 'hi', ts: 2 });
    });
    // a fresh store (reads from disk) sees both chats → the bulk flush persisted
    expect(new WaStore(base).listChats().map(c => c.chatId).sort()).toEqual(['a@s', 'b@s']);
  });

  it('count reflects the number of stored messages', () => {
    const wa = new WaStore(base);
    expect(wa.count('a@s')).toBe(0);
    wa.appendMessage({ chatId: 'a@s', msgId: '1', fromMe: false, senderName: 'A', text: 'hi', ts: 1 });
    wa.appendMessage({ chatId: 'a@s', msgId: '2', fromMe: false, senderName: 'A', text: 'yo', ts: 2 });
    expect(wa.count('a@s')).toBe(2);
  });

  it('count is correct after appending with a cold cache (existing on-disk history)', () => {
    new WaStore(base).appendMessage({ chatId: 'a@s', msgId: '1', fromMe: false, senderName: 'A', text: 'one', ts: 1 });
    const wa2 = new WaStore(base); // fresh instance: line-count cache is cold, file has 1 line
    wa2.appendMessage({ chatId: 'a@s', msgId: '2', fromMe: false, senderName: 'A', text: 'two', ts: 2 });
    expect(wa2.count('a@s')).toBe(2);
    expect(wa2.getMessages('a@s').map(m => m.text)).toEqual(['one', 'two']);
  });

  it('forget removes the chat and its messages', () => {
    const wa = new WaStore(base);
    wa.appendMessage({ chatId: 'a@s', msgId: '1', fromMe: false, senderName: 'A', text: 'hi', ts: 1 });
    wa.forget('a@s');
    expect(wa.getChat('a@s')).toBeUndefined();
    expect(wa.getMessages('a@s')).toEqual([]);
  });
});
