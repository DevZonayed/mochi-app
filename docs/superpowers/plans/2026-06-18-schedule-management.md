# Schedule Management Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add interval cadences ("every N hours") and catch-up-for-missed-runs to the schedule engine, give the in-app agent a full `mcp__maestro__schedule_*`/`projects_*` tool surface, add the missing full-edit endpoint over the relay, and make schedules editable/deletable on desktop + mobile.

**Architecture:** The Mac is the brain. All schedule state, the 30s cron tick, and firing stay on the desktop (`store.ts` + `cron.ts`). The new agent tools execute in-process in `engine.ts` against the same `store`/`cron` via a `ScheduleCtx` bridge (mirroring the existing `bgCtx`/`browserCtx`). The relay only mirrors `schedules` in its snapshot and forwards mutations; events fan out over SSE to phone/web. All new `Schedule` fields are optional so existing schedules keep working.

**Tech Stack:** TypeScript, Electron + React 18 (desktop), React Native/Expo (mobile), Fastify relay, Vitest, Zod (SDK tool schemas), `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`/`tool`).

## Global Constraints

- Test runner: Vitest. Run desktop electron tests with `pnpm --filter @maestro/desktop test` (or `cd apps/desktop && pnpm vitest run electron/<file>`). Confirm the exact script in `apps/desktop/package.json` before first run.
- Tests mock only `electron`'s `app.getPath` (see existing `cron.message.test.ts` / `store.mcp.test.ts`); `Store` + `CronRunner` are exercised as production code.
- `Date.now()` is used directly in production code (cron). In tests, use real `Date.now()` offsets (`Date.now() - 1_000`) as the existing tests do — do NOT introduce a clock-injection refactor (YAGNI).
- New `Schedule` fields are ALL optional and additive. Never change the meaning of existing fields (`time`, `cadence`, `fireAt`, `kind`).
- A schedule is **interval-mode** iff `everyMinutes && everyMinutes > 0`; else **clock-mode** (`time`+`cadence`); else **one-shot** (`fireAt`). These are mutually exclusive and decided in this order.
- Catch-up applies to clock-mode only. Default `catchUp` is falsy → current forward-only behavior is preserved unless opted in.
- Cron tick interval `TICK_MS = 30_000` and the 90s double-fire guard are unchanged.
- Keep the `Schedule` type definitions in `apps/desktop/electron/store.ts` and `apps/desktop/src/lib/api.ts` (the client mirror) in sync — every field added to one is added to the other with the same name/type.
- Commit after each task with a `feat(...)`/`test(...)` message; do not push or deploy (operator deploy gate).

---

## File Structure

- `apps/desktop/electron/store.ts` — `Schedule` interface + `createSchedule`/`updateSchedule`/`markScheduleRun` CRUD (Part 1, 3).
- `apps/desktop/electron/cron.ts` — `nextOccurrence` (interval), `tick`/`fire`/`start` (catch-up + late emit) (Part 1).
- `apps/desktop/electron/cron.recurrence.test.ts` — NEW. Interval + catch-up unit tests (Part 1).
- `apps/desktop/electron/main.ts` — desktop `Notification` on `schedule-late` (Part 1).
- `apps/desktop/electron/engine.ts` — `ScheduleCtx` interface + construction + `schedule_*`/`projects_list`/`sessions_list` tools + allowed list + directive (Part 2).
- `apps/desktop/electron/schedule-ctx.ts` — NEW. `makeScheduleCtx(store, cron)` pure bridge logic (Part 2).
- `apps/desktop/electron/schedule-ctx.test.ts` — NEW. ScheduleCtx CRUD/discovery tests (Part 2).
- `apps/desktop/electron/localApi.ts` — `createSchedule` handler new fields + `updateSchedule` case (Part 3).
- `apps/desktop/src/lib/api.ts` — `Schedule` mirror fields + `createSchedule` typing + `updateSchedule` client (Part 3).
- `apps/server/src/server.ts` — `PATCH /api/schedules/:id` relay (Part 3).
- `apps/desktop/src/screens/Scheduler.tsx` — interval/catch-up/session pickers + edit (Part 4).
- `apps/desktop/src/screens/ProjectDetail.tsx` — composer recurring option (Part 4).
- `apps/mobile/src/screens/Queue.tsx` — create/edit (Part 4).
- `apps/mobile/src/LiveNotifier.tsx` — `schedule-late` alert (Part 4).

---

# Part 1 — Engine: recurrence + catch-up

### Task 1: Extend the Schedule data model

**Files:**
- Modify: `apps/desktop/electron/store.ts:152-168` (interface), `:947-967` (createSchedule), `:970-977` (updateSchedule), `:982-984` (markScheduleRun)
- Test: `apps/desktop/electron/cron.recurrence.test.ts` (created here, grows in Tasks 2-3)

**Interfaces:**
- Produces: `Schedule` gains optional `everyMinutes?: number; anchorAt?: number; catchUp?: boolean; catchUpWindowMs?: number; lastDueAt?: number; lastFireLate?: boolean`. `createSchedule` accepts `everyMinutes`, `anchorAt`, `catchUp`, `catchUpWindowMs`. `updateSchedule` patch widens to `'fireAt' | 'extends' | 'paused' | 'enabled' | 'prompt' | 'title' | 'time' | 'cadence' | 'everyMinutes' | 'anchorAt' | 'catchUp' | 'catchUpWindowMs' | 'effort' | 'browser' | 'plan' | 'goal' | 'sessionId' | 'projectId'`. `markScheduleRun(scheduleId, ts, nextRun, opts?: { dueAt?: number; late?: boolean })`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/electron/cron.recurrence.test.ts`:

```typescript
/* Recurrence + catch-up for the schedule engine. Only app.getPath is mocked;
   Store + CronRunner are production code (see cron.message.test.ts). */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { rmSync } from 'node:fs';

