/* Cron-runner dispatch for the two auto-recovery schedule kinds:
   - 'keep-going' fires the organized auto-continue prompt into its session
     (image_0ss8f.png scenario)
   - 'retry-run'  fires a fresh attempt of a failed (transient) job after the
     exponential backoff window (image_ni4jn.png scenario)
   Same one-shot semantics as 'message' / 'auto-continue': fires once at
   fireAt, disables itself, never double-fires. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-cron-recovery-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';
import { CronRunner } from './cron.js';
import type { LocalEngine } from './engine.js';

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

describe('CronRunner — keep-going dispatch', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('fires a due keep-going schedule into the session with the auto-continue prompt + auto-continue title prefix', () => {
    const { s, project, session } = setup();
    const { engine, run } = makeEngine();
    const cron = new CronRunner(s, engine, vi.fn()) as unknown as { tick(): void };

    const prompt = '[Auto-continue]: pick the next sprint and ship it.';
    s.createSchedule({
      projectId: project.id, sessionId: session.id,
      kind: 'keep-going', title: 'Auto-continue (want me to keep going?)',
      prompt, fireAt: Date.now() - 1_000, effort: 'deep',
    });

    cron.tick();

    expect(run).toHaveBeenCalledTimes(1);
    const jobs = s.listJobs(project.id, session.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].input).toBe(prompt);
    expect(jobs[0].title).toMatch(/^Auto-continue:/);
    expect(jobs[0].effort).toBe('deep');
    expect(s.listSchedules()[0].enabled).toBe(false); // one-shot consumed
  });
});

describe('CronRunner — retry-run dispatch', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('fires a due retry-run with the failed input + N/10 title prefix', () => {
    const { s, project, session } = setup();
    const { engine, run } = makeEngine();
    const cron = new CronRunner(s, engine, vi.fn()) as unknown as { tick(): void };

    s.createSchedule({
      projectId: project.id, sessionId: session.id,
      kind: 'retry-run', title: 'Auto-retry (3/10) in 3 min',
      prompt: 'original user input that hit a transient error',
      fireAt: Date.now() - 1_000, effort: 'balanced',
      retryAttempt: 3, sourceJobId: 'job-orig',
    });

    cron.tick();

    expect(run).toHaveBeenCalledTimes(1);
    const jobs = s.listJobs(project.id, session.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].input).toBe('original user input that hit a transient error');
    expect(jobs[0].title).toMatch(/^Auto-retry \(3\/10\):/);
    expect(s.listSchedules()[0].enabled).toBe(false); // one-shot consumed
  });

  it('does NOT double-fire across two ticks (one attempt = one job)', () => {
    const { s, project, session } = setup();
    const { engine, run } = makeEngine();
    const cron = new CronRunner(s, engine, vi.fn()) as unknown as { tick(): void };

    s.createSchedule({
      projectId: project.id, sessionId: session.id,
      kind: 'retry-run', title: 'Auto-retry (1/10) in 1 min',
      prompt: 'p', fireAt: Date.now() - 1_000, retryAttempt: 1, sourceJobId: 'j1',
    });

    cron.tick();
    cron.tick();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('reloading the store preserves the retry-run kind + retryAttempt + sourceJobId', () => {
    const { s, project, session } = setup();
    s.createSchedule({
      projectId: project.id, sessionId: session.id,
      kind: 'retry-run', title: 'Auto-retry (5/10) in 5 min',
      prompt: 'p', fireAt: Date.now() + 5 * 60_000, retryAttempt: 5, sourceJobId: 'job-XYZ',
    });
    const reloaded = new Store();
    const sched = reloaded.listSchedules()[0];
    expect(sched.kind).toBe('retry-run');
    expect(sched.retryAttempt).toBe(5);
    expect(sched.sourceJobId).toBe('job-XYZ');
  });
});
