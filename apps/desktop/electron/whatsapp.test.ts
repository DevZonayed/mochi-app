/* WhatsAppClient — the desktop-owned Baileys socket. Baileys itself is never
   loaded here: the socket is dependency-injected as a mock, so these tests
   exercise the parts that matter (normalize, capture→store→arm-timer routing,
   send-to-self, connection-state) without touching the network. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-wa-client-test-${process.pid}` }));
vi.mock('electron', () => ({
  app: { getPath: () => hoisted.dir },
  powerMonitor: { on: () => {} },
}));

import { Store } from './store.js';
import { WhatsAppClient, normalizeWaMessage, waSendAllowed } from './whatsapp.js';

/** A minimal stand-in for a baileys socket: records sends, replays ev emissions. */
function mockSocket(ownId = '15551234567:3@s.whatsapp.net') {
  const handlers: Record<string, Array<(p: unknown) => void>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sent: Array<{ jid: string; text?: string; content: any }> = [];
  const reads: unknown[] = [];
  const sock = {
    ev: { on: (e: string, cb: (p: unknown) => void) => { (handlers[e] ||= []).push(cb); } },
    user: { id: ownId },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMessage: async (jid: string, c: any) => { sent.push({ jid, text: c.text, content: c }); return { key: { id: `srv-${c.text ?? 'm'}`, remoteJid: jid, fromMe: true } }; },
    readMessages: async (keys: unknown[]) => { reads.push(...keys); },
    end: () => {},
  };
  const fire = (e: string, p: unknown) => { (handlers[e] || []).forEach(cb => cb(p)); };
  return { sock, sent, reads, fire };
}

function textMsg(chatId: string, text: string, opts: { fromMe?: boolean; pushName?: string; ts?: number } = {}) {
  return {
    key: { remoteJid: chatId, fromMe: !!opts.fromMe, id: `id-${text}` },
    message: { conversation: text },
    messageTimestamp: opts.ts ?? 1700000000,
    pushName: opts.pushName ?? 'Alice',
  };
}

beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

describe('normalizeWaMessage', () => {
  it('normalizes a text DM, converting the timestamp to ms', () => {
    const m = normalizeWaMessage(textMsg('111@s.whatsapp.net', 'hello'))!;
    expect(m.chatId).toBe('111@s.whatsapp.net');
    expect(m.text).toBe('hello');
    expect(m.fromMe).toBe(false);
    expect(m.isGroup).toBe(false);
    expect(m.senderName).toBe('Alice');
    expect(m.ts).toBe(1700000000 * 1000); // seconds → ms
  });

  it('normalizes a group image with a caption and the participant as sender', () => {
    const raw = {
      key: { remoteJid: '123-456@g.us', participant: '999@s.whatsapp.net', fromMe: false, id: 'g1' },
      message: { imageMessage: { caption: 'look' } },
      messageTimestamp: 1700000123,
      pushName: 'Bob',
    };
    const m = normalizeWaMessage(raw)!;
    expect(m.isGroup).toBe(true);
    expect(m.kind).toBe('image');
    expect(m.text).toContain('look');
  });
});

describe('waSendAllowed — agent send gate', () => {
  it('always allows messaging your own number (device suffix ignored)', () => {
    expect(waSendAllowed('15551234567@s.whatsapp.net', '15551234567:3@s.whatsapp.net', false)).toBe(true);
  });
  it('blocks messaging anyone else unless the operator opted in', () => {
    expect(waSendAllowed('999@s.whatsapp.net', '15551234567@s.whatsapp.net', false)).toBe(false);
    expect(waSendAllowed('999@s.whatsapp.net', '15551234567@s.whatsapp.net', true)).toBe(true);
  });
});

