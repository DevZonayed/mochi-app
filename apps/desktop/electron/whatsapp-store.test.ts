/* WhatsApp store surface: connection state, the per-chat captured message log
   with a "since last reported" watermark (so a quiet period is summarized once),
   and ChatBinding carrying provider + the session it's filed under. Only
   `app.getPath` is mocked; Store is the production path. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-wa-store-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

describe('Store — WhatsApp connection state', () => {
  it('defaults to disconnected and not send-approved', () => {
    const s = new Store();
    const st = s.whatsappState();
    expect(st.connected).toBe(false);
    expect(st.jid).toBe(null);
    expect(st.sendApproved).toBe(false);
  });

  it('round-trips a patch and persists across a reload', () => {
    const s = new Store();
    s.setWhatsappState({ connected: true, jid: '15551234567@s.whatsapp.net', name: 'Me', linkedAt: 1000 });
    expect(s.whatsappState().connected).toBe(true);
    const reloaded = new Store();
    expect(reloaded.whatsappState().jid).toBe('15551234567@s.whatsapp.net');
    expect(reloaded.whatsappState().name).toBe('Me');
  });
});

describe('Store — captured WhatsApp messages', () => {
  it('records messages per chat, newest read in order, updating lastMessageAt', () => {
    const s = new Store();
    s.recordWaMessage({ chatId: 'c1', name: 'Alice', kind: 'dm', fromMe: false, senderName: 'Alice', text: 'hi', ts: 100 });
    s.recordWaMessage({ chatId: 'c1', fromMe: true, senderName: 'Me', text: 'hello', ts: 200 });

    const t = s.getWaTranscript('c1');
    expect(t.map(m => m.text)).toEqual(['hi', 'hello']);
    const chat = s.listWaChats().find(c => c.chatId === 'c1')!;
    expect(chat.name).toBe('Alice');
    expect(chat.lastMessageAt).toBe(200);
  });

  it('caps a chat log so it cannot grow without bound', () => {
    const s = new Store();
    for (let i = 0; i < 350; i++) s.recordWaMessage({ chatId: 'c1', fromMe: false, senderName: 'A', text: `m${i}`, ts: i });
    expect(s.getWaTranscript('c1').length).toBeLessThanOrEqual(300);
    // The most recent message survives the cap.
    expect(s.getWaTranscript('c1').at(-1)!.text).toBe('m349');
  });

  it('"since last reported" returns only messages after the watermark', () => {
    const s = new Store();
    s.recordWaMessage({ chatId: 'c1', fromMe: false, senderName: 'A', text: 'old', ts: 100 });
    s.markWaReported('c1', 150);
    s.recordWaMessage({ chatId: 'c1', fromMe: false, senderName: 'A', text: 'new', ts: 200 });

    expect(s.getWaTranscript('c1', { sinceReported: true }).map(m => m.text)).toEqual(['new']);
    expect(s.getWaTranscript('c1').map(m => m.text)).toEqual(['old', 'new']); // full log unaffected
  });
});

describe('Store — ChatBinding provider + session', () => {
  it('binds a WhatsApp chat to a project AND a session', () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    const sess = s.createSession(p.id, 'Chat');
    const b = s.bindChat({ chatId: 'c1', name: 'Alice', kind: 'dm', provider: 'whatsapp', projectId: p.id, sessionId: sess.id });
    expect(b.provider).toBe('whatsapp');
    expect(b.sessionId).toBe(sess.id);
    expect(s.getChatBinding('c1')!.sessionId).toBe(sess.id);
  });

  it('defaults provider to telegram for back-compat when unspecified', () => {
    const s = new Store();
    const b = s.bindChat({ chatId: '99', name: 'Bob', kind: 'dm' });
    expect(b.provider).toBe('telegram');
  });
});
