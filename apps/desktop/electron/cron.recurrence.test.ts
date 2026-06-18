/* Recurrence + catch-up for the schedule engine. Only app.getPath is mocked;
   Store + CronRunner are production code (see cron.message.test.ts). */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-recur-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';
import { CronRunner, nextOccurrence } from './cron.js';
import type { LocalEngine } from './engine.js';

function makeEngine() {
  const run = vi.fn().mockResolvedValue(undefined);
  return { engine: { run } as unknown as LocalEngine, run };
}

describe('Schedule model — interval + catch-up fields', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('persists everyMinutes/anchorAt/catchUp/catchUpWindowMs across a reload', () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    const rec = s.createSchedule({
      projectId: p.id, title: 'Every 2h', prompt: 'do it',
      everyMinutes: 120, anchorAt: 1_000, catchUp: true, catchUpWindowMs: 3_600_000,
    });
    expect(rec.everyMinutes).toBe(120);

    const reloaded = new Store();
    const got = reloaded.listSchedules()[0];
    expect(got.everyMinutes).toBe(120);
    expect(got.anchorAt).toBe(1_000);
    expect(got.catchUp).toBe(true);
    expect(got.catchUpWindowMs).toBe(3_600_000);
  });

  it('updateSchedule patches recurrence + content fields', () => {
    const s = new Store();
    const rec = s.createSchedule({ title: 'x', time: '09:00', cadence: 'daily' });
    const up = s.updateSchedule(rec.id, { title: 'renamed', time: '10:30', cadence: 'weekdays', prompt: 'new prompt', catchUp: true });
    expect(up.title).toBe('renamed');
    expect(up.time).toBe('10:30');
    expect(up.cadence).toBe('weekdays');
    expect(up.prompt).toBe('new prompt');
    expect(up.catchUp).toBe(true);
  });
});

describe('nextOccurrence — interval mode', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  function intervalSchedule(everyMinutes: number, anchorAt: number) {
    return { id: 'i', projectId: null, title: 't', time: '', cadence: 'interval',
      enabled: true, nextRun: null, createdAt: anchorAt, everyMinutes, anchorAt } as never;
  }

  it('returns the next slot strictly after `from`, anchored to anchorAt', () => {
    const anchor = 1_000_000;
    const s = intervalSchedule(120, anchor); // every 2h = 7_200_000 ms
    expect(nextOccurrence(s, anchor)).toBe(anchor + 7_200_000);            // exactly at anchor -> next slot
    expect(nextOccurrence(s, anchor + 100)).toBe(anchor + 7_200_000);      // mid-slot -> next slot
    expect(nextOccurrence(s, anchor + 7_200_000)).toBe(anchor + 2 * 7_200_000); // on a slot -> strictly after
    expect(nextOccurrence(s, anchor + 7_200_001)).toBe(anchor + 2 * 7_200_000);
  });

  it('falls back to createdAt when anchorAt is absent', () => {
    const created = 5_000_000;
    const s = { id: 'i', projectId: null, title: 't', time: '', cadence: 'interval',
      enabled: true, nextRun: null, createdAt: created, everyMinutes: 60 } as never;
    expect(nextOccurrence(s, created + 10)).toBe(created + 3_600_000);
  });
});

describe('CronRunner — catch-up for missed clock-mode slots', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  /** A daily schedule whose nextRun is already 2h in the past (a missed slot). */
  function missedDaily(s: Store, projectId: string, catchUp: boolean) {
    const rec = s.createSchedule({ projectId, title: 'Morning', prompt: 'run me', time: '09:00', cadence: 'daily', catchUp });
    // Simulate the slot having come due while the app was closed.
    s.setScheduleNextRun(rec.id, Date.now() - 2 * 60 * 60_000);
    return rec;
  }

  it('catches up a missed slot once when catchUp is on (within window), marking it late', () => {
    const s = new Store();
    const project = s.createProject({ name: 'P' });
    const { engine, run } = makeEngine();
    const emit = vi.fn();
    const cron = new CronRunner(s, engine, emit) as unknown as { tick(): void };

    missedDaily(s, project.id, true);
    cron.tick();

    expect(run).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('schedule-late', expect.objectContaining({ title: 'Morning' }));
    const sched = s.listSchedules()[0];
    expect(sched.lastFireLate).toBe(true);
    expect(sched.lastRun).toBeTruthy();
  });

  it('does not catch up the same missed slot twice (lastDueAt dedupe)', () => {
    const s = new Store();
    const project = s.createProject({ name: 'P' });
    const { engine, run } = makeEngine();
    const cron = new CronRunner(s, engine, vi.fn()) as unknown as { tick(): void };

    missedDaily(s, project.id, true);
    cron.tick();
    cron.tick();

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does NOT catch up when catchUp is off — rolls forward, no fire', () => {
    const s = new Store();
    const project = s.createProject({ name: 'P' });
    const { engine, run } = makeEngine();
    const cron = new CronRunner(s, engine, vi.fn()) as unknown as { tick(): void };

    missedDaily(s, project.id, false);
    cron.tick();

    expect(run).not.toHaveBeenCalled();
    const sched = s.listSchedules()[0];
    expect(sched.nextRun).toBeGreaterThan(Date.now()); // rolled forward
  });

  it('does NOT catch up past the window — rolls forward, no fire', () => {
    const s = new Store();
    const project = s.createProject({ name: 'P' });
    const { engine, run } = makeEngine();
    const cron = new CronRunner(s, engine, vi.fn()) as unknown as { tick(): void };

    const rec = s.createSchedule({ projectId: project.id, title: 'Tiny window', prompt: 'x', time: '09:00', cadence: 'daily', catchUp: true, catchUpWindowMs: 60_000 });
    s.setScheduleNextRun(rec.id, Date.now() - 2 * 60 * 60_000); // 2h late, window only 1min
    cron.tick();

    expect(run).not.toHaveBeenCalled();
  });
});