describe('WhatsAppClient.ingest — capture routing', () => {
  it('records a tracked chat and arms its quiet timer', () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    const sess = s.createSession(p.id, 'Chat');
    s.bindChat({ chatId: '111@s.whatsapp.net', name: 'Alice', kind: 'dm', provider: 'whatsapp', projectId: p.id, sessionId: sess.id });
    const client = new WhatsAppClient(s, vi.fn());

    client.ingest(textMsg('111@s.whatsapp.net', 'hi'));

    expect(s.getWaTranscript('111@s.whatsapp.net').map(m => m.text)).toEqual(['hi']);
    // a quiet timer was armed for exactly this chat
    const timers = s.listSchedules().filter(x => x.kind === 'whatsapp-analyze');
    expect(timers).toHaveLength(1);
    expect(timers[0].chatId).toBe('111@s.whatsapp.net');
  });

  it('ignores echoes of our own note-to-self summaries (no pending, no loop)', () => {
    const s = new Store();
    s.setWhatsappState({ connected: true, jid: '15551234567@s.whatsapp.net' });
    const client = new WhatsAppClient(s, vi.fn());

    // The summary we just sent comes back through messages.upsert (fromMe, own jid).
    client.ingest(textMsg('15551234567@s.whatsapp.net', 'Summary: …', { fromMe: true }));

    expect(s.listPendingChats()).toHaveLength(0);
    expect(s.listSchedules().filter(x => x.kind === 'whatsapp-analyze')).toHaveLength(0);
  });

  it('captures an untracked chat into the WhatsApp view AND surfaces it as pending (no timer)', () => {
    const s = new Store();
    const client = new WhatsAppClient(s, vi.fn());

    client.ingest(textMsg('888@s.whatsapp.net', 'who am i'));

    // Now captured so the WhatsApp screen can show it (Mac-local)…
    expect(s.getWaTranscript('888@s.whatsapp.net').map(m => m.text)).toEqual(['who am i']);
    // …still surfaced to bind for the quiet-timer, but no timer until bound.
    expect(s.listSchedules().filter(x => x.kind === 'whatsapp-analyze')).toHaveLength(0);
    expect(s.listPendingChats().some(c => c.chatId === '888@s.whatsapp.net')).toBe(true);
  });

  it("resets the timer on the operator's own reply (conversation still active)", () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    s.bindChat({ chatId: '111@s.whatsapp.net', name: 'Alice', kind: 'dm', provider: 'whatsapp', projectId: p.id });
    const client = new WhatsAppClient(s, vi.fn());

    client.ingest(textMsg('111@s.whatsapp.net', 'hi', { ts: 1700000000 }));
    const firstFire = s.listSchedules().find(x => x.kind === 'whatsapp-analyze')!.fireAt!;
    client.ingest(textMsg('111@s.whatsapp.net', 'my reply', { fromMe: true, ts: 1700000100 }));

    const timers = s.listSchedules().filter(x => x.kind === 'whatsapp-analyze');
    expect(timers).toHaveLength(1);               // still one timer, reset in place
    expect(timers[0].fireAt!).toBeGreaterThanOrEqual(firstFire);
    expect(s.getWaTranscript('111@s.whatsapp.net').map(m => m.text)).toEqual(['hi', 'my reply']);
  });
});

describe('WhatsAppClient — full chat list + history', () => {
  it('ingests a history-sync batch into the chat list + message logs', async () => {
    const s = new Store();
    const { sock, fire } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });
    await client.connect();

    fire('messaging-history.set', {
      contacts: [{ id: '111@s.whatsapp.net', name: 'Alice' }],
      chats: [
        { id: '111@s.whatsapp.net', conversationTimestamp: 1700000200 },
        { id: '999-1@g.us', name: 'Team', conversationTimestamp: 1700000300 },
      ],
      messages: [textMsg('111@s.whatsapp.net', 'hey', { ts: 1700000100 })],
    });

    expect(s.waListChats().map(c => c.chatId).sort()).toEqual(['111@s.whatsapp.net', '999-1@g.us']);
    expect(s.waGetChat('111@s.whatsapp.net')!.name).toBe('Alice');     // resolved from contact
    expect(s.waGetChat('999-1@g.us')!.kind).toBe('group');             // kind derived from JID
    expect(s.waMessages('111@s.whatsapp.net').map(m => m.text)).toEqual(['hey']);
  });

  it('updates a chat name from chats.upsert', async () => {
    const s = new Store();
    const { sock, fire } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });
    await client.connect();

    fire('chats.upsert', [{ id: '222@s.whatsapp.net', name: 'Bob' }]);

    expect(s.waGetChat('222@s.whatsapp.net')!.name).toBe('Bob');
  });
});

