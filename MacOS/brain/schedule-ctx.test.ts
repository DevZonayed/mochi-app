/* ScheduleCtx — the in-process bridge the agent's mcp__maestro__schedule_* tools
   call. Exercised against the real Store + CronRunner; only app.getPath mocked. */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-schedctx-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';
import { CronRunner } from './cron.js';
import { makeScheduleCtx } from './schedule-ctx.js';
import type { LocalEngine } from './engine.js';

function makeEngine() { const run = vi.fn().mockResolvedValue(undefined); return { engine: { run } as unknown as LocalEngine, run }; }

describe('makeScheduleCtx', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  it('creates an interval schedule and lists it with a human recurrence', () => {
    const s = new Store();
    const p = s.createProject({ name: 'WhatsApp' });
    const { engine } = makeEngine();
    const ctx = makeScheduleCtx(s, new CronRunner(s, engine, vi.fn()));

    const created = ctx.create({ projectId: p.id, title: 'Every 3h', prompt: 'check', recurrence: { everyMinutes: 180 } });
    expect(created.everyMinutes).toBe(180);

    const list = ctx.list({});
    expect(list).toHaveLength(1);
    expect(list[0].recurrence).toMatch(/every 3h/i);
  });

  it('creates a daily catch-up schedule from {time, cadence}', () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    const ctx = makeScheduleCtx(s, new CronRunner(s, makeEngine().engine, vi.fn()));
    const created = ctx.create({ projectId: p.id, title: 'Morning', prompt: 'do it', recurrence: { time: '09:00', cadence: 'daily' }, catchUp: true });
    expect(created.time).toBe('09:00');
    expect(created.catchUp).toBe(true);
  });

  it('updates, toggles, and deletes', () => {
    const s = new Store();
    const ctx = makeScheduleCtx(s, new CronRunner(s, makeEngine().engine, vi.fn()));
    const rec = ctx.create({ title: 'x', prompt: 'p', recurrence: { time: '08:00', cadence: 'daily' } });
    expect(ctx.update(rec.id, { title: 'renamed', prompt: 'p2' }).title).toBe('renamed');
    ctx.toggle(rec.id, false);
    expect(ctx.list({})[0].enabled).toBe(false);
    ctx.del(rec.id);
    expect(ctx.list({})).toHaveLength(0);
  });

  it('runNow fires the schedule immediately through the engine', () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    const sess = s.createSession(p.id, 'Chat');
    const { engine, run } = makeEngine();
    const ctx = makeScheduleCtx(s, new CronRunner(s, engine, vi.fn()));
    const rec = ctx.create({ projectId: p.id, sessionId: sess.id, title: 'now', prompt: 'go', recurrence: { time: '09:00', cadence: 'daily' } });
    expect(ctx.runNow(rec.id)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('filters list by project', () => {
    const s = new Store();
    const a = s.createProject({ name: 'A' });
    const b = s.createProject({ name: 'B' });
    const ctx = makeScheduleCtx(s, new CronRunner(s, makeEngine().engine, vi.fn()));
    ctx.create({ projectId: a.id, title: 'in-a', prompt: 'p', recurrence: { time: '08:00', cadence: 'daily' } });
    ctx.create({ projectId: b.id, title: 'in-b', prompt: 'p', recurrence: { time: '08:00', cadence: 'daily' } });
    expect(ctx.list({ projectId: a.id }).map(x => x.title)).toEqual(['in-a']);
  });

  it('lists projects (with hasMemory + sessionCount) and their sessions', () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    s.createSession(p.id, 'Chat A');
    const ctx = makeScheduleCtx(s, new CronRunner(s, makeEngine().engine, vi.fn()));
    const projects = ctx.listProjects();
    const mine = projects.find(x => x.id === p.id);
    expect(mine?.name).toBe('P');
    expect(mine?.sessionCount).toBe(1);
    expect(typeof mine?.hasMemory).toBe('boolean');
    expect(ctx.listSessions(p.id).map(x => x.title)).toContain('Chat A');
  });
});
