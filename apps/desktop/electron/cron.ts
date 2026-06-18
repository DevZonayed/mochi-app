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
const LATE_TOLERANCE_MS = 90_000;

/** Default catch-up window for a missed clock-mode slot: until the end of the
    local day the slot belonged to (so a 9am miss can still fire any time that day). */
function endOfDayWindow(dueAt: number): number {
  const end = new Date(dueAt);
  end.setHours(23, 59, 59, 999);
  return Math.max(0, end.getTime() - dueAt);
}

function parseHHMM(time: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, m: mi };
}

/* The weekdays a cadence permits, as JS getDay() values (0=Sun..6=Sat).
   `null` means every day. Tolerant of the engine vocabulary ('daily'/'weekly')
   AND the labels the Scheduler sheet writes ('Every day'/'Weekdays'/'Mon, Wed').
   'weekly' stays anchored to the weekday the schedule was created on. This is
   the single source of truth for WHEN a schedule fires; the desktop calendar
   mirrors the same semantics so the grid matches reality. */
export function cadenceDays(s: Schedule): Set<number> | null {
  const c = (s.cadence || '').toLowerCase().trim();
  if (!c || c === '*' || c === 'daily' || /every\s*day/.test(c)) return null;
  if (c === 'weekly') return new Set([new Date(s.createdAt).getDay()]);
  if (/weekday|mon\s*-\s*fri|monday to friday/.test(c)) return new Set([1, 2, 3, 4, 5]);
  if (/weekend/.test(c)) return new Set([0, 6]);
  const map: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const days = Object.keys(map).filter(k => c.includes(k)).map(k => map[k]);
  return days.length ? new Set(days) : null;
}

/** Next occurrence of the schedule strictly after `from`. */
export function nextOccurrence(s: Schedule, from: number): number | null {
  // Interval-mode: every N minutes from anchorAt (defaults to createdAt).
  if (s.everyMinutes && s.everyMinutes > 0) {
    const every = s.everyMinutes * 60_000;
    const anchor = s.anchorAt ?? s.createdAt;
    const steps = Math.floor((from - anchor) / every) + 1; // strictly after `from`
    return anchor + steps * every;
  }
  const hm = parseHHMM(s.time);
  if (!hm) return null;
  const days = cadenceDays(s);
  const d = new Date(from);
  d.setHours(hm.h, hm.m, 0, 0);
  // earliest candidate strictly after `from` (today if HH:MM is still ahead)
  if (d.getTime() <= from) d.setTime(d.getTime() + DAY_MS);
  // then skip forward to the next allowed weekday (bounded to a week)
  if (days) { for (let i = 0; i < 7 && !days.has(d.getDay()); i++) d.setTime(d.getTime() + DAY_MS); }
  return d.getTime();
}

export class CronRunner {
  private timer: ReturnType<typeof setInterval> | null = null;

  /** firePublish: optional hook to export scheduled publish drafts whose time has come. */
  constructor(private store: Store, private engine: LocalEngine, private emit: (name: string, data: unknown) => void, private firePublish?: (nowMs: number) => void) {}

  start(): void {
    const now = Date.now();
    for (const s of this.store.listSchedules()) {
      if (!s.enabled) { this.store.setScheduleNextRun(s.id, null); continue; }
      // One-shots keep their fireAt. Recurring: keep a persisted nextRun (even if
      // it's already in the past — the first tick decides fire/catch-up/roll-forward);
      // only compute a fresh one when none is stored.
      const next = s.fireAt ?? s.nextRun ?? nextOccurrence(s, now);
      this.store.setScheduleNextRun(s.id, next);
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
      // A paused auto-answer (user extended past the cap) holds the question open
      // indefinitely — never auto-fire; it waits for a manual reply / cancel.
      if (s.paused) { this.store.setScheduleNextRun(s.id, null); continue; }
      // One-shot "wait & check" / scheduled message: fire once at fireAt, disable.
      if (s.fireAt) {
        if (s.fireAt > now) { this.store.setScheduleNextRun(s.id, s.fireAt); continue; }
        if (s.lastRun) { this.store.setScheduleEnabled(s.id, false); continue; }
        this.store.markScheduleRun(s.id, now, null);
        this.store.setScheduleEnabled(s.id, false);
        // Emit the now-disabled record so any live queue UI prunes it as it fires.
        const done = this.store.listSchedules().find(x => x.id === s.id);
        if (done) this.emit('schedule', done);
        this.fire(s);
        continue;
      }
      let next = s.nextRun ?? nextOccurrence(s, now);
      if (next == null) continue;
      if (next > now) { this.store.setScheduleNextRun(s.id, next); continue; }
      // Due. Guard against double-fire inside the same minute.
      if (s.lastRun && now - s.lastRun < 90_000) continue;
      const late = now - next > LATE_TOLERANCE_MS;
      // Interval-mode never "catches up" a stale slot — it just advances from now.
      const isInterval = !!(s.everyMinutes && s.everyMinutes > 0);
      if (late && !isInterval) {
        const windowMs = s.catchUpWindowMs ?? endOfDayWindow(next);
        const withinWindow = now <= next + windowMs;
        const alreadyDone = s.lastDueAt === next;
        if (!s.catchUp || !withinWindow || alreadyDone) {
          // Missed and not eligible for catch-up: roll forward, do not fire.
          this.store.setScheduleNextRun(s.id, nextOccurrence(s, now));
          continue;
        }
      }
      const dueAt = next;
      next = nextOccurrence(s, now);
      this.store.markScheduleRun(s.id, now, next, { dueAt, late });
      this.fire(s, { late });
    }
  }

  /** Fire a schedule right now (manual / agent-triggered), bypassing timing. */
  fireNow(scheduleId: string): boolean {
    const s = this.store.listSchedules().find(x => x.id === scheduleId);
    if (!s) return false;
    this.fire(s);
    return true;
  }

  private fire(s: Schedule, opts?: { late?: boolean }): void {
    const project = (s.projectId ? this.store.getProject(s.projectId) : undefined) ?? this.store.listProjects()[0];
    if (!project) return;
    if (opts?.late) this.emit('schedule-late', { id: s.id, title: s.title, dueAt: s.lastDueAt ?? null, firedAt: Date.now() });
    // A wait-&-check / scheduled message fires its prompt into the originating
    // chat, on that chat's model. For a scheduled message the composer intent
    // (effort, browser, plan, goal) was captured so it runs exactly as if sent
    // by hand; a plain wait-&-check carries none of those and falls back.
    const session = s.sessionId ? this.store.getSession(s.sessionId) : undefined;
    const input = s.prompt && s.prompt.trim() ? s.prompt : s.title;
    const job = this.store.createJob(project.id, input, `Scheduled: ${s.title}`, s.effort ?? 'balanced', session?.id);
    this.emit('job', job);
    const runOpts = {
      ...(session?.primary ? { engine: session.primary.engine, model: session.primary.model, reviewer: session.reviewer } : {}),
      ...(s.effort ? { effort: s.effort } : {}),
      ...(s.browser ? { browser: true } : {}),
      ...(s.plan ? { plan: true } : {}),
      ...(s.goal ? { goal: true } : {}),
    };
    // Fire-and-forget: the engine updates + emits job state as it progresses.
    void this.engine.run(job.id, runOpts).catch(() => { /* engine already recorded the failure on the job */ });
  }
}
