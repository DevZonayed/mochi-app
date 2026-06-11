/* Schedule runner — enabled schedules fire ON THIS MAC at their HH:MM
   (daily, or weekly on the weekday they were created). Each firing creates a
   real job and runs it through the local engine, so scheduled work shows up
   in Jobs / the phone exactly like a hand-started run.

   Forward-only: schedules never retro-fire for times missed while the app was
   closed; the next occurrence is computed from "now" at launch. */

import type { Store, Schedule } from './store.js';
import type { LocalEngine } from './engine.js';

const TICK_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseHHMM(time: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, m: mi };
}

/** Next occurrence of the schedule strictly after `from`. */
export function nextOccurrence(s: Schedule, from: number): number | null {
  const hm = parseHHMM(s.time);
  if (!hm) return null;
  const d = new Date(from);
  d.setHours(hm.h, hm.m, 0, 0);
  if (s.cadence === 'weekly') {
    const anchorDay = new Date(s.createdAt).getDay();
    while (d.getDay() !== anchorDay || d.getTime() <= from) d.setTime(d.getTime() + DAY_MS);
    return d.getTime();
  }
  // daily (and any unknown cadence treated as daily)
  if (d.getTime() <= from) d.setTime(d.getTime() + DAY_MS);
  return d.getTime();
}

export class CronRunner {
  private timer: ReturnType<typeof setInterval> | null = null;

  /** firePublish: optional hook to export scheduled publish drafts whose time has come. */
  constructor(private store: Store, private engine: LocalEngine, private emit: (name: string, data: unknown) => void, private firePublish?: (nowMs: number) => void) {}

  start(): void {
    // Initialise nextRun for display, forward-only from now.
    const now = Date.now();
    for (const s of this.store.listSchedules()) {
      this.store.setScheduleNextRun(s.id, s.enabled ? nextOccurrence(s, now) : null);
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const now = Date.now();
    // Fire any due scheduled publish drafts first (cheap, local).
    try { this.firePublish?.(now); } catch { /* non-fatal */ }
    for (const s of this.store.listSchedules()) {
      if (!s.enabled) { this.store.setScheduleNextRun(s.id, null); continue; }
      let next = s.nextRun ?? nextOccurrence(s, now);
      if (next == null) continue;
      if (next > now) { this.store.setScheduleNextRun(s.id, next); continue; }
      // Due. Guard against double-fire inside the same minute.
      if (s.lastRun && now - s.lastRun < 90_000) continue;
      next = nextOccurrence(s, now);
      this.store.markScheduleRun(s.id, now, next);
      this.fire(s);
    }
  }

  private fire(s: Schedule): void {
    const project = (s.projectId ? this.store.getProject(s.projectId) : undefined) ?? this.store.listProjects()[0];
    if (!project) return;
    const job = this.store.createJob(project.id, s.title, `Scheduled: ${s.title}`, 'balanced');
    this.emit('job', job);
    // Fire-and-forget: the engine updates + emits job state as it progresses.
    void this.engine.run(job.id).catch(() => { /* engine already recorded the failure on the job */ });
  }
}