describe('WhatsAppClient — connection + send', () => {
  it('marks connected and captures the own JID when the socket opens', async () => {
    const s = new Store();
    const { sock, fire } = mockSocket('15551234567:3@s.whatsapp.net');
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });

    await client.connect();
    fire('connection.update', { connection: 'open' });

    const st = s.whatsappState();
    expect(st.connected).toBe(true);
    expect(st.jid).toBe('15551234567@s.whatsapp.net'); // device suffix stripped
  });

  it('sends a summary to the linked own number (note to self)', async () => {
    const s = new Store();
    const { sock, sent, fire } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });
    await client.connect();
    fire('connection.update', { connection: 'open' });

    const ok = await client.sendToSelf('Summary: 3 messages, 1 decision.');

    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].jid).toBe('15551234567@s.whatsapp.net');
    expect(sent[0].text).toMatch(/Summary/);
  });

  it('refuses to send when not connected', async () => {
    const s = new Store();
    const client = new WhatsAppClient(s, vi.fn());
    expect(await client.sendToSelf('nope')).toBe(false);
  });

  it('sendText delivers to a chat and stores the outgoing message locally', async () => {
    const s = new Store();
    const { sock, sent, fire } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });
    await client.connect();
    fire('connection.update', { connection: 'open' });

    const ok = await client.sendText('111@s.whatsapp.net', 'hello there');

    expect(ok).toBe(true);
    expect(sent.at(-1)).toMatchObject({ jid: '111@s.whatsapp.net', text: 'hello there' });
    expect(s.waMessages('111@s.whatsapp.net').map(m => m.text)).toContain('hello there');
    expect(s.waMessages('111@s.whatsapp.net').at(-1)!.fromMe).toBe(true);
  });

  it('sendText returns false when not connected', async () => {
    const s = new Store();
    const client = new WhatsAppClient(s, vi.fn());
    expect(await client.sendText('111@s.whatsapp.net', 'x')).toBe(false);
  });

  it('sendReaction emits a react payload to the socket', async () => {
    const s = new Store();
    const { sock, sent, fire } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });
    await client.connect();
    fire('connection.update', { connection: 'open' });

    await client.sendReaction('111@s.whatsapp.net', 'msg-1', '👍');

    expect(sent.at(-1)!.content.react).toMatchObject({ text: '👍' });
  });

  it('markRead clears the unread badge', async () => {
    const s = new Store();
    const { sock, fire } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });
    await client.connect();
    fire('messages.upsert', { messages: [textMsg('111@s.whatsapp.net', 'ping')] });
    expect(s.waGetChat('111@s.whatsapp.net')!.unreadCount).toBe(1);

    await client.markRead('111@s.whatsapp.net');

    expect(s.waGetChat('111@s.whatsapp.net')!.unreadCount).toBe(0);
  });

  it('captures inbound messages wired through the live socket', async () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    s.bindChat({ chatId: '111@s.whatsapp.net', name: 'Alice', kind: 'dm', provider: 'whatsapp', projectId: p.id });
    const { sock, fire } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });
    await client.connect();

    fire('messages.upsert', { messages: [textMsg('111@s.whatsapp.net', 'via socket')] });

    expect(s.getWaTranscript('111@s.whatsapp.net').map(m => m.text)).toEqual(['via socket']);
  });
});
