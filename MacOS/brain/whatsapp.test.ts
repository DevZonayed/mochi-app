/* WhatsAppClient — the desktop-owned Baileys socket. Baileys itself is never
   loaded here: the socket is dependency-injected as a mock, so these tests
   exercise the parts that matter (normalize, capture→store→arm-timer routing,
   send-to-self, connection-state) without touching the network. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({
  dir: `/tmp/maestro-store-wa-client-test-${process.pid}`,
  powerHandlers: {} as Record<string, Array<() => void>>,
  rmMock: vi.fn(async (...args: unknown[]) => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return fs.rm(...args as Parameters<typeof fs.rm>);
  }),
}));
vi.mock('electron', () => ({
  app: { getPath: () => hoisted.dir },
  powerMonitor: { on: (event: string, cb: () => void) => { (hoisted.powerHandlers[event] ||= []).push(cb); } },
}));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, rm: hoisted.rmMock };
});

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

function transientClose(code = 500) {
  return { connection: 'close', lastDisconnect: { error: { output: { statusCode: code } } } };
}

function textMsg(chatId: string, text: string, opts: { fromMe?: boolean; pushName?: string; ts?: number } = {}) {
  return {
    key: { remoteJid: chatId, fromMe: !!opts.fromMe, id: `id-${text}` },
    message: { conversation: text },
    messageTimestamp: opts.ts ?? 1700000000,
    pushName: opts.pushName ?? 'Alice',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  rmSync(hoisted.dir, { recursive: true, force: true });
  hoisted.powerHandlers = {};
  hoisted.rmMock.mockClear();
  hoisted.rmMock.mockImplementation(async (...args: unknown[]) => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    return fs.rm(...args as Parameters<typeof fs.rm>);
  });
});
afterEach(() => { vi.useRealTimers(); });

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
  it('always allows the linked number OR the configured notify number (device suffix ignored)', () => {
    expect(waSendAllowed('15551234567@s.whatsapp.net', ['15551234567:3@s.whatsapp.net', null], false)).toBe(true);
    // the user's personal "notify" number is also always allowed
    expect(waSendAllowed('999@s.whatsapp.net', ['15551234567@s.whatsapp.net', '999@s.whatsapp.net'], false)).toBe(true);
  });
  it('blocks messaging anyone else unless the operator opted in', () => {
    expect(waSendAllowed('888@s.whatsapp.net', ['15551234567@s.whatsapp.net', null], false)).toBe(false);
    expect(waSendAllowed('888@s.whatsapp.net', ['15551234567@s.whatsapp.net', null], true)).toBe(true);
  });
});

describe('normalizeWaMessage — media descriptors + extra kinds', () => {
  it('extracts an image media descriptor (thumbnail + download keys)', () => {
    const m = normalizeWaMessage({
      key: { remoteJid: 'a@s.whatsapp.net', id: 'i1' },
      message: { imageMessage: { caption: 'look', mimetype: 'image/jpeg', url: 'https://x', directPath: '/v/x', mediaKey: Buffer.from('key1'), jpegThumbnail: Buffer.from('thumbbytes') } },
      messageTimestamp: 100, pushName: 'A',
    })!;
    expect(m.kind).toBe('image');
    expect(m.text).toBe('look');
    expect(m.media?.mediaType).toBe('image');
    expect(m.media?.mimetype).toBe('image/jpeg');
    expect(m.media?.thumbBase64).toBe(Buffer.from('thumbbytes').toString('base64'));
    expect(m.media?.mediaKeyB64).toBe(Buffer.from('key1').toString('base64'));
    expect(m.media?.directPath).toBe('/v/x');
  });
  it('classifies sticker, audio (with duration) and contact', () => {
    expect(normalizeWaMessage({ key: { remoteJid: 'a@s', id: 's1' }, message: { stickerMessage: { mimetype: 'image/webp', mediaKey: Buffer.from('k'), url: 'u' } }, messageTimestamp: 1 })!.kind).toBe('sticker');
    const a = normalizeWaMessage({ key: { remoteJid: 'a@s', id: 'au1' }, message: { audioMessage: { mimetype: 'audio/ogg', mediaKey: Buffer.from('k'), url: 'u', seconds: 12, ptt: true } }, messageTimestamp: 1 })!;
    expect(a.kind).toBe('audio'); expect(a.media?.seconds).toBe(12);
    const c = normalizeWaMessage({ key: { remoteJid: 'a@s', id: 'c1' }, message: { contactMessage: { displayName: 'Bob' } }, messageTimestamp: 1 })!;
    expect(c.kind).toBe('contact'); expect(c.text).toBe('Bob');
  });
  it('marks unknown/protocol frames as system with empty text + no media', () => {
    const m = normalizeWaMessage({ key: { remoteJid: 'a@s', id: 'p1' }, message: { protocolMessage: { type: 0 } }, messageTimestamp: 1 })!;
    expect(m.kind).toBe('system'); expect(m.text).toBe(''); expect(m.media).toBeUndefined();
  });
});

describe('WhatsAppClient.ingest — skip blank frames', () => {
  it('does not store empty system/protocol frames (so they never render as blank bubbles)', () => {
    const s = new Store();
    const client = new WhatsAppClient(s, vi.fn());
    client.ingest({ key: { remoteJid: 'z@s.whatsapp.net', id: 'p1' }, message: { protocolMessage: { type: 0 } }, messageTimestamp: 1 });
    expect(s.waMessages('z@s.whatsapp.net')).toHaveLength(0);
    expect(s.waGetChat('z@s.whatsapp.net')).toBeUndefined(); // not even a chat row
    client.ingest({ key: { remoteJid: 'z@s.whatsapp.net', id: 't1' }, message: { conversation: 'real' }, messageTimestamp: 2, pushName: 'A' });
    expect(s.waMessages('z@s.whatsapp.net').map(m => m.text)).toEqual(['real']);
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

  it('sendToSelf routes to the configured notify number when set (else the linked number)', async () => {
    const s = new Store();
    const { sock, sent } = mockSocket('111:2@s.whatsapp.net');
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });
    await client.connect();
    s.setWhatsappState({ connected: true, jid: '111@s.whatsapp.net', notifyJid: '99999@s.whatsapp.net' });

    await client.sendToSelf('summary');

    expect(sent.at(-1)!.jid).toBe('99999@s.whatsapp.net'); // the personal number, not the linked PA number
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

  it('reconnects after a generic 500 stream error without QR and preserves linked metadata', async () => {
    vi.useFakeTimers();
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net', name: 'Jonayed PA', sendApproved: true, notifyJid: '999@s.whatsapp.net' });
    const first = mockSocket('15551234567:3@s.whatsapp.net');
    const second = mockSocket('15551234567:3@s.whatsapp.net');
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.sock : second.sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });

    await client.connect();
    first.fire('connection.update', { connection: 'open' });
    first.fire('connection.update', transientClose(500));

    expect(s.whatsappState()).toMatchObject({
      connected: false,
      status: 'retrying',
      jid: '15551234567@s.whatsapp.net',
      name: 'Jonayed PA',
      linkedAt: 100,
      sendApproved: true,
      notifyJid: '999@s.whatsapp.net',
    });
    expect(makeSocket).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(makeSocket).toHaveBeenCalledTimes(2);
    second.fire('connection.update', { connection: 'open' });

    expect(s.whatsappState()).toMatchObject({
      connected: true,
      status: 'connected',
      jid: '15551234567@s.whatsapp.net',
      name: 'Jonayed PA',
      linkedAt: 100,
    });
    expect(s.whatsappState().connectedAt).toEqual(expect.any(Number));
  });

  it('retries when makeSocket rejects on boot and later succeeds', async () => {
    vi.useFakeTimers();
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net', status: 'offline', connected: true });
    const sock = mockSocket('15551234567:3@s.whatsapp.net');
    const makeSocket = vi.fn()
      .mockRejectedValueOnce(new Error('boot network down'))
      .mockResolvedValueOnce(sock.sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });

    client.resumeOnBoot();
    await vi.advanceTimersByTimeAsync(0);
    expect(s.whatsappState()).toMatchObject({ connected: false, status: 'retrying' });

    await vi.advanceTimersByTimeAsync(1000);
    expect(makeSocket).toHaveBeenCalledTimes(2);
    sock.fire('connection.update', { connection: 'open' });
    expect(s.whatsappState()).toMatchObject({ connected: true, status: 'connected' });
  });

  it('continues retrying past five transient failures with one socket attempt and one timer at a time', async () => {
    vi.useFakeTimers();
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net' });
    const sockets = Array.from({ length: 7 }, () => mockSocket('15551234567:3@s.whatsapp.net'));
    const makeSocket = vi.fn(async () => sockets[makeSocket.mock.calls.length - 1].sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });

    await client.connect();
    for (let i = 0; i < 6; i++) {
      sockets[i].fire('connection.update', transientClose(500));
      expect(s.whatsappState().status).toBe('retrying');
      if (i < 5) await vi.advanceTimersByTimeAsync(s.whatsappState().nextRetryAt! - Date.now());
    }

    expect(makeSocket).toHaveBeenCalledTimes(6);
    expect(s.whatsappState().retryAttempt).toBe(6);
    expect(s.whatsappState().nextRetryAt).toEqual(expect.any(Number));
  });

  it('ignores stale close events from an old socket after a newer socket is live', async () => {
    const s = new Store();
    const first = mockSocket('15551234567:3@s.whatsapp.net');
    const second = mockSocket('15551234567:3@s.whatsapp.net');
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.sock : second.sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });

    await client.connect();
    first.fire('connection.update', { connection: 'open' });
    client.disconnect();
    await client.reconnect();
    second.fire('connection.update', { connection: 'open' });
    first.fire('connection.update', transientClose(500));

    expect(s.whatsappState()).toMatchObject({ connected: true, status: 'connected' });
    expect(makeSocket).toHaveBeenCalledTimes(2);
  });

  it('pause cancels retry, persists across restart, and resume reconnects', async () => {
    vi.useFakeTimers();
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net' });
    const first = mockSocket('15551234567:3@s.whatsapp.net');
    const second = mockSocket('15551234567:3@s.whatsapp.net');
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.sock : second.sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });
    await client.connect();
    first.fire('connection.update', transientClose(500));

    client.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(makeSocket).toHaveBeenCalledTimes(1);
    expect(new Store().whatsappState()).toMatchObject({ status: 'paused', linkedAt: 100 });

    const restartedStore = new Store();
    const restarted = new WhatsAppClient(restartedStore, vi.fn(), { makeSocket });
    restarted.resumeOnBoot();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(makeSocket).toHaveBeenCalledTimes(1);

    await restarted.reconnect();
    await vi.waitFor(() => expect(makeSocket).toHaveBeenCalledTimes(2));
    second.fire('connection.update', { connection: 'open' });
    expect(restartedStore.whatsappState()).toMatchObject({ connected: true, status: 'connected' });
  });

  it('401 unlinks auth state while 440 needs manual attention without wiping auth metadata', async () => {
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net', name: 'Me', sendApproved: true });
    const loggedOut = mockSocket('15551234567:3@s.whatsapp.net');
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => loggedOut.sock });
    await client.connect();
    loggedOut.fire('connection.update', transientClose(401));
    await vi.waitFor(() => expect(s.whatsappState().status).toBe('unlinked'));
    expect(s.whatsappState()).toMatchObject({ status: 'unlinked', linkedAt: null, jid: null, sendApproved: false });

    s.setWhatsappState({ linkedAt: 200, jid: '15551234567@s.whatsapp.net', name: 'Me', sendApproved: true });
    const replaced = mockSocket('15551234567:3@s.whatsapp.net');
    const client2 = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => replaced.sock });
    await client2.connect();
    replaced.fire('connection.update', transientClose(440));
    await vi.waitFor(() => expect(s.whatsappState().status).toBe('needs-attention'));
    expect(s.whatsappState()).toMatchObject({ status: 'needs-attention', linkedAt: 200, jid: '15551234567@s.whatsapp.net', name: 'Me', sendApproved: true });
  });

  it('whatsappLink on an already linked account rejects instead of reconnecting', async () => {
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net', status: 'offline' });
    const sock = mockSocket('15551234567:3@s.whatsapp.net');
    const makeSocket = vi.fn(async () => sock.sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });

    await expect(client.link()).rejects.toMatchObject({ code: 'WA_ALREADY_LINKED', statusCode: 409 });
    sock.fire('connection.update', { connection: 'open' });
    expect(makeSocket).not.toHaveBeenCalled();
    expect(s.whatsappState()).toMatchObject({ connected: false, status: 'offline' });
  });

  it('whatsappLink on an already connected linked account rejects without cycling the socket', async () => {
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net', status: 'connected', connected: true });
    const sock = mockSocket('15551234567:3@s.whatsapp.net');
    const makeSocket = vi.fn(async () => sock.sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });

    await expect(client.link()).rejects.toMatchObject({ code: 'WA_ALREADY_LINKED', statusCode: 409 });
    expect(makeSocket).not.toHaveBeenCalled();
    expect(s.whatsappState()).toMatchObject({ connected: true, status: 'connected' });
  });

  it('unlinked reconnect rejects before socket, QR, event, or state mutation', async () => {
    vi.useFakeTimers();
    const s = new Store();
    const emit = vi.fn();
    const { sock, fire } = mockSocket();
    const makeSocket = vi.fn(async () => sock);
    const client = new WhatsAppClient(s, emit, { makeSocket });
    const before = s.whatsappState();

    await expect(client.reconnect()).rejects.toMatchObject({ code: 'WA_NOT_LINKED', statusCode: 409 });
    fire('connection.update', { qr: 'stale-qr' });
    await vi.advanceTimersByTimeAsync(60_000);

    expect(makeSocket).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(s.whatsappState()).toEqual(before);
  });

  it('linked reconnect reuses credentials and remains single-flight while connecting', async () => {
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net', status: 'offline' });
    const gate = deferred<ReturnType<typeof mockSocket>>();
    const makeSocket = vi.fn(async () => (await gate.promise).sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });

    await expect(Promise.all([client.reconnect(), client.reconnect()])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(makeSocket).toHaveBeenCalledTimes(1);

    const linkedSocket = mockSocket('15551234567:3@s.whatsapp.net');
    gate.resolve(linkedSocket);
    await vi.waitFor(() => expect(s.whatsappState().status).toBe('connecting'));
    await Promise.resolve();
    await Promise.resolve();
    linkedSocket.fire('connection.update', { connection: 'open' });
    expect(s.whatsappState()).toMatchObject({ connected: true, status: 'connected', linkedAt: 100 });
  });

  it('first-time whatsappLink remains the QR path for an unlinked account', async () => {
    const s = new Store();
    const { sock, fire } = mockSocket();
    const makeSocket = vi.fn(async () => sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket, qrToDataUrl: async (qr) => `data:${qr}` });

    const pending = client.link();
    await vi.waitFor(() => expect(makeSocket).toHaveBeenCalledOnce());
    await Promise.resolve();
    await Promise.resolve();
    fire('connection.update', { qr: 'first-qr' });

    await expect(pending).resolves.toEqual({ method: 'qr', dataUrl: 'data:first-qr' });
  });

  it('keeps a first-time link pending across transient close retry and accepts the replacement QR', async () => {
    vi.useFakeTimers();
    const s = new Store();
    const first = mockSocket();
    const second = mockSocket();
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.sock : second.sock);
    const emit = vi.fn();
    const client = new WhatsAppClient(s, emit, { makeSocket, qrToDataUrl: async (qr) => `data:${qr}` });

    const pending = client.link();
    await vi.waitFor(() => expect(makeSocket).toHaveBeenCalledTimes(1));
    first.fire('connection.update', transientClose(500));
    await vi.advanceTimersByTimeAsync(1000);
    expect(makeSocket).toHaveBeenCalledTimes(2);
    second.fire('connection.update', { qr: 'retry-qr' });

    await expect(pending).resolves.toEqual({ method: 'qr', dataUrl: 'data:retry-qr' });
    expect(emit).toHaveBeenCalledWith('whatsapp-qr', { dataUrl: 'data:retry-qr' });
  });

  it('resumes an in-progress first-time link after sleep without requiring linked credentials', async () => {
    vi.useFakeTimers();
    const s = new Store();
    const first = mockSocket();
    const second = mockSocket();
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.sock : second.sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket, qrToDataUrl: async (qr) => `data:${qr}` });

    const pending = client.link();
    await vi.waitFor(() => expect(makeSocket).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    await Promise.resolve();
    hoisted.powerHandlers.suspend?.forEach(cb => cb());
    hoisted.powerHandlers.resume?.forEach(cb => cb());
    await vi.advanceTimersByTimeAsync(0);
    expect(makeSocket).toHaveBeenCalledTimes(2);
    second.fire('connection.update', { qr: 'wake-qr' });

    await expect(pending).resolves.toEqual({ method: 'qr', dataUrl: 'data:wake-qr' });
  });

  it('keeps an unresolved first-time link alive across suspend and settles it from exactly one fresh resumed socket', async () => {
    vi.useFakeTimers();
    const s = new Store();
    const emit = vi.fn();
    const first = deferred<ReturnType<typeof mockSocket>['sock']>();
    const stale = mockSocket();
    const resumed = mockSocket();
    stale.sock.end = vi.fn();
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.promise : resumed.sock);
    const client = new WhatsAppClient(s, emit, { makeSocket, qrToDataUrl: async qr => `data:${qr}` });

    const pending = client.link();
    const settled = vi.fn();
    pending.then(settled, settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(makeSocket).toHaveBeenCalledTimes(1);

    hoisted.powerHandlers.suspend?.forEach(cb => cb());
    hoisted.powerHandlers.resume?.forEach(cb => cb());
    hoisted.powerHandlers.resume?.forEach(cb => cb());
    await vi.advanceTimersByTimeAsync(0);
    expect(makeSocket).toHaveBeenCalledTimes(1);

    first.resolve(stale.sock);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(makeSocket).toHaveBeenCalledTimes(2));
    expect(stale.sock.end).toHaveBeenCalledTimes(1);
    stale.fire('connection.update', { qr: 'stale-sleep-qr' });
    stale.fire('connection.update', { connection: 'open' });
    expect(settled).not.toHaveBeenCalled();
    expect(client.currentQr()).toBeNull();
    expect(emit).not.toHaveBeenCalledWith('whatsapp-qr', expect.anything());
    expect(s.whatsappState()).toMatchObject({ connected: false, status: 'connecting', linkedAt: null });

    resumed.fire('connection.update', { qr: 'fresh-wake-qr' });
    await expect(pending).resolves.toEqual({ method: 'qr', dataUrl: 'data:fresh-wake-qr' });
    expect(emit).toHaveBeenCalledWith('whatsapp-qr', { dataUrl: 'data:fresh-wake-qr' });
  });

  it('does not expire a first-time pending link timeout during OS sleep', async () => {
    vi.useFakeTimers();
    const s = new Store();
    const emit = vi.fn();
    const first = deferred<ReturnType<typeof mockSocket>['sock']>();
    const stale = mockSocket();
    const fresh = mockSocket();
    stale.sock.end = vi.fn();
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.promise : fresh.sock);
    const client = new WhatsAppClient(s, emit, { makeSocket, qrToDataUrl: async qr => `data:${qr}` });

    const pending = client.link();
    const settled = vi.fn();
    pending.then(settled, settled);
    await vi.advanceTimersByTimeAsync(59_000);
    hoisted.powerHandlers.suspend?.forEach(cb => cb());
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(settled).not.toHaveBeenCalled();
    expect(makeSocket).toHaveBeenCalledTimes(1);

    hoisted.powerHandlers.resume?.forEach(cb => cb());
    first.resolve(stale.sock);
    await vi.waitFor(() => expect(makeSocket).toHaveBeenCalledTimes(2));
    expect(stale.sock.end).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(settled).not.toHaveBeenCalled();

    fresh.fire('connection.update', { qr: 'after-long-sleep' });
    await expect(pending).resolves.toEqual({ method: 'qr', dataUrl: 'data:after-long-sleep' });
    expect(emit).toHaveBeenCalledWith('whatsapp-qr', { dataUrl: 'data:after-long-sleep' });
  });

  it('keeps a first-time pending link when a pre-suspend makeSocket rejects after resume queues a fresh connect', async () => {
    vi.useFakeTimers();
    const s = new Store();
    const first = deferred<ReturnType<typeof mockSocket>['sock']>();
    const fresh = mockSocket();
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.promise : fresh.sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket, qrToDataUrl: async qr => `data:${qr}` });

    const pending = client.link();
    const settled = vi.fn();
    pending.then(settled, settled);
    await vi.advanceTimersByTimeAsync(0);
    expect(makeSocket).toHaveBeenCalledTimes(1);
    hoisted.powerHandlers.suspend?.forEach(cb => cb());
    hoisted.powerHandlers.resume?.forEach(cb => cb());
    first.reject(new Error('stale pre-suspend connect failed'));
    await vi.advanceTimersByTimeAsync(1000);

    await vi.waitFor(() => expect(makeSocket).toHaveBeenCalledTimes(2));
    expect(settled).not.toHaveBeenCalled();
    fresh.fire('connection.update', { qr: 'fresh-after-stale-reject' });
    await expect(pending).resolves.toEqual({ method: 'qr', dataUrl: 'data:fresh-after-stale-reject' });
  });

  it('ignores a pre-suspend linked reconnect socket and queues exactly one fresh socket on resume', async () => {
    vi.useFakeTimers();
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net', status: 'offline' });
    const first = deferred<ReturnType<typeof mockSocket>['sock']>();
    const stale = mockSocket('15551234567:3@s.whatsapp.net');
    const fresh = mockSocket('15551234567:3@s.whatsapp.net');
    stale.sock.end = vi.fn();
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.promise : fresh.sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });

    await client.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(makeSocket).toHaveBeenCalledTimes(1);
    hoisted.powerHandlers.suspend?.forEach(cb => cb());
    hoisted.powerHandlers.resume?.forEach(cb => cb());
    hoisted.powerHandlers.resume?.forEach(cb => cb());
    await vi.advanceTimersByTimeAsync(0);
    expect(makeSocket).toHaveBeenCalledTimes(1);

    first.resolve(stale.sock);
    await vi.waitFor(() => expect(makeSocket).toHaveBeenCalledTimes(2));
    expect(stale.sock.end).toHaveBeenCalledTimes(1);
    stale.fire('connection.update', { connection: 'open' });
    expect(s.whatsappState()).toMatchObject({ connected: false, status: 'connecting', linkedAt: 100 });

    fresh.fire('connection.update', { connection: 'open' });
    expect(s.whatsappState()).toMatchObject({ connected: true, status: 'connected', linkedAt: 100 });
  });

  it('does not start a fresh socket while still suspended when a stale in-flight attempt resolves', async () => {
    vi.useFakeTimers();
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net', status: 'offline' });
    const first = deferred<ReturnType<typeof mockSocket>['sock']>();
    const stale = mockSocket('15551234567:3@s.whatsapp.net');
    const fresh = mockSocket('15551234567:3@s.whatsapp.net');
    stale.sock.end = vi.fn();
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.promise : fresh.sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });

    await client.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    hoisted.powerHandlers.suspend?.forEach(cb => cb());
    first.resolve(stale.sock);
    await vi.advanceTimersByTimeAsync(0);

    expect(stale.sock.end).toHaveBeenCalledTimes(1);
    expect(makeSocket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(makeSocket).toHaveBeenCalledTimes(1);

    hoisted.powerHandlers.resume?.forEach(cb => cb());
    await vi.waitFor(() => expect(makeSocket).toHaveBeenCalledTimes(2));
    fresh.fire('connection.update', { connection: 'open' });
    expect(s.whatsappState()).toMatchObject({ connected: true, status: 'connected', linkedAt: 100 });
  });

  it('rejects a pending QR link immediately on pause so the UI can clear busy state', async () => {
    vi.useFakeTimers();
    const s = new Store();
    const { sock } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });

    const pending = client.link();
    await vi.advanceTimersByTimeAsync(0);
    client.disconnect();

    await expect(pending).rejects.toMatchObject({ code: 'WA_LINK_CANCELLED', reason: 'paused' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.whatsappState()).toMatchObject({ connected: false, status: 'unlinked' });
  });

  it('rejects a link cancelled during deferred socket creation and stale connect cannot create a pending QR timer', async () => {
    vi.useFakeTimers();
    const s = new Store();
    const make = deferred<ReturnType<typeof mockSocket>['sock']>();
    const emit = vi.fn();
    const client = new WhatsAppClient(s, emit, { makeSocket: async () => make.promise, qrToDataUrl: async qr => `qr:${qr}` });

    const pending = client.link();
    await vi.advanceTimersByTimeAsync(0);
    client.disconnect();

    await expect(pending).rejects.toMatchObject({ code: 'WA_LINK_CANCELLED', reason: 'paused' });
    const stale = mockSocket();
    make.resolve(stale.sock);
    await vi.advanceTimersByTimeAsync(0);
    stale.fire('connection.update', { qr: 'stale-after-pause' });
    await vi.advanceTimersByTimeAsync(61_000);

    expect(client.currentQr()).toBeNull();
    expect(emit).not.toHaveBeenCalledWith('whatsapp-qr', expect.anything());
    expect(s.whatsappState()).toMatchObject({ connected: false, status: 'unlinked' });
  });

  it('rejects a link cancelled by unlink during deferred socket creation before auth deletion resolves', async () => {
    vi.useFakeTimers();
    const s = new Store();
    const make = deferred<ReturnType<typeof mockSocket>['sock']>();
    let finishRm!: () => void;
    hoisted.rmMock.mockImplementation(async () => { await new Promise<void>(resolve => { finishRm = resolve; }); });
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => make.promise });

    const pending = client.link();
    await vi.advanceTimersByTimeAsync(0);
    const unlinking = client.unlink();

    await expect(pending).rejects.toMatchObject({ code: 'WA_LINK_CANCELLED', reason: 'unlinked' });
    const stale = mockSocket();
    make.resolve(stale.sock);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(client.currentQr()).toBeNull();
    expect(s.whatsappState().status).not.toBe('connected');

    finishRm();
    await unlinking;
    expect(s.whatsappState()).toMatchObject({ connected: false, status: 'unlinked', linkedAt: null, jid: null });
  });

  it('replacing a pending QR link rejects only the old request and its timeout cannot affect the newer link', async () => {
    vi.useFakeTimers();
    const s = new Store();
    const { sock, fire } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock, qrToDataUrl: async qr => `qr:${qr}` });

    const oldPending = client.link();
    await vi.advanceTimersByTimeAsync(0);
    const newPending = client.link();
    await expect(oldPending).rejects.toMatchObject({ code: 'WA_LINK_CANCELLED', reason: 'replaced' });

    await vi.advanceTimersByTimeAsync(59_999);
    fire('connection.update', { qr: 'new-qr' });

    await expect(newPending).resolves.toEqual({ method: 'qr', dataUrl: 'qr:new-qr' });
  });

  it('ignores stale old-generation QR conversion after a generation change and keeps the newer request pending until its QR', async () => {
    const s = new Store();
    const first = mockSocket();
    const second = mockSocket();
    const qr1 = deferred<string>();
    const qr2 = deferred<string>();
    const qrToDataUrl = vi.fn((qr: string) => qr === 'old' ? qr1.promise : qr2.promise);
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.sock : second.sock);
    const emit = vi.fn();
    const client = new WhatsAppClient(s, emit, { makeSocket, qrToDataUrl });

    await client.connect();
    const oldPending = client.link();
    first.fire('connection.update', { qr: 'old' });
    await vi.waitFor(() => expect(qrToDataUrl).toHaveBeenCalledWith('old'));

    client.disconnect();
    await expect(oldPending).rejects.toMatchObject({ code: 'WA_LINK_CANCELLED', reason: 'paused' });
    await client.connect();
    await vi.waitFor(() => expect(makeSocket).toHaveBeenCalledTimes(2));
    const newPending = client.link();
    await Promise.resolve();
    second.fire('connection.update', { qr: 'new' });
    await vi.waitFor(() => expect(qrToDataUrl).toHaveBeenCalledWith('new'));

    qr1.resolve('qr:old');
    await Promise.resolve();
    expect(client.currentQr()).toBeNull();
    expect(emit).not.toHaveBeenCalledWith('whatsapp-qr', { dataUrl: 'qr:old' });

    qr2.resolve('qr:new');
    await expect(newPending).resolves.toEqual({ method: 'qr', dataUrl: 'qr:new' });
    expect(client.currentQr()).toBe('qr:new');
    expect(emit).toHaveBeenCalledWith('whatsapp-qr', { dataUrl: 'qr:new' });
  });

  it('only lets the newest QR conversion in one generation settle and update lastQr', async () => {
    const s = new Store();
    const { sock, fire } = mockSocket();
    const slow = deferred<string>();
    const fast = deferred<string>();
    const qrToDataUrl = vi.fn((qr: string) => qr === 'slow' ? slow.promise : fast.promise);
    const emit = vi.fn();
    const makeSocket = vi.fn(async () => sock);
    const client = new WhatsAppClient(s, emit, { makeSocket, qrToDataUrl });

    await client.connect();
    const pending = client.link();
    fire('connection.update', { qr: 'slow' });
    fire('connection.update', { qr: 'fast' });
    await vi.waitFor(() => expect(qrToDataUrl).toHaveBeenCalledTimes(2));

    slow.resolve('qr:slow');
    await Promise.resolve();
    expect(client.currentQr()).toBeNull();
    expect(emit).not.toHaveBeenCalledWith('whatsapp-qr', { dataUrl: 'qr:slow' });

    fast.resolve('qr:fast');
    await expect(pending).resolves.toEqual({ method: 'qr', dataUrl: 'qr:fast' });
    expect(client.currentQr()).toBe('qr:fast');
    expect(emit).toHaveBeenCalledWith('whatsapp-qr', { dataUrl: 'qr:fast' });
  });

  it('continues emitting QR rotations after the initial link promise resolves', async () => {
    const s = new Store();
    const { sock, fire } = mockSocket();
    const emit = vi.fn();
    const client = new WhatsAppClient(s, emit, { makeSocket: async () => sock, qrToDataUrl: async qr => `qr:${qr}` });

    const pending = client.link();
    await Promise.resolve();
    await Promise.resolve();
    fire('connection.update', { qr: 'first' });
    await expect(pending).resolves.toEqual({ method: 'qr', dataUrl: 'qr:first' });

    fire('connection.update', { qr: 'rotated' });
    await vi.waitFor(() => expect(client.currentQr()).toBe('qr:rotated'));
    expect(emit).toHaveBeenCalledWith('whatsapp-qr', { dataUrl: 'qr:rotated' });
  });

  it('open settles a pending QR link and leaves no old timeout that can later reject', async () => {
    vi.useFakeTimers();
    const s = new Store();
    const { sock, fire } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });

    const pending = client.link();
    await vi.advanceTimersByTimeAsync(0);
    fire('connection.update', { connection: 'open' });

    await expect(pending).resolves.toEqual({ method: 'connected' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.whatsappState()).toMatchObject({ connected: true, status: 'connected' });
  });

  it('unlink is single-flight and blocks reconnect/socket creation until auth deletion completes', async () => {
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net', status: 'connected', connected: true });
    const { sock } = mockSocket();
    const makeSocket = vi.fn(async () => sock);
    let finishRm!: () => void;
    const rmStarted = vi.fn();
    hoisted.rmMock.mockImplementation(async () => {
      rmStarted();
      await new Promise<void>(resolve => { finishRm = resolve; });
    });
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });

    const first = client.unlink();
    const second = client.unlink();
    await vi.waitFor(() => expect(rmStarted).toHaveBeenCalledTimes(1));

    await expect(client.reconnect()).rejects.toMatchObject({ code: 'WA_UNLINK_IN_PROGRESS' });
    await expect(client.connect()).rejects.toMatchObject({ code: 'WA_UNLINK_IN_PROGRESS' });
    await expect(client.link()).rejects.toMatchObject({ code: 'WA_UNLINK_IN_PROGRESS' });
    expect(makeSocket).not.toHaveBeenCalled();

    finishRm();
    await Promise.all([first, second]);
    expect(hoisted.rmMock).toHaveBeenCalledTimes(1);
    expect(s.whatsappState()).toMatchObject({ connected: false, status: 'unlinked', linkedAt: null, jid: null });

    await expect(client.reconnect()).rejects.toMatchObject({ code: 'WA_NOT_LINKED', statusCode: 409 });
    expect(makeSocket).not.toHaveBeenCalled();
  });

  it('sets the unlink guard before synchronous socket release can re-enter reconnect', async () => {
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net', status: 'connected', connected: true });
    let reentrant: Promise<unknown> | null = null;
    const { sock } = mockSocket();
    const makeSocket = vi.fn(async () => sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });
    await client.connect();
    sock.end = () => { reentrant = client.reconnect(); reentrant.catch(() => {}); };

    await client.unlink();

    expect(reentrant).not.toBeNull();
    await expect(reentrant).rejects.toMatchObject({ code: 'WA_UNLINK_IN_PROGRESS' });
    expect(makeSocket).toHaveBeenCalledTimes(1);
    expect(s.whatsappState()).toMatchObject({ status: 'unlinked', linkedAt: null, jid: null });
  });

  it('401 unlink blocks reconnect until auth deletion completes and remains unlinked afterward', async () => {
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net', name: 'Me', sendApproved: true });
    let finishRm!: () => void;
    hoisted.rmMock.mockImplementation(async () => { await new Promise<void>(resolve => { finishRm = resolve; }); });
    const first = mockSocket('15551234567:3@s.whatsapp.net');
    const second = mockSocket('15551234567:3@s.whatsapp.net');
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.sock : second.sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });
    await client.connect();

    first.fire('connection.update', transientClose(401));
    await vi.waitFor(() => expect(hoisted.rmMock).toHaveBeenCalledTimes(1));
    await expect(client.reconnect()).rejects.toMatchObject({ code: 'WA_UNLINK_IN_PROGRESS' });
    expect(makeSocket).toHaveBeenCalledTimes(1);

    finishRm();
    await vi.waitFor(() => expect(s.whatsappState().status).toBe('unlinked'));
    expect(s.whatsappState()).toMatchObject({ linkedAt: null, jid: null, sendApproved: false });
    expect(makeSocket).toHaveBeenCalledTimes(1);
  });

  it('suspend clears retry before releasing the socket and resume reconnects wanted sessions exactly once', async () => {
    vi.useFakeTimers();
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net' });
    const first = mockSocket('15551234567:3@s.whatsapp.net');
    const second = mockSocket('15551234567:3@s.whatsapp.net');
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.sock : second.sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });
    await client.connect();
    first.fire('connection.update', transientClose(500));
    expect(s.whatsappState().status).toBe('retrying');

    hoisted.powerHandlers.suspend?.forEach(cb => cb());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(makeSocket).toHaveBeenCalledTimes(1);

    hoisted.powerHandlers.resume?.forEach(cb => cb());
    await vi.advanceTimersByTimeAsync(0);
    expect(makeSocket).toHaveBeenCalledTimes(2);
    hoisted.powerHandlers.resume?.forEach(cb => cb());
    await vi.advanceTimersByTimeAsync(0);
    expect(makeSocket).toHaveBeenCalledTimes(2);
  });

  it('queues resume when pause invalidates an in-flight socket creation before it settles', async () => {
    vi.useFakeTimers();
    const s = new Store();
    s.setWhatsappState({ linkedAt: 100, jid: '15551234567@s.whatsapp.net', status: 'offline' });
    const first = deferred<ReturnType<typeof mockSocket>['sock']>();
    const second = mockSocket('15551234567:3@s.whatsapp.net');
    const makeSocket = vi.fn(async () => makeSocket.mock.calls.length === 1 ? first.promise : second.sock);
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket });

    const firstConnect = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(makeSocket).toHaveBeenCalledTimes(1);
    client.disconnect();
    await client.reconnect();
    expect(makeSocket).toHaveBeenCalledTimes(1);

    const stale = mockSocket('15551234567:3@s.whatsapp.net');
    first.resolve(stale.sock);
    await firstConnect;
    await vi.waitFor(() => expect(makeSocket).toHaveBeenCalledTimes(2));
    second.fire('connection.update', { connection: 'open' });

    expect(s.whatsappState()).toMatchObject({ connected: true, status: 'connected', linkedAt: 100 });
  });
});

/* Operator quoted-reply routing — when the operator QUOTES a message a context
   agent sent them (note-to-self, or the notify DM) and replies, ingest hands
   the reply to onOperatorReply instead of the normal pend/timer path. */
