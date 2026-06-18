/* The in-process bridge behind the agent's schedule + project discovery tools
   (mcp__maestro__schedule_create / projects_list / etc). Pure logic over Store +
   CronRunner so it's unit-testable without the SDK.
   The Mac is the brain: these run on the desktop against the same store the cron
   reads, so a schedule the agent creates fires exactly like a hand-made one. */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import type { Store, Schedule, Effort, Project } from './store.js';
import type { CronRunner } from './cron.js';

export interface ScheduleRecurrence { everyMinutes?: number; time?: string; cadence?: string }
export interface ScheduleCreateArgs {
  projectId?: string | null; sessionId?: string; title: string; prompt: string;
  recurrence: ScheduleRecurrence; effort?: Effort; browser?: boolean; plan?: boolean; catchUp?: boolean;
}
export interface ScheduleUpdateArgs {
  title?: string; prompt?: string; everyMinutes?: number; time?: string; cadence?: string;
  effort?: Effort; browser?: boolean; plan?: boolean; catchUp?: boolean; enabled?: boolean;
  sessionId?: string; projectId?: string | null;
}
export interface ScheduleListItem {
  id: string; title: string; prompt: string; recurrence: string; enabled: boolean;
  projectId: string | null; sessionId?: string; nextRun: number | null; lastRun?: number | null; lastFireLate?: boolean;
}
export interface ScheduleCtx {
  list(filter: { projectId?: string }): ScheduleListItem[];
  create(args: ScheduleCreateArgs): Schedule;
  update(id: string, patch: ScheduleUpdateArgs): Schedule;
  del(id: string): void;
  toggle(id: string, enabled: boolean): void;
  runNow(id: string): boolean;
  listProjects(): { id: string; name: string; hasMemory: boolean; sessionCount: number }[];
  listSessions(projectId: string): { id: string; title: string }[];
}

/** Where a project's files (and its .continuum memory) live — mirrors localApi's
    projectRootOf: the real path if set, else the managed ~/Maestro/<name> dir. */
function projectRoot(proj: { name?: string; path?: string }): string {
  if (proj.path && existsSync(proj.path)) return proj.path;
  const safe = (proj.name || 'default').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'default';
  return path.join(homedir(), 'Maestro', safe);
}

/** True when the project has a .continuum memory chain on disk. */
function hasProjectMemory(proj: Project): boolean {
  try { return existsSync(path.join(projectRoot(proj), '.continuum')); } catch { return false; }
}

/** "every 3h" / "every 45m" / "daily at 09:00" / "Mon, Wed at 08:00" / "once". */
export function humanRecurrence(s: Schedule): string {
  if (s.fireAt) return `once at ${new Date(s.fireAt).toLocaleString()}`;
  if (s.everyMinutes && s.everyMinutes > 0) {
    const h = Math.floor(s.everyMinutes / 60), m = s.everyMinutes % 60;
    return `every ${h ? `${h}h` : ''}${m ? `${m}m` : ''}`.trim();
  }
  const cad = s.cadence && s.cadence !== 'daily' ? s.cadence : 'daily';
  return `${cad} at ${s.time || '??:??'}${s.catchUp ? ' (catch-up)' : ''}`;
}

export function makeScheduleCtx(store: Store, cron: CronRunner): ScheduleCtx {
  return {
    list(filter) {
      return store.listSchedules()
        .filter(s => !filter.projectId || s.projectId === filter.projectId)
        .map(s => ({ id: s.id, title: s.title, prompt: s.prompt ?? '', recurrence: humanRecurrence(s),
          enabled: s.enabled, projectId: s.projectId, sessionId: s.sessionId, nextRun: s.nextRun,
          lastRun: s.lastRun, lastFireLate: s.lastFireLate }));
    },
    create(a) {
      return store.createSchedule({
        projectId: a.projectId ?? null, sessionId: a.sessionId, title: a.title, prompt: a.prompt,
        everyMinutes: a.recurrence.everyMinutes,
        time: a.recurrence.time, cadence: a.recurrence.cadence,
        effort: a.effort, browser: a.browser, plan: a.plan, catchUp: a.catchUp,
      });
    },
    update(id, patch) { return store.updateSchedule(id, patch); },
    del(id) { store.deleteSchedule(id); },
    toggle(id, enabled) { store.setScheduleEnabled(id, enabled); },
    runNow(id) { return cron.fireNow(id); },
    listProjects() {
      return store.listProjects().map(p => ({
        id: p.id, name: p.name,
        hasMemory: hasProjectMemory(p),
        sessionCount: store.listSessions(p.id).length,
      }));
    },
    listSessions(projectId) { return store.listSessions(projectId).map(s => ({ id: s.id, title: s.title })); },
  };
}
