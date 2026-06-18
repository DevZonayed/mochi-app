/* The quiet-timer is a per-chat one-shot Schedule (kind:'whatsapp-analyze'). An
   inbound message ARMS it (fireAt = now + 15 min); a later message in the same
   chat RESETS the same schedule (no second timer); CronRunner fires it once when
   it finally goes quiet, routing to an injected analyzer (not a normal chat job).
   Only `app.getPath` is mocked — Store + CronRunner are the production path. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-wa-timer-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';
import { CronRunner } from './cron.js';
import { WHATSAPP_QUIET_MS } from './whatsapp-quiet.js';
import type { LocalEngine } from './engine.js';
import type { Schedule } from './store.js';

function makeEngine() {
  const run = vi.fn().mockResolvedValue(undefined);
  return { engine: { run } as unknown as LocalEngine, run };
}

function setup() {
  const s = new Store();
  const project = s.createProject({ name: 'Proj' });
  const session = s.createSession(project.id, 'WA chat');
  return { s, project, session };
}

describe('Store.armWhatsappTimer — per-chat quiet timer', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('arms a 15-minute one-shot whatsapp-analyze schedule carrying chat + session', () => {
    const { s, project, session } = setup();
    const before = Date.now();
    const sched = s.armWhatsappTimer({ chatId: '111@s.whatsapp.net', projectId: project.id, sessionId: session.id });

    expect(sched.kind).toBe('whatsapp-analyze');
    expect(sched.chatId).toBe('111@s.whatsapp.net');
    expect(sched.sessionId).toBe(session.id);
    expect(sched.projectId).toBe(project.id);
    expect(sched.enabled).toBe(true);
    // ~15 minutes out (allow a little slack for the test clock).
    expect(sched.fireAt).toBeGreaterThanOrEqual(before + WHATSAPP_QUIET_MS - 50);
    expect(sched.fireAt).toBeLessThanOrEqual(Date.now() + WHATSAPP_QUIET_MS + 50);
    expect(s.listSchedules()).toHaveLength(1);
  });

  it('a second message in the same chat RESETS the same timer (no second schedule)', () => {
    const { s, project, session } = setup();
    const first = s.armWhatsappTimer({ chatId: '111@s.whatsapp.net', projectId: project.id, sessionId: session.id });
    const firstFireAt = first.fireAt!;

    // …time passes, another message arrives…
    const second = s.armWhatsappTimer({ chatId: '111@s.whatsapp.net', projectId: project.id, sessionId: session.id });

    expect(s.listSchedules()).toHaveLength(1);     // still ONE timer for this chat
    expect(second.id).toBe(first.id);              // the SAME schedule, reset
    expect(second.fireAt!).toBeGreaterThanOrEqual(firstFireAt); // pushed forward
  });

  it('arming a different chat creates a separate timer', () => {
    const { s, project, session } = setup();
    s.armWhatsappTimer({ chatId: '111@s.whatsapp.net', projectId: project.id, sessionId: session.id });
    s.armWhatsappTimer({ chatId: '222@s.whatsapp.net', projectId: project.id, sessionId: session.id });
    expect(s.listSchedules()).toHaveLength(2);
  });
});

describe('CronRunner — whatsapp-analyze firing', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('fires a due quiet timer once via the injected analyzer, then disables it', () => {
    const { s, project, session } = setup();
    const { engine, run } = makeEngine();
    const analyze = vi.fn();
    const cron = new CronRunner(s, engine, vi.fn(), undefined, analyze) as unknown as { tick(): void };

    const sched = s.armWhatsappTimer({ chatId: '111@s.whatsapp.net', projectId: project.id, sessionId: session.id });
    // make it due
    s.updateSchedule(sched.id, { fireAt: Date.now() - 1_000 });

    cron.tick();
    cron.tick(); // must not double-fire

    expect(analyze).toHaveBeenCalledTimes(1);
    expect((analyze.mock.calls[0][0] as Schedule).chatId).toBe('111@s.whatsapp.net');
    // It routes to the analyzer, NOT a normal chat job.
    expect(run).not.toHaveBeenCalled();
    expect(s.listJobs(project.id, session.id)).toHaveLength(0);
    expect(s.listSchedules()[0].enabled).toBe(false); // one-shot consumed
  });

  it('does not fire a quiet timer whose 15 minutes have not elapsed', () => {
    const { s, project, session } = setup();
    const analyze = vi.fn();
    const cron = new CronRunner(s, makeEngine().engine, vi.fn(), undefined, analyze) as unknown as { tick(): void };

    s.armWhatsappTimer({ chatId: '111@s.whatsapp.net', projectId: project.id, sessionId: session.id });
    cron.tick();

    expect(analyze).not.toHaveBeenCalled();
    expect(s.listSchedules()[0].enabled).toBe(true); // still counting down
  });
});