const hoisted = vi.hoisted(() => ({ dir: `/tmp/maestro-store-recur-test-${process.pid}` }));
vi.mock('electron', () => ({ app: { getPath: () => hoisted.dir } }));

import { Store } from './store.js';

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

  it('updateSchedule patches recurrence + content fields and re-derives nextRun from fireAt', () => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run electron/cron.recurrence.test.ts`
Expected: FAIL — `everyMinutes` not on the created record / `updateSchedule` rejects `title`/`time` (type error or undefined).

- [ ] **Step 3: Extend the interface**

In `store.ts`, replace the `Schedule` interface tail (the `armedAt? extends? paused?` line region, `:163-167`) by adding the new fields before the closing brace:

```typescript
  kind?: 'message' | 'auto-continue' | 'auto-answer'; effort?: Effort; browser?: boolean; plan?: boolean; goal?: boolean;
  /** auto-answer only: when it was armed (base for the escalating-extend math),
      how many times the user extended, and whether it's been paused past the cap
      (paused = no auto-answer; the question waits indefinitely for a manual reply). */
  armedAt?: number; extends?: number; paused?: boolean;
  /** Interval cadence: fire every N minutes from `anchorAt` (defaults to createdAt).
      When set (>0) the schedule is interval-mode and ignores time/cadence. */
  everyMinutes?: number; anchorAt?: number;
  /** Clock-mode catch-up: if a daily/weekly slot was missed while the Mac was
      asleep, fire it once when next awake, provided now <= dueTime + window.
      catchUpWindowMs defaults to "rest of the local day". lastDueAt is the
      intended slot timestamp of the last fire (dedupe key); lastFireLate marks
      that the last fire was a catch-up (drives the "ran late" notice). */
  catchUp?: boolean; catchUpWindowMs?: number; lastDueAt?: number; lastFireLate?: boolean;
```

- [ ] **Step 4: Extend createSchedule**

In `store.ts` `createSchedule` (`:947`), widen the arg type and persist the fields. Change the signature arg type to add `everyMinutes?: number; anchorAt?: number; catchUp?: boolean; catchUpWindowMs?: number;` and, inside the `rec` object literal (after the `...(s.extends ? ...)` spread at `:963`), add:

```typescript
      ...(s.everyMinutes ? { everyMinutes: s.everyMinutes } : {}),
      ...(s.anchorAt ? { anchorAt: s.anchorAt } : {}),
      ...(s.catchUp ? { catchUp: true } : {}),
      ...(s.catchUpWindowMs ? { catchUpWindowMs: s.catchUpWindowMs } : {}),
```

Also: when `everyMinutes` is set and no `fireAt`, default `cadence` to `'interval'` for display clarity. Change the `cadence:` line (`:952`) to:

```typescript
      cadence: s.fireAt ? 'once' : (s.everyMinutes ? 'interval' : (s.cadence ?? 'daily')),
```

- [ ] **Step 5: Widen updateSchedule + markScheduleRun**

Replace `updateSchedule` patch type (`:970`) so it accepts the editable set:

```typescript
  updateSchedule(scheduleId: string, patch: Partial<Pick<Schedule,
    'fireAt' | 'extends' | 'paused' | 'enabled' | 'prompt' | 'title' | 'time' | 'cadence'
    | 'everyMinutes' | 'anchorAt' | 'catchUp' | 'catchUpWindowMs'
    | 'effort' | 'browser' | 'plan' | 'goal' | 'sessionId' | 'projectId'>>): Schedule {
    const s = this.data.schedules.find(x => x.id === scheduleId);
    if (!s) throw Object.assign(new Error('schedule not found'), { statusCode: 404 });
    Object.assign(s, patch);
    if (patch.fireAt !== undefined) s.nextRun = patch.fireAt ?? null;
    this.save();
    return s;
  }
```

Replace `markScheduleRun` (`:982`) to optionally record the slot + late flag:

```typescript
  markScheduleRun(scheduleId: string, ts: number, nextRun: number | null, opts?: { dueAt?: number; late?: boolean }): void {
    const s = this.data.schedules.find(x => x.id === scheduleId);
    if (s) {
      s.lastRun = ts; s.nextRun = nextRun;
      if (opts?.dueAt !== undefined) s.lastDueAt = opts.dueAt;
      s.lastFireLate = !!opts?.late;
      this.save();
    }
  }
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run electron/cron.recurrence.test.ts`
Expected: PASS (both tests).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/store.ts apps/desktop/electron/cron.recurrence.test.ts
git commit -m "feat(desktop): schedule model gains interval + catch-up fields"
```

---

### Task 2: Interval recurrence in nextOccurrence

**Files:**
- Modify: `apps/desktop/electron/cron.ts:40-52` (`nextOccurrence`)
- Test: `apps/desktop/electron/cron.recurrence.test.ts`

**Interfaces:**
- Consumes: `Schedule.everyMinutes`, `Schedule.anchorAt`, `Schedule.createdAt` (Task 1).
- Produces: `nextOccurrence(s, from)` returns the next interval slot strictly after `from` when `everyMinutes > 0`; unchanged clock-mode otherwise.

- [ ] **Step 1: Write the failing test**

Append to `cron.recurrence.test.ts`:

```typescript
import { nextOccurrence } from './cron.js';

describe('nextOccurrence — interval mode', () => {
  beforeEach(() => { rmSync(hoisted.dir, { recursive: true, force: true }); });

  function intervalSchedule(everyMinutes: number, anchorAt: number) {
    return { id: 'i', projectId: null, title: 't', time: '', cadence: 'interval',
      enabled: true, nextRun: null, createdAt: anchorAt, everyMinutes, anchorAt } as any;
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
      enabled: true, nextRun: null, createdAt: created, everyMinutes: 60 } as any;
    expect(nextOccurrence(s, created + 10)).toBe(created + 3_600_000);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run electron/cron.recurrence.test.ts -t "interval mode"`
Expected: FAIL — interval schedule returns `null` (parseHHMM('') fails) instead of the computed slot.

- [ ] **Step 3: Implement interval branch in nextOccurrence**

In `cron.ts`, replace `nextOccurrence` (`:40-52`) so it handles interval-mode first:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop && pnpm vitest run electron/cron.recurrence.test.ts`
Expected: PASS (all tests so far).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/cron.ts apps/desktop/electron/cron.recurrence.test.ts
git commit -m "feat(desktop): interval cadence (every N minutes) in nextOccurrence"
```

---

### Task 3: Catch-up + late firing in tick/fire

**Files:**
- Modify: `apps/desktop/electron/cron.ts:74-127` (`tick`, `fire`), `:60-67` (`start`)
- Test: `apps/desktop/electron/cron.recurrence.test.ts`

**Interfaces:**
- Consumes: `Schedule.catchUp/catchUpWindowMs/lastDueAt` (Task 1), `nextOccurrence` (Task 2), `markScheduleRun(.., opts)` (Task 1).
- Produces: late clock-mode fires emit `('schedule-late', { id, title, dueAt, firedAt })`; `fire(s, opts?: { late?: boolean })`.

- [ ] **Step 1: Write the failing test**

Append to `cron.recurrence.test.ts`:

```typescript
import { CronRunner } from './cron.js';
import type { LocalEngine } from './engine.js';

function makeEngine() {
  const run = vi.fn().mockResolvedValue(undefined);
  return { engine: { run } as unknown as LocalEngine, run };
}

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run electron/cron.recurrence.test.ts -t "catch-up"`
Expected: FAIL — current `tick` fires on any `next <= now` regardless of `catchUp`, and never emits `schedule-late`/sets `lastFireLate`.

- [ ] **Step 3: Implement catch-up in tick + late in fire**

In `cron.ts`, replace the recurring branch of `tick()` (`:95-103`, from `let next = ...` to the end of the loop body) with:

```typescript
      let next = s.nextRun ?? nextOccurrence(s, now);
      if (next == null) continue;
      if (next > now) { this.store.setScheduleNextRun(s.id, next); continue; }
      // Due. Guard against double-fire inside the same minute.
      if (s.lastRun && now - s.lastRun < 90_000) continue;
      const LATE_TOLERANCE_MS = 90_000;
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
```

Add a helper near the top of `cron.ts` (after `DAY_MS`, `:13`):

```typescript
/** Default catch-up window for a missed clock-mode slot: until the end of the
    local day the slot belonged to (so a 9am miss can still fire any time that day). */
function endOfDayWindow(dueAt: number): number {
  const end = new Date(dueAt);
  end.setHours(23, 59, 59, 999);
  return Math.max(0, end.getTime() - dueAt);
}
```

Replace `fire(s: Schedule)` signature + body head (`:106`) to accept + emit late:

```typescript
  private fire(s: Schedule, opts?: { late?: boolean }): void {
    const project = (s.projectId ? this.store.getProject(s.projectId) : undefined) ?? this.store.listProjects()[0];
    if (!project) return;
    if (opts?.late) this.emit('schedule-late', { id: s.id, title: s.title, dueAt: s.lastDueAt ?? null, firedAt: Date.now() });
```

(Leave the rest of `fire` unchanged.)

- [ ] **Step 4: Honor persisted nextRun on start (so a missed slot is evaluated after wake)**

In `cron.ts` `start()` (`:60-67`), change the init so an existing `nextRun` that already came due is preserved (instead of being recomputed forward), letting the first tick evaluate catch-up:

```typescript
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run electron/cron.recurrence.test.ts electron/cron.message.test.ts`
Expected: PASS — new catch-up tests pass AND the existing `cron.message.test.ts` still passes (no regression to one-shot/auto-continue/auto-answer).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/electron/cron.ts apps/desktop/electron/cron.recurrence.test.ts
git commit -m "feat(desktop): catch-up missed schedules within a window + emit schedule-late"
```

---

### Task 4: Desktop OS notification when a schedule runs late

**Files:**
- Modify: `apps/desktop/electron/main.ts` (the `emit` handler body, ~`:262-283`; import `Notification` from `electron`)

**Interfaces:**
- Consumes: `('schedule-late', { id, title, dueAt, firedAt })` emitted by `fire` (Task 3).
- Produces: a native desktop notification; the event still fans out to the relay (not `desktopOnly`).

- [ ] **Step 1: Add the Notification import**

In `main.ts`, find the `from 'electron'` import and add `Notification` to it (e.g. `import { app, BrowserWindow, ipcMain, Notification, ... } from 'electron';`). Verify `Notification` isn't already imported first.

- [ ] **Step 2: Handle schedule-late in the emit handler**

In the `emit` function in `main.ts`, after the existing approval/telegram line (`if (name === 'approval' && telegram ...)`, ~`:275`), add:

```typescript
    // A recurring schedule fired late (catch-up after the Mac was asleep) — tell the operator.
    if (name === 'schedule-late' && Notification.isSupported()) {
      const d = data as { title?: string };
      try { new Notification({ title: 'Scheduled task ran late', body: `“${d?.title ?? 'A schedule'}” missed its time and just ran (catch-up).` }).show(); } catch { /* non-fatal */ }
    }
```

- [ ] **Step 3: Typecheck**

Run: `cd apps/desktop && pnpm exec tsc --noEmit -p tsconfig.json` (confirm the right tsconfig; the repo may use `pnpm --filter @maestro/desktop typecheck`).
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/electron/main.ts
git commit -m "feat(desktop): native notification when a schedule catches up late"
```

---

# Part 2 — Agent MCP control

### Task 5: ScheduleCtx bridge (logic + tests)

**Files:**
- Create: `apps/desktop/electron/schedule-ctx.ts`
- Create: `apps/desktop/electron/schedule-ctx.test.ts`

**Interfaces:**
- Consumes: `Store` (`listSchedules`/`createSchedule`/`updateSchedule`/`deleteSchedule`/`setScheduleEnabled`/`listProjects`/`getProject`/`listSessions`), `CronRunner` (a public `fireNow(id)` added here).
- Produces: `interface ScheduleCtx` with `list`, `create`, `update`, `del`, `toggle`, `runNow`, `listProjects`, `listSessions`; and `makeScheduleCtx(store, cron)`. Used by `engine.ts` (Task 6).

- [ ] **Step 1: Add a public fireNow to CronRunner**

In `cron.ts`, add a public method (so the agent's `schedule_run_now` can fire immediately for testing):

```typescript
  /** Fire a schedule right now (manual / agent-triggered), bypassing timing. */
  fireNow(scheduleId: string): boolean {
    const s = this.store.listSchedules().find(x => x.id === scheduleId);
    if (!s) return false;
    this.fire(s);
    return true;
  }
```

- [ ] **Step 2: Write the failing test**

Create `apps/desktop/electron/schedule-ctx.test.ts`:

```typescript
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

  it('lists projects (with hasMemory) and their sessions', () => {
    const s = new Store();
    const p = s.createProject({ name: 'P' });
    s.createSession(p.id, 'Chat A');
    const ctx = makeScheduleCtx(s, new CronRunner(s, makeEngine().engine, vi.fn()));
    const projects = ctx.listProjects();
    expect(projects.find(x => x.id === p.id)?.name).toBe('P');
    expect(ctx.listSessions(p.id).map(x => x.title)).toContain('Chat A');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd apps/desktop && pnpm vitest run electron/schedule-ctx.test.ts`
Expected: FAIL — `./schedule-ctx.js` does not exist.

- [ ] **Step 4: Implement schedule-ctx.ts**

Create `apps/desktop/electron/schedule-ctx.ts`. Confirm the exact `Store` session/project accessor names first (`listSessions(projectId)`, `getProject`, `listProjects`) via grep; adjust if they differ.

```typescript
/* The in-process bridge behind the agent's mcp__maestro__schedule_*/projects_*
   tools. Pure logic over Store + CronRunner so it's unit-testable without the SDK.
   The Mac is the brain: these run on the desktop against the same store the cron
   reads, so a schedule the agent creates fires exactly like a hand-made one. */
import type { Store, Schedule, Effort } from './store.js';
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
        hasMemory: !!store.listInstalledSkills?.(p.id)?.length || false, // placeholder replaced in Step 5
        sessionCount: store.listSessions(p.id).length,
      }));
    },
    listSessions(projectId) { return store.listSessions(projectId).map(s => ({ id: s.id, title: s.title })); },
  };
}
```

- [ ] **Step 5: Implement hasMemory correctly**

`hasMemory` should reflect whether the project has `.continuum`/memory content, not skills. Check how project memory is detected elsewhere (grep `getProjectMemory`/`.continuum`/`STATE.md` in `store.ts`/`main.ts`). Replace the `hasMemory` line with the real check, e.g. if the store exposes `getProjectMemory(projectId)`:

```typescript
        hasMemory: (() => { try { return !!store.getProjectMemory?.(p.id); } catch { return false; } })(),
```

If no such accessor exists, set `hasMemory: false` and note it for the UI/agent (don't invent an API). Keep the field — the agent uses it to pick a project.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/desktop && pnpm vitest run electron/schedule-ctx.test.ts`
Expected: PASS (all 6).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/schedule-ctx.ts apps/desktop/electron/schedule-ctx.test.ts apps/desktop/electron/cron.ts
git commit -m "feat(desktop): ScheduleCtx bridge for agent-driven schedule CRUD + runNow"
```

---

### Task 6: Wire schedule_*/projects_* MCP tools into the agent

**Files:**
- Modify: `apps/desktop/electron/engine.ts` — `runClaude` signature (`:449-459`), `maestroServer` condition + tools (`:492-645`), `maestroAllowed` (`:646-651`), `LocalEngine.run` ctx construction (~`:1793-1818`) + `runPrimary` call (`:1827`), and the `LocalEngine` constructor to receive `cron`.
- Modify: `apps/desktop/electron/main.ts:404` — pass `cron` into the engine (or a setter), since `engine` is currently created before `cron`.

**Interfaces:**
- Consumes: `makeScheduleCtx` + `ScheduleCtx` (Task 5).
- Produces: `mcp__maestro__schedule_list/schedule_create/schedule_update/schedule_delete/schedule_toggle/schedule_run_now/projects_list/sessions_list` available to the agent in non-plan runs.

- [ ] **Step 1: Give the engine access to cron**

`engine` is constructed at `main.ts:296` but `cron` at `:404`. Add a setter on `LocalEngine` (near `setImageGen`, `engine.ts:1080`):

```typescript
  private cron?: import('./cron.js').CronRunner;
  setCron(c: import('./cron.js').CronRunner) { this.cron = c; }
```

In `main.ts`, after `const cron = new CronRunner(...)` (`:404`), add: `engine.setCron(cron);` before `cron.start();`.

- [ ] **Step 2: Add scheduleCtx to runClaude signature**

In `engine.ts` `runClaude` params (`:455-458`), add after `browserCtx?: BrowserCtx,`:

```typescript
  scheduleCtx?: ScheduleCtx,
```

Add the import at the top of `engine.ts`: `import type { ScheduleCtx } from './schedule-ctx.js';` and `import { makeScheduleCtx } from './schedule-ctx.js';`

- [ ] **Step 3: Include scheduleCtx in the maestroServer gate + tools**

Change the `maestroServer` condition (`:492`) to include `scheduleCtx`:

```typescript
  const maestroServer = ((imageGen || skillsCtx || bgCtx || browserCtx || scheduleCtx) && !plan)
```

Inside the `tools: [ ... ]` array, after the `browserCtx` block (`:642`), add a `scheduleCtx` block:

```typescript
          ...(scheduleCtx ? [
            tool('schedule_list',
              'List recurring/scheduled tasks. Use to see what is already scheduled before creating or editing. Optionally filter by project.',
              { projectId: z.string().optional().describe('Only schedules for this project id.') },
              wrap(async (a: { projectId?: string }) => {
                const rows = scheduleCtx.list({ projectId: a.projectId });
                if (!rows.length) return txt('No schedules yet.');
                return txt(rows.map(r => `- ${r.id} — "${r.title}" [${r.enabled ? 'on' : 'off'}] ${r.recurrence}${r.projectId ? ` · project ${r.projectId}` : ''}${r.sessionId ? ` · session ${r.sessionId}` : ''}${r.lastFireLate ? ' · last run was LATE' : ''}\n    prompt: ${r.prompt.slice(0, 160)}`).join('\n'));
              })),
            tool('schedule_create',
              'Create a recurring or interval schedule that fires a PROMPT into a project/session as a real job (it runs with that project\'s memory + tools). Use for any "every N hours / every day at TIME / each morning" automation. For "every 2 hours" pass recurrence.everyMinutes=120; for "every day at 9am" pass recurrence.time="09:00", recurrence.cadence="daily". Set catchUp=true so a missed run (Mac asleep) still fires later that day. Discover targets with projects_list/sessions_list first.',
              { projectId: z.string().optional().describe('Project to run in (use projects_list).'),
                sessionId: z.string().optional().describe('Chat session to run in (use sessions_list). Inherits its engine/model + memory.'),
                title: z.string().describe('Short label, e.g. "WhatsApp morning summary".'),
                prompt: z.string().describe('What the run should DO, e.g. "Pull ~50 WhatsApp messages via the comms MCP, summarize, and send to my private chat."'),
                everyMinutes: z.number().optional().describe('Interval cadence in minutes (120 = every 2h). Omit for a clock-time schedule.'),
                time: z.string().optional().describe('HH:MM 24h clock time for daily/weekly cadence.'),
                cadence: z.string().optional().describe('"daily" | "weekdays" | "weekend" | a day list like "Mon, Wed, Fri". Default daily.'),
                effort: z.enum(['fast', 'balanced', 'deep']).optional(),
                browser: z.boolean().optional().describe('Run with the real-Chrome browser tools enabled.'),
                catchUp: z.boolean().optional().describe('If a clock-time run is missed, fire it once later the same day.') },
              wrap(async (a: { projectId?: string; sessionId?: string; title: string; prompt: string; everyMinutes?: number; time?: string; cadence?: string; effort?: Effort; browser?: boolean; catchUp?: boolean }) => {
                const rec = scheduleCtx.create({ projectId: a.projectId ?? null, sessionId: a.sessionId, title: a.title, prompt: a.prompt,
                  recurrence: { everyMinutes: a.everyMinutes, time: a.time, cadence: a.cadence }, effort: a.effort, browser: a.browser, catchUp: a.catchUp });
                return txt(`Created schedule ${rec.id} "${rec.title}". It will fire its prompt as a job on schedule. Use schedule_run_now("${rec.id}") to test it immediately.`);
              })),
            tool('schedule_update',
              'Edit an existing schedule (title, prompt, timing, target, on/off). Pass only the fields to change. Get ids from schedule_list.',
              { id: z.string(), title: z.string().optional(), prompt: z.string().optional(),
                everyMinutes: z.number().optional(), time: z.string().optional(), cadence: z.string().optional(),
                effort: z.enum(['fast', 'balanced', 'deep']).optional(), browser: z.boolean().optional(),
                catchUp: z.boolean().optional(), enabled: z.boolean().optional(),
                sessionId: z.string().optional(), projectId: z.string().optional() },
              wrap(async (a: { id: string } & Record<string, unknown>) => {
                const { id, ...patch } = a;
                const rec = scheduleCtx.update(id, patch as Parameters<ScheduleCtx['update']>[1]);
                return txt(`Updated schedule ${rec.id} "${rec.title}".`);
              })),
            tool('schedule_delete', 'Delete a schedule permanently. Get the id from schedule_list.',
              { id: z.string() },
              wrap(async (a: { id: string }) => { scheduleCtx.del(a.id); return txt(`Deleted schedule ${a.id}.`); })),
            tool('schedule_toggle', 'Enable or disable a schedule without deleting it.',
              { id: z.string(), enabled: z.boolean() },
              wrap(async (a: { id: string; enabled: boolean }) => { scheduleCtx.toggle(a.id, a.enabled); return txt(`Schedule ${a.id} is now ${a.enabled ? 'enabled' : 'disabled'}.`); })),
            tool('schedule_run_now', 'Fire a schedule immediately (to test it), in addition to its normal timing.',
              { id: z.string() },
              wrap(async (a: { id: string }) => txt(scheduleCtx.runNow(a.id) ? `Fired schedule ${a.id} now — check the session for the new job.` : `No schedule ${a.id}.`))),
            tool('projects_list', 'List the user\'s projects (id, name, whether it has saved memory, session count). Use to pick where a schedule should run.',
              {},
              wrap(async () => {
                const rows = scheduleCtx.listProjects();
                if (!rows.length) return txt('No projects.');
                return txt(rows.map(p => `- ${p.id} — ${p.name}${p.hasMemory ? ' [has memory]' : ''} · ${p.sessionCount} session(s)`).join('\n'));
              })),
            tool('sessions_list', 'List chat sessions in a project (id, title). Use to target a schedule at a specific chat.',
              { projectId: z.string() },
              wrap(async (a: { projectId: string }) => {
                const rows = scheduleCtx.listSessions(a.projectId);
                if (!rows.length) return txt('No sessions in that project.');
                return txt(rows.map(s => `- ${s.id} — ${s.title}`).join('\n'));
              })),
          ] : []),
```

- [ ] **Step 4: Add the tools to the allowed list**

In `maestroAllowed` (`:646-651`), add after the `browserCtx` line:

```typescript
    ...(scheduleCtx ? ['schedule_list', 'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_toggle', 'schedule_run_now', 'projects_list', 'sessions_list'] : []),
```

- [ ] **Step 5: Construct scheduleCtx in LocalEngine.run and pass it**

In `engine.ts` `LocalEngine.run`, after the `browserCtx` construction (~`:1818`), add:

```typescript
      // Schedule capability: let the agent inspect + manage recurring/scheduled
      // tasks and discover projects/sessions to target. Off in plan mode.
      const scheduleCtx: ScheduleCtx | undefined = (this.cron && !opts.plan) ? makeScheduleCtx(this.store, this.cron) : undefined;
```

In the `runPrimary` Claude call (`:1827`), add `scheduleCtx` as the final argument after `claudeCustomMcp`:

```typescript
        ? runClaude(prompt, cwd, effort, anthropicKey, goalMode ? GOAL_MAX_TURNS : undefined, hooks, resumeId, masterModel, opts.plan, this.imageGen, job.projectId, claudeImages, skillsCtx, bgCtx, browserCtx, claudeCustomMcp, scheduleCtx)
```

(Update the `runClaude` parameter order so `scheduleCtx` comes after `customMcp` — match Step 2.)

- [ ] **Step 6: Typecheck + run the full electron test suite**

Run: `cd apps/desktop && pnpm exec tsc --noEmit && pnpm vitest run electron/`
Expected: PASS — no type errors; all existing + new tests green.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/electron/engine.ts apps/desktop/electron/main.ts
git commit -m "feat(desktop): agent MCP tools to CRUD schedules + discover projects/sessions"
```

---

# Part 3 — Contract: relay + clients

### Task 7: localApi + api client for new fields and full edit

**Files:**
- Modify: `apps/desktop/electron/localApi.ts:602-623` (createSchedule handler; add `updateSchedule` case)
- Modify: `apps/desktop/src/lib/api.ts:153-167` (Schedule mirror), `:852-854` (createSchedule typing), add `updateSchedule` client near `:873`

**Interfaces:**
- Consumes: `store.updateSchedule` (Task 1).
- Produces: localApi `updateSchedule` method; `api.updateSchedule(id, patch)`; `api.createSchedule` accepts `everyMinutes`/`catchUp`/`prompt`/`sessionId`/`effort`.

- [ ] **Step 1: Extend the createSchedule handler**

In `localApi.ts` `createSchedule` case (`:610-618`), add the new fields to the `store.createSchedule({...})` call:

```typescript
        const s = store.createSchedule({
          title: p.title as string,
          projectId: (p.projectId as string) ?? null,
          time: p.time as string | undefined,
          cadence: p.cadence as string | undefined,
          fireAt,
          sessionId: p.sessionId ? String(p.sessionId) : undefined,
          prompt: p.prompt ? String(p.prompt) : undefined,
          everyMinutes: Number.isFinite(Number(p.everyMinutes)) ? Number(p.everyMinutes) : undefined,
          catchUp: p.catchUp === true,
          effort: p.effort as Effort | undefined,
          browser: p.browser === true, plan: p.plan === true,
        });
```

- [ ] **Step 2: Add the updateSchedule case**

In `localApi.ts`, after the `toggleSchedule` case (`:622`), add:

```typescript
      case 'updateSchedule': {
        const id = String(p.id ?? '');
        if (!id) bad('id required');
        if (p.sessionId && !store.getSession(String(p.sessionId))) bad('session not found', 404);
        const patch: Record<string, unknown> = {};
        for (const k of ['title', 'prompt', 'time', 'cadence', 'everyMinutes', 'catchUp', 'enabled', 'effort', 'browser', 'plan', 'sessionId', 'projectId'] as const) {
          if (p[k] !== undefined) patch[k] = p[k];
        }
        const s = store.updateSchedule(id, patch);
        emit('schedule', s);
        return s;
      }
```

- [ ] **Step 3: Mirror the new fields + client methods in api.ts**

In `api.ts` `Schedule` interface (`:153-167`), add the same optional fields used by the UI/mobile: `everyMinutes?: number; catchUp?: boolean; lastFireLate?: boolean;` (match `store.ts` names exactly).

Widen `createSchedule` (`:852`):

```typescript
  createSchedule: (input: { title: string; projectId?: string; time?: string; cadence?: string; everyMinutes?: number; catchUp?: boolean; prompt?: string; sessionId?: string; effort?: Effort; browser?: boolean }) =>
    call<Schedule>('createSchedule', { ...input }, () =>
      req<Schedule>('/api/schedules', { method: 'POST', body: JSON.stringify(input) })),
```

Add an `updateSchedule` client after `toggleSchedule` (`:875`):

```typescript
  updateSchedule: (id: string, patch: { title?: string; prompt?: string; time?: string; cadence?: string; everyMinutes?: number; catchUp?: boolean; enabled?: boolean; effort?: Effort; browser?: boolean; sessionId?: string; projectId?: string }) =>
    call<Schedule>('updateSchedule', { id, ...patch }, () =>
      req<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })),
```

- [ ] **Step 4: Typecheck**

Run: `cd apps/desktop && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/electron/localApi.ts apps/desktop/src/lib/api.ts
git commit -m "feat(desktop): localApi+client support interval/catch-up create + full edit"
```

---

### Task 8: Relay PATCH endpoint

**Files:**
- Modify: `apps/server/src/server.ts:364-368` (add PATCH near the other schedule routes)

**Interfaces:**
- Consumes: the `updateSchedule` localApi method (Task 7).
- Produces: `PATCH /api/schedules/:id` → `forward(reply, 'updateSchedule', { ...body, id })`.

- [ ] **Step 1: Add the route**

In `server.ts`, after the `createSchedule` route (`:364`), add:

```typescript
  app.patch('/api/schedules/:id', async (req, reply) =>
    forward(reply, 'updateSchedule', { ...(req.body ?? {}) as Record<string, unknown>, id: (req.params as { id: string }).id }));
```

- [ ] **Step 2: Typecheck the server**

Run: `cd apps/server && pnpm exec tsc --noEmit` (or the repo's server typecheck script).
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/server.ts
git commit -m "feat(server): PATCH /api/schedules/:id relay for full schedule edit"
```

---

# Part 4 — UI (desktop + mobile)

> These tasks touch large React files. Before editing, READ the full target file so new controls match the existing layout, theme tokens, and state patterns. Each task ends with a manual smoke (the app build), since these are integration-level and not unit-tested.

### Task 9: Desktop Scheduler — interval, catch-up, session target, full edit

**Files:**
- Modify: `apps/desktop/src/screens/Scheduler.tsx` — `parseWhen` (`:303-328`), `ScheduleSheet` (`:342-430`), `cadenceColumns` (`:81`), and the list-row edit/save handlers.

**Interfaces:**
- Consumes: `api.createSchedule` (now accepts `everyMinutes`/`catchUp`/`prompt`/`sessionId`), `api.updateSchedule` (Task 7), `api.listSchedules`.
- Produces: a sheet that creates/edits clock-time AND interval schedules with a catch-up toggle and an optional session target.

- [ ] **Step 1: Extend the parser for intervals**

In `parseWhen` (`:303`), before the time parse, detect "every N hours/minutes" and return an interval marker. Add to the `ParsedWhen` interface an optional `everyMinutes?: number`, then near the top of `parseWhen`:

```typescript
  const iv = t.match(/every\s+(\d+)\s*(h|hour|hours|m|min|mins|minute|minutes)/);
  if (iv) {
    const n = parseInt(iv[1], 10);
    const everyMinutes = /^h/.test(iv[2]) ? n * 60 : n;
    return { time: '', cron: '', summary: `Every ${everyMinutes >= 60 ? `${everyMinutes/60}h` : `${everyMinutes}m`}`, label: 'interval', everyMinutes };
  }
```

- [ ] **Step 2: Add catch-up + session + What-runs prompt to the sheet**

In `ScheduleSheet` (`:350`), add state: `const [catchUp, setCatchUp] = React.useState(false);`, `const [sessionId, setSessionId] = React.useState('');`, and a `prompt` state for the "What runs" section (`:413` currently a placeholder). Render a checkbox for catch-up and (when a project is selected) a session `<select>` populated from that project's sessions (the screen already receives `projects`; fetch sessions via `api.listSessions(projectId)` or the existing project sessions source — confirm which is available in this screen).

- [ ] **Step 3: Thread new fields through onSave**

Change `ScheduleSheetProps.onSave` (`:345`) to:

```typescript
  onSave: (data: { title: string; time: string; cadence: string; projectId?: string; sessionId?: string; prompt?: string; everyMinutes?: number; catchUp?: boolean }) => void;
```

Update the Save button (`:426`) to pass `everyMinutes: parsed.everyMinutes, catchUp, sessionId: sessionId || undefined, prompt: prompt || undefined`.

Update the screen-level create handler that calls `api.createSchedule(...)` to forward these fields, and add an edit path: when the sheet is opened for an existing schedule, prefill from it and call `api.updateSchedule(id, patch)` on save instead of create.

- [ ] **Step 4: Render interval schedules in the list/calendar**

In `cadenceColumns` (`:81`) return `[]` for interval schedules (they don't map to weekday columns); ensure the list view shows interval schedules with their `humanRecurrence`-style label (e.g. read `s.everyMinutes`). Add a small "every Nh" badge in the list row.

- [ ] **Step 5: Build the desktop app**

Run: `cd apps/desktop && pnpm build` (or the dev build/typecheck the repo uses for the renderer).
Expected: build succeeds, no type errors.

- [ ] **Step 6: Manual smoke**

Launch the app (`/run` skill or the repo dev command). Create an interval schedule ("every 2 hours"), a daily catch-up schedule, edit one, delete one. Confirm they appear in the list and persist after restart.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/screens/Scheduler.tsx
git commit -m "feat(desktop): Scheduler supports interval, catch-up, session target + edit"
```

---

### Task 10: Desktop composer — recurring option

**Files:**
- Modify: `apps/desktop/src/screens/ProjectDetail.tsx` — `SchedulePicker` (~`:2086-2130`)

**Interfaces:**
- Consumes: `api.createSchedule` (recurring) alongside the existing `api.scheduleMessage` (one-shot).
- Produces: the clock popover offers a "Repeat" path (daily-at-time or every-N-hours) that creates a recurring schedule bound to the current project + session, carrying the composer prompt/effort/browser.

- [ ] **Step 1: Read SchedulePicker fully**

Read `ProjectDetail.tsx:2044-2130` to learn the popover structure, the current `scheduleMessage` call, and how it reads the composer's prompt/effort/browser.

- [ ] **Step 2: Add a repeat toggle + cadence inputs**

Add a "Repeat" switch in the popover. When on, show a small choice: "Every N hours" (number) or "Daily at" (time) + a "Catch up if missed" checkbox. When off, the existing one-shot presets remain.

- [ ] **Step 3: Branch the save**

On save: if repeat is off → existing `api.scheduleMessage(...)`. If on → `api.createSchedule({ title: prompt.slice(0,60), projectId, sessionId, prompt, everyMinutes?, time?, cadence: 'daily', catchUp, effort, browser })`.

- [ ] **Step 4: Build + manual smoke**

Run: `cd apps/desktop && pnpm build`. Launch, open a chat, schedule a recurring message from the composer, confirm it shows in the Scheduler list.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/screens/ProjectDetail.tsx
git commit -m "feat(desktop): composer can create recurring schedules, not just one-shots"
```

---

### Task 11: Mobile — create/edit schedules + late alert

**Files:**
- Modify: `apps/mobile/src/screens/Queue.tsx` (add create + edit)
- Modify: `apps/mobile/src/LiveNotifier.tsx` (handle `schedule-late`)

**Interfaces:**
- Consumes: `api.createSchedule`, `api.updateSchedule`, `api.deleteSchedule`, `api.toggleSchedule`; SSE `schedule-late` event (Task 3, fanned out by the relay).
- Produces: a mobile create/edit sheet mirroring desktop fields; a loud alert + banner when a schedule runs late.

- [ ] **Step 1: Read Queue.tsx + LiveNotifier.tsx fully**

Read both files to match the existing section layout, theme tokens, and the `useLive(['schedule'])` + alert patterns.

- [ ] **Step 2: Add a create/edit sheet to Queue**

Add a "+" header button opening a modal with: project picker (from `api.listProjects()`), optional session picker, prompt text, recurrence choice (every-N-hours OR daily-at-time), and a catch-up switch. On save call `api.createSchedule(...)`. Long-press a recurring row → edit (prefill + `api.updateSchedule`) or delete (existing `cancel`).

- [ ] **Step 3: Handle schedule-late in LiveNotifier**

In `LiveNotifier.tsx`, where it subscribes to SSE events (alongside the `approval`/`job` handlers, ~`:54`), add a `schedule-late` handler:

```typescript
    // A scheduled task missed its time and ran late — alert the operator.
    if (name === 'schedule-late') {
      const d = data as { title?: string };
      fireAlert('Scheduled task ran late', `“${d?.title ?? 'A schedule'}” caught up.`);
      show({ tint: theme.color.orange, icon: 'clock', title: 'Ran late', body: `“${d?.title ?? 'A schedule'}” caught up.` });
    }
```

Confirm the SSE subscription includes `schedule-late` (the relay forwards all events; ensure the mobile `useLive`/event-source listener isn't filtering it out — add it to the subscribed list if needed).

- [ ] **Step 4: Typecheck mobile**

Run: `cd apps/mobile && pnpm exec tsc --noEmit` (or the repo's mobile typecheck).
Expected: PASS.

- [ ] **Step 5: Manual smoke**

Run the mobile app against the paired Mac. Create a schedule from the phone, confirm it appears on desktop (SSE), edit + delete it, and verify a late fire raises the alert.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/src/screens/Queue.tsx apps/mobile/src/LiveNotifier.tsx
git commit -m "feat(mobile): create/edit schedules + late-run alert"
```

---

## Self-Review

**Spec coverage:**
- Interval cadences → Tasks 1, 2, 9, 10, 11. ✓
- Catch-up / missed-run + "ran late" notice → Tasks 1, 3, 4, 11. ✓
- Agent MCP surface (CRUD + project/session discovery) → Tasks 5, 6. ✓
- Project/session scoping inherited from existing model + targetable by agent/UI → Tasks 5, 6, 9, 11. ✓
- Full edit + delete on desktop, mobile, agent → Tasks 6, 7, 8, 9, 11. ✓
- Relay PATCH (the missing edit endpoint) → Task 8. ✓
- WhatsApp example (prompt-driven, no special field) → realized by Task 6 tools + Task 9/11 UI; no schema work needed. ✓
- No regression to one-shot/auto-continue/auto-answer → verified in Task 3 Step 5 (runs `cron.message.test.ts`). ✓

**Placeholder scan:** One intentional placeholder in Task 5 Step 4 (`hasMemory`) is explicitly resolved in Step 5 against the real memory accessor — not left as TBD.

**Type consistency:** `everyMinutes`/`anchorAt`/`catchUp`/`catchUpWindowMs`/`lastDueAt`/`lastFireLate` are named identically across `store.ts` (Task 1), `api.ts` (Task 7), `ScheduleCtx` (Task 5), MCP tools (Task 6). `markScheduleRun(id, ts, nextRun, opts?)` defined in Task 1, used in Task 3. `fireNow` defined in Task 5 Step 1, used by `runNow` (Task 5) + tested (Task 5 Step 2). `humanRecurrence` defined + used in Task 5. `schedule-late` event emitted in Task 3, consumed in Tasks 4 + 11.

**Risks to verify during execution:** (a) exact test script names in `apps/desktop/package.json`; (b) `Store` accessor names `listSessions`/`getProject`/`listProjects` + a project-memory accessor for `hasMemory`; (c) `engine` is created before `cron` in `main.ts` — the `setCron` setter (Task 6 Step 1) handles the ordering; (d) the mobile SSE listener must not filter out `schedule-late`.
