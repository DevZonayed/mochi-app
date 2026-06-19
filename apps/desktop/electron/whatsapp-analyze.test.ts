/* When a tracked WhatsApp chat goes quiet, CronRunner fires the analyzer: it
   reads what's new since the last report, summarizes it, and — once the operator
   has approved sending — messages the summary to their own number. The first
   summary is HELD behind the send gate and flushed on approval. The real engine
   is injected here as a stub `summarize`; the client is a spy. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-wa-analyze-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir }, powerMonitor: { on: () => {} } }));

import { Store } from './store.js';
import type { LocalEngine } from './engine.js';
import { makeWhatsappAnalyzer, approveWhatsappSend, flushSummaries } from './whatsapp-analyze.js';

/** A send spy. `failFirst: n` makes the first n sends fail (simulating the socket
    not being reconnected yet after a wake) before succeeding. */
function sendSpy(opts: { failFirst?: number } = {}) {
  const sent: string[] = []; let calls = 0;
  return { client: { sendToSelf: async (t: string) => { calls++; if (calls <= (opts.failFirst ?? 0)) return false; sent.push(t); return true; } }, sent };
}

function setup() {
  const s = new Store();
  const p = s.createProject({ name: 'P' });
  s.bindChat({ chatId: 'c1', name: 'Alice', kind: 'dm', provider: 'whatsapp', projectId: p.id });
  s.recordWaMessage({ chatId: 'c1', name: 'Alice', fromMe: false, senderName: 'Alice', text: 'can you ship today?', ts: 1000 });
  s.recordWaMessage({ chatId: 'c1', fromMe: true, senderName: 'You', text: 'yes, by 5pm', ts: 2000 });
  const engine = { run: vi.fn() } as unknown as LocalEngine;
  return { s, p, engine };
}

const fixedSummary = async () => 'Alice asked about shipping; you committed to 5pm. Action: ship by 5pm.';

beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

describe('whatsapp analyzer', () => {
  it('once approved, sends the summary to the own number and advances the watermark', async () => {
    const { s, engine } = setup();
    s.setWhatsappState({ sendApproved: true });
    const { client, sent } = sendSpy();
    const analyze = makeWhatsappAnalyzer({ store: s, engine, client, emit: vi.fn(), summarize: fixedSummary });

    await analyze(s.armWhatsappTimer({ chatId: 'c1', projectId: null }));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/5pm/);
    expect(sent[0]).toMatch(/Alice/); // chat name in the header
    // watermark advanced past the newest message → a re-fire summarizes nothing
    expect(s.getWaTranscript('c1', { sinceReported: true })).toHaveLength(0);
  });

  it('holds the summary behind the gate when sending is not yet approved', async () => {
    const { s, engine } = setup();
    const { client, sent } = sendSpy();
    const analyze = makeWhatsappAnalyzer({ store: s, engine, client, emit: vi.fn(), summarize: fixedSummary });

    await analyze(s.armWhatsappTimer({ chatId: 'c1', projectId: null }));

    expect(sent).toHaveLength(0);                       // nothing sent silently
    expect(s.listPendingSummaries()).toHaveLength(1);   // queued in the durable outbox
    expect(s.listPendingSummaries()[0].text).toMatch(/5pm/);
  });

  it('survives a failed send (socket down on wake) and delivers on the next flush', async () => {
    const { s, engine } = setup();
    s.setWhatsappState({ sendApproved: true });
    const { client, sent } = sendSpy({ failFirst: 1 }); // first send fails (not reconnected yet)
    const analyze = makeWhatsappAnalyzer({ store: s, engine, client, emit: vi.fn(), summarize: fixedSummary });

    await analyze(s.armWhatsappTimer({ chatId: 'c1', projectId: null }));
    expect(sent).toHaveLength(0);                        // send failed…
    expect(s.listPendingSummaries()).toHaveLength(1);    // …but it's NOT lost — still queued
    // watermark still advanced (we won't re-summarize), but the summary text is durable
    expect(s.getWaTranscript('c1', { sinceReported: true })).toHaveLength(0);

    await flushSummaries({ store: s, client, emit: vi.fn() }); // socket back → retry
    expect(sent).toHaveLength(1);
    expect(s.listPendingSummaries()).toHaveLength(0);    // delivered + drained
  });

  it('does nothing when there is no new activity since the last report', async () => {
    const { s, engine } = setup();
    s.setWhatsappState({ sendApproved: true });
    s.markWaReported('c1', 9999); // everything already reported
    const summarize = vi.fn(fixedSummary);
    const { client, sent } = sendSpy();
    const analyze = makeWhatsappAnalyzer({ store: s, engine, client, emit: vi.fn(), summarize });

    await analyze(s.armWhatsappTimer({ chatId: 'c1', projectId: null }));

    expect(summarize).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it('approveWhatsappSend flips the gate and flushes the held summary once', async () => {
    const { s, engine } = setup();
    const { client, sent } = sendSpy();
    const analyze = makeWhatsappAnalyzer({ store: s, engine, client, emit: vi.fn(), summarize: fixedSummary });
    await analyze(s.armWhatsappTimer({ chatId: 'c1', projectId: null })); // held

    await approveWhatsappSend({ store: s, client, emit: vi.fn() });

    expect(s.whatsappState().sendApproved).toBe(true);
    expect(sent).toHaveLength(1);                       // the held summary went out
    expect(s.listPendingSummaries()).toHaveLength(0);   // outbox drained
  });
});