describe('WhatsAppClient.ingest — operator quoted-reply routing', () => {
  const OWN = '15551234567@s.whatsapp.net';
  const NOTIFY = '99999@s.whatsapp.net';

  function quotedReply(chatId: string, quoted: string, text: string, opts: { fromMe?: boolean } = {}) {
    return {
      key: { remoteJid: chatId, fromMe: !!opts.fromMe, id: `qr-${text}` },
      message: { extendedTextMessage: { text, contextInfo: { quotedMessage: { conversation: quoted } } } },
      messageTimestamp: 1700000000,
      pushName: 'You',
    };
  }

  /** A store with a context project whose agent has sent `text` to `chatId`. */
  function withSend(chatId: string, text: string) {
    const s = new Store();
    const ctx = s.createProject({ name: 'Ops', kind: 'context' });
    const sess = s.createSession(ctx.id, 'Operator');
    s.recordContextWaSend({ projectId: ctx.id, sessionId: sess.id, chatId, text });
    return s;
  }

  it('note-to-self (own jid, fromMe): the quoted reply reaches the handler, not the pend/timer path', () => {
    const s = withSend(OWN, 'Should I deploy the checkout fix?');
    s.setWhatsappState({ connected: true, jid: OWN });
    const onOperatorReply = vi.fn(async () => true);
    const client = new WhatsAppClient(s, vi.fn(), { onOperatorReply });

    client.ingest(quotedReply(OWN, 'Should I deploy the checkout fix?', 'yes, go ahead', { fromMe: true }));

    expect(onOperatorReply).toHaveBeenCalledTimes(1);
    expect(onOperatorReply).toHaveBeenCalledWith({ chatId: OWN, quotedText: 'Should I deploy the checkout fix?', text: 'yes, go ahead' });
    expect(s.listPendingChats()).toHaveLength(0);
    expect(s.listSchedules().filter(x => x.kind === 'whatsapp-analyze')).toHaveLength(0);
  });

  it('notify DM (different personal number, NOT fromMe): routed the same way', () => {
    const s = withSend(NOTIFY, 'Need permission to push the hotfix.');
    s.setWhatsappState({ connected: true, jid: OWN, notifyJid: NOTIFY });
    const onOperatorReply = vi.fn(async () => true);
    const client = new WhatsAppClient(s, vi.fn(), { onOperatorReply });

    client.ingest(quotedReply(NOTIFY, 'Need permission to push the hotfix.', 'approved'));

    expect(onOperatorReply).toHaveBeenCalledWith({ chatId: NOTIFY, quotedText: 'Need permission to push the hotfix.', text: 'approved' });
    // Without the routing this untracked DM would have been surfaced as pending.
    expect(s.listPendingChats()).toHaveLength(0);
  });

  it('a quote that matches NO recorded send falls through (own chat: shown, never pended)', () => {
    const s = withSend(OWN, 'the real send');
    s.setWhatsappState({ connected: true, jid: OWN });
    const onOperatorReply = vi.fn(async () => true);
    const client = new WhatsAppClient(s, vi.fn(), { onOperatorReply });

    client.ingest(quotedReply(OWN, 'some other message entirely', 'reply', { fromMe: true }));

    expect(onOperatorReply).not.toHaveBeenCalled();
    expect(s.listPendingChats()).toHaveLength(0); // own-chat notes still never pend
  });

  it('a quoted reply in a NON-operator chat takes the normal path (pended, handler untouched)', () => {
    const s = withSend('888@s.whatsapp.net', 'leaked into a client chat'); // even a ring match must not fire here
    s.setWhatsappState({ connected: true, jid: OWN });
    const onOperatorReply = vi.fn(async () => true);
    const client = new WhatsAppClient(s, vi.fn(), { onOperatorReply });

    client.ingest(quotedReply('888@s.whatsapp.net', 'leaked into a client chat', 'a client reply'));

    expect(onOperatorReply).not.toHaveBeenCalled();
    expect(s.listPendingChats().some(c => c.chatId === '888@s.whatsapp.net')).toBe(true); // normal untracked flow
  });

  it('without the onOperatorReply dep, quoted replies behave exactly as before', () => {
    const s = withSend(OWN, 'Should I deploy?');
    s.setWhatsappState({ connected: true, jid: OWN });
    const client = new WhatsAppClient(s, vi.fn()); // no deps at all

    client.ingest(quotedReply(OWN, 'Should I deploy?', 'yes', { fromMe: true }));

    expect(s.listPendingChats()).toHaveLength(0); // own notes: shown, never pended/timed
    expect(s.waMessages(OWN).map(m => m.text)).toEqual(['yes']); // still captured for the view
  });
});
