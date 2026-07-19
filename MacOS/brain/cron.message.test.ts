/* Scheduled message: a one-shot Schedule with kind:'message' fires a real chat
   job into its session at fireAt, carrying the composer intent (effort/browser),
   then disables itself. Only `app.getPath` is mocked — Store + CronRunner are the
   production code path; the engine is a spy so we can assert how the job is run. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-cron-msg-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';
import { CronRunner } from './cron.js';
import type { LocalEngine } from './engine.js';

/** Minimal engine spy that records run() opts; CronRunner only calls run(). */
function makeEngine() {
  const run = vi.fn().mockResolvedValue(undefined);
  return { engine: { run } as unknown as LocalEngine, run };
}

function setup() {
  const s = new Store();
  const project = s.createProject({ name: 'Proj' });
  const session = s.createSession(project.id, 'Chat');
  return { s, project, session };
}

describe('CronRunner — scheduled message', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('fires a due message once, into the session, with its effort + browser, then disables', () => {
    const { s, project, session } = setup();
    const { engine, run } = makeEngine();
    const emit = vi.fn();
    const cron = new CronRunner(s, engine, emit);

    s.createSchedule({
      projectId: project.id, sessionId: session.id,
      title: 'Ship it', prompt: 'Ship the release now', fireAt: Date.now() - 1_000,
      kind: 'message', effort: 'deep', browser: true,
    });

    (cron as unknown as { tick(): void }).tick();

    // The engine ran exactly once; the job carries the captured composer intent
    // and the P0 lease resolves it inside engine.run.
    expect(run).toHaveBeenCalledTimes(1);
    const opts = run.mock.calls[0][1];
    expect(opts).toEqual({});

    // A real chat job landed in the session with the message text + effort.
    const jobs = s.listJobs(project.id, session.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].input).toBe('Ship the release now');
    expect(jobs[0].effort).toBe('deep');
    expect(jobs[0].sessionId).toBe(session.id);
    expect(jobs[0].intent).toMatchObject({ schemaVersion: 1, effort: 'deep', browser: true });

    // One-shot: it disabled itself and recorded the run (no re-fire).
    const sched = s.listSchedules()[0];
    expect(sched.enabled).toBe(false);
    expect(sched.lastRun).toBeTruthy();
  });

  it('fires a due message with full canonical intent, including explicit off/false', () => {
    const { s, project, session } = setup();
    const { engine, run } = makeEngine();
    const cron = new CronRunner(s, engine, vi.fn());

    s.createSchedule({
      projectId: project.id, sessionId: session.id,
      title: 'Plan off', prompt: 'continue', fireAt: Date.now() - 1_000,
      kind: 'message',
      intent: {
        effort: 'deep',
        engine: 'codex',
        model: 'gpt-5',
        reviewer: 'off',
        plan: false,
        goal: true,
        browser: false,
      },
    });

    (cron as unknown as { tick(): void }).tick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toEqual({});
    expect(s.listJobs(project.id, session.id)[0].intent).toEqual({
      schemaVersion: 1,
      effort: 'deep',
      engine: 'codex',
      model: 'gpt-5',
      reviewer: 'off',
      plan: false,
      goal: true,
      browser: false,
    });
  });

  it('does not fire a message whose time is still in the future', () => {
    const { s, project, session } = setup();
    const { engine, run } = makeEngine();
    const cron = new CronRunner(s, engine, vi.fn());

    const future = Date.now() + 60 * 60_000;
    s.createSchedule({ projectId: project.id, sessionId: session.id, title: 'Later', prompt: 'do it later', fireAt: future, kind: 'message' });

    (cron as unknown as { tick(): void }).tick();

    expect(run).not.toHaveBeenCalled();
    expect(s.listJobs(project.id, session.id)).toHaveLength(0);
    const sched = s.listSchedules()[0];
    expect(sched.enabled).toBe(true);          // still pending
    expect(sched.nextRun).toBe(future);        // surfaced for the countdown
  });

  it('does not double-fire across two ticks', () => {
    const { s, project, session } = setup();
    const { engine, run } = makeEngine();
    const cron = new CronRunner(s, engine, vi.fn()) as unknown as { tick(): void };

    s.createSchedule({ projectId: project.id, sessionId: session.id, title: 'Once', prompt: 'only once', fireAt: Date.now() - 1_000, kind: 'message' });

    cron.tick();
    cron.tick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(s.listJobs(project.id, session.id)).toHaveLength(1);
  });

  it('manual fireNow creates a fresh job for each explicit run', () => {
    const { s, project, session } = setup();
    const { engine, run } = makeEngine();
    const cron = new CronRunner(s, engine, vi.fn());

    const sched = s.createSchedule({
      projectId: project.id, sessionId: session.id,
      title: 'Manual repeat', prompt: 'run this now',
      fireAt: Date.now() + 60 * 60_000,
      kind: 'message',
    });

    expect(cron.fireNow(sched.id)).toBe(true);
    expect(cron.fireNow(sched.id)).toBe(true);

    expect(run).toHaveBeenCalledTimes(2);
    const jobs = s.listJobs(project.id, session.id);
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map(j => j.id)).size).toBe(2);
  });

  it('persists kind/effort/browser and a fresh Store reads them back', () => {
    const { s, project, session } = setup();
    s.createSchedule({ projectId: project.id, sessionId: session.id, title: 'persist', prompt: 'persist me', fireAt: Date.now() + 120_000, kind: 'message', effort: 'fast', browser: true });

    const reloaded = new Store();
    const sched = reloaded.listSchedules()[0];
    expect(sched.kind).toBe('message');
    expect(sched.effort).toBe('fast');
    expect(sched.browser).toBe(true);
    expect(sched.fireAt).toBeTruthy();
  });

  it('fires an auto-continue schedule, sending the continue prompt into its session', () => {
    const { s, project, session } = setup();
    const { engine, run } = makeEngine();
    const cron = new CronRunner(s, engine, vi.fn()) as unknown as { tick(): void };

    s.createSchedule({
      projectId: project.id, sessionId: session.id,
      title: 'Continue when Claude limit resets', prompt: 'Continue exactly where you left off and finish the task.',
      fireAt: Date.now() - 1_000, kind: 'auto-continue',
    });

    cron.tick();

    expect(run).toHaveBeenCalledTimes(1);
    const jobs = s.listJobs(project.id, session.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].input).toMatch(/continue exactly where you left off/i);
    expect(jobs[0].sessionId).toBe(session.id);
    expect(s.listSchedules()[0].enabled).toBe(false); // one-shot consumed
  });

  it('fires a due auto-answer (AskUserQuestion timeout) into its session', () => {
    const { s, project, session } = setup();
    const { engine, run } = makeEngine();
    const cron = new CronRunner(s, engine, vi.fn()) as unknown as { tick(): void };

    s.createSchedule({
      projectId: project.id, sessionId: session.id, kind: 'auto-answer',
      title: 'Auto-answer question', prompt: '[User answered AskUserQuestion]: Use a recommended default',
      fireAt: Date.now() - 1_000, armedAt: Date.now() - 5 * 60_000, extends: 0,
    });

    cron.tick();

    expect(run).toHaveBeenCalledTimes(1);
    const jobs = s.listJobs(project.id, session.id);
    expect(jobs[0].input).toMatch(/^\[User answered AskUserQuestion\]:/);
    expect(s.listSchedules()[0].enabled).toBe(false);
  });

  it('does not fire an orphan-cleaned auto-answer after restart', () => {
    const { s, project, session } = setup();
    const orphan = s.createJob(project.id, 'ask', 'ask', undefined, session.id);
    s.updateJob(orphan.id, { status: 'running' });
    s.createSchedule({
      projectId: project.id, sessionId: session.id, kind: 'auto-answer',
      sourceJobId: orphan.id,
      title: 'Auto-answer orphan', prompt: '[User answered AskUserQuestion]: Use a recommended default',
      fireAt: Date.now() - 1_000, armedAt: Date.now() - 5 * 60_000, extends: 0,
    });

    expect(s.settleOrphanedRuns().failed).toHaveLength(1);
    const reloaded = new Store();
    const { engine, run } = makeEngine();
    const cron = new CronRunner(reloaded, engine, vi.fn()) as unknown as { tick(): void };

    cron.tick();

    expect(run).not.toHaveBeenCalled();
    expect(reloaded.listJobs(project.id, session.id)).toHaveLength(1);
    expect(reloaded.listSchedules()[0].enabled).toBe(false);
  });

  it('never fires a paused auto-answer (user extended past the cap)', () => {
    const { s, project, session } = setup();
    const { engine, run } = makeEngine();
    const cron = new CronRunner(s, engine, vi.fn()) as unknown as { tick(): void };

    const sched = s.createSchedule({
      projectId: project.id, sessionId: session.id, kind: 'auto-answer',
      title: 'Auto-answer question', prompt: '[User answered AskUserQuestion]: A',
      fireAt: Date.now() - 1_000, armedAt: Date.now() - 60_000,
    });
    s.updateSchedule(sched.id, { paused: true });

    cron.tick();

    expect(run).not.toHaveBeenCalled();
    expect(s.listJobs(project.id, session.id)).toHaveLength(0);
    expect(s.listSchedules()[0].enabled).toBe(true);  // still pending a manual reply
    expect(s.listSchedules()[0].paused).toBe(true);
  });
});
