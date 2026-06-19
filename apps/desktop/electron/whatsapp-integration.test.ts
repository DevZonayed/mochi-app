/* End-to-end wiring: a real WhatsAppClient + real CronRunner + real analyzer.
   An inbound message in a tracked chat arms the quiet timer; when it goes due,
   the cron tick fires the analyzer, which summarizes and sends to the operator's
   own number through the same client socket. Only the engine's summary text is
   stubbed (no LLM) and the socket is a mock (no network) — everything between is
   the production path. This is the closest headless proof of the whole loop;
   scanning a real QR to link a live number needs the operator's phone. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-wa-integration-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir }, powerMonitor: { on: () => {} } }));

import { Store } from './store.js';
import { CronRunner } from './cron.js';
import { WhatsAppClient } from './whatsapp.js';
import { makeWhatsappAnalyzer } from './whatsapp-analyze.js';
import type { LocalEngine } from './engine.js';

function mockSocket(ownId = '15551234567:1@s.whatsapp.net') {
  const handlers: Record<string, Array<(p: unknown) => void>> = {};
  const sent: Array<{ jid: string; text: string }> = [];
  const sock = {
    ev: { on: (e: string, cb: (p: unknown) => void) => { (handlers[e] ||= []).push(cb); } },
    user: { id: ownId },
    sendMessage: async (jid: string, c: { text: string }) => { sent.push({ jid, text: c.text }); return {}; },
    end: () => {},
  };
  return { sock, sent, fire: (e: string, p: unknown) => (handlers[e] || []).forEach(cb => cb(p)) };
}

const msg = (chatId: string, text: string, ts: number) => ({ key: { remoteJid: chatId, fromMe: false, id: text }, message: { conversation: text }, messageTimestamp: ts, pushName: 'Alice' });

beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

describe('WhatsApp quiet-timer — full loop', () => {
  it('captures a tracked chat, resets on activity, then summarizes to self when quiet', async () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    s.setWhatsappState({ sendApproved: true }); // gate already granted
    s.bindChat({ chatId: '111@s.whatsapp.net', name: 'Alice', kind: 'dm', provider: 'whatsapp', projectId: p.id });

    const { sock, sent, fire } = mockSocket();
    const client = new WhatsAppClient(s, vi.fn(), { makeSocket: async () => sock });
    await client.connect();
    fire('connection.update', { connection: 'open' }); // own jid is now known

    const engine = { run: vi.fn() } as unknown as LocalEngine;
    const analyze = makeWhatsappAnalyzer({ store: s, engine, client, emit: vi.fn(), summarize: async () => 'Alice asked to ship; agreed 5pm. Action: ship by 5pm.' });
    const cron = new CronRunner(s, engine, vi.fn(), undefined, analyze) as unknown as { tick(): void };

    // Two messages 100ms apart: the second RESETS the timer (still one timer).
    client.ingest(msg('111@s.whatsapp.net', 'can we ship today?', 1700000000));
    client.ingest(msg('111@s.whatsapp.net', 'before 6 ideally', 1700000100));
    const timers = s.listSchedules().filter(x => x.kind === 'whatsapp-analyze');
    expect(timers).toHaveLength(1);

    // Ticking now must NOT fire (the chat isn't quiet yet).
    cron.tick();
    expect(sent).toHaveLength(0);

    // 15 minutes elapse with no new messages → the timer is due.
    s.updateSchedule(timers[0].id, { fireAt: Date.now() - 1000 });
    cron.tick();

    // The analyzer runs fire-and-forget; wait for the send to land.
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0].jid).toBe('15551234567@s.whatsapp.net'); // the operator's own number
    expect(sent[0].text).toMatch(/5pm/);
    // One-shot consumed; the watermark advanced so it won't re-summarize the same period.
    expect(s.listSchedules().find(x => x.kind === 'whatsapp-analyze')!.enabled).toBe(false);
    expect(s.getWaTranscript('111@s.whatsapp.net', { sinceReported: true })).toHaveLength(0);
  });
});
