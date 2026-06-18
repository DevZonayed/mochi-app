# Schedule Management Overhaul + Agent MCP Control

**Date:** 2026-06-18
**Branch:** DevZonayed/chennai
**Status:** Approved design, pre-implementation

## Problem

The current scheduler supports recurring clock-time schedules (a single `HH:MM` + day-of-week cadence) and one-shot scheduled messages (`fireAt`). It cannot express interval cadences ("every 2 / 3 hours"), it is strictly forward-only (a run missed while the Mac is asleep is silently skipped), recurring schedules can only be toggled/deleted over the wire (no full edit), and the in-app agent has **no** MCP tools to inspect or manage schedules and projects. The operator wants schedules that:

- run on intervals **or** at clock times, globally **or** bound to a specific project + session (so the run inherits that project's `.continuum` memory),
- catch up if a run was missed (e.g. "every day 9am; if missed, fire anytime later that day") and announce that it ran late,
- are fully editable and deletable from desktop, mobile, and **by the in-app agent itself**,
- are exposed through a proper MCP surface so the agent can discover what exists and create/modify every schedule and project firing autonomously.

## Non-goals (YAGNI)

- No structured "delivery channel" field on a schedule. Delivery is prompt-driven: the prompt says "send the summary to my private chat" and the agent does it via the comms/WhatsApp MCP.
- No backfill of *multiple* missed slots — at most **one** catch-up per missed slot.
- No per-schedule timezone. All clock times are the Mac's local time (unchanged from today).
- No new persistence engine — extend the existing JSON store.

## Existing system (baseline)

- **Data model:** `apps/desktop/electron/store.ts` — `Schedule` interface (id, projectId, title, time, cadence, enabled, nextRun, lastRun, fireAt, sessionId, prompt, kind, effort, browser, plan, goal, armedAt, extends, paused). CRUD: `createSchedule`/`updateSchedule`/`setScheduleEnabled`/`markScheduleRun`/`setScheduleNextRun`/`deleteSchedule`/`listSchedules`.
- **Runner:** `apps/desktop/electron/cron.ts` — `CronRunner` ticks every `TICK_MS = 30_000`; `cadenceDays()` + `nextOccurrence()` compute the next clock-time slot; `fire()` creates a real `Job` in the target project/session carrying engine/model/effort/browser/plan/goal and runs it fire-and-forget.
- **Agent tools:** `apps/desktop/electron/engine.ts:492` — `maestroServer = createSdkMcpServer({ tools: [...] })` exposes `mcp__maestro__*` (image, skills, background, browser). An allowed-tools list (~line 649) gates which are active per run. **No schedule/project tools exist.**
- **Contract:** `apps/desktop/electron/localApi.ts` handlers (`createSchedule`, `toggleSchedule`, `deleteSchedule`, `scheduleCheck`, `scheduleMessage`, `extendQuestion`) → `apps/desktop/src/lib/api.ts` client → relay `apps/server/src/server.ts` (`GET /api/schedules`, `POST /api/schedules`, `/schedules/message`, `/schedules/check`, `/schedules/:id/toggle`, `/schedules/:id/delete`). Mutations emit `('schedule', …)` → SSE `/api/stream` fan-out to phone/web. **There is no full-edit (PATCH) endpoint.**
- **UI:** desktop `Scheduler.tsx` (calendar + list, create/edit/delete), composer `SchedulePicker`/`ScheduledQueue` in `ProjectDetail.tsx`; mobile `Queue.tsx` (display-only, no create/edit).

## Architecture invariant

The Mac is the brain. All schedule state, the cron tick, and firing stay on the desktop. The relay only mirrors and forwards. The new agent MCP tools execute **in-process on the desktop** against the same `store`/`cron`, not on the server.

---

## Part 1 — Engine: recurrence + catch-up (lands first)

### 1.1 Data model (`store.ts` `Schedule`)

Add fields (all optional, back-compatible — existing schedules keep working unchanged):

| Field | Type | Meaning |
|---|---|---|
| `everyMinutes?` | `number` | Interval cadence. When set, the schedule is interval-mode (ignores `time`/`cadence`). e.g. 120 = every 2h, 180 = every 3h. |
| `anchorAt?` | `number` | Epoch ms the interval counts from. Defaults to `createdAt`. |
| `catchUp?` | `boolean` | If a clock-time slot was missed, fire once when the Mac is next awake within the window. Default `false` (preserves current forward-only behavior unless opted in). |
| `catchUpWindowMs?` | `number` | How long after the due time a catch-up is still allowed. Default = remainder of the local day (until next local midnight). |
| `lastDueAt?` | `number` | The *intended* due timestamp of the most recent fire. Dedupe key so a given missed slot catches up at most once. |
| `lastFireLate?` | `boolean` | True when the most recent fire was a catch-up; drives the "ran late" notice. |

Modes are mutually exclusive: a schedule is **interval-mode** iff `everyMinutes > 0`, else **clock-mode** (`time` + `cadence`), else **one-shot** (`fireAt`, unchanged). `createSchedule`/`updateSchedule` validate this and persist the new fields. `updateSchedule`'s patch set widens to include `title`, `prompt`, `time`, `cadence`, `everyMinutes`, `anchorAt`, `catchUp`, `catchUpWindowMs`, `effort`, `browser`, `plan`, `goal`, `sessionId`, `projectId`, `enabled`, and re-derives `nextRun`.

### 1.2 Runner (`cron.ts`)

- **`nextOccurrence(s, from)`** — extend for interval-mode: `anchor = s.anchorAt ?? s.createdAt`; `every = everyMinutes*60_000`; next = `anchor + ceil((from - anchor)/every) * every` (strictly after `from`). Clock-mode unchanged.
- **`tick()`** — when `nextRun <= now`:
  - Compute `late = now - nextRun > LATE_TOLERANCE_MS` (e.g. 90s, the existing double-fire guard).
  - **Interval-mode:** fire on-time/slightly-late as today; never "catch up" stale interval slots (just advance to the next slot from `now`).
  - **Clock-mode, on time:** fire, advance.
  - **Clock-mode, missed (late):**
    - if `catchUp` and `now <= dueTime + window` and `lastDueAt !== dueTime` → fire as **catch-up** (`lastFireLate = true`, set `lastDueAt = dueTime`), then advance to next slot.
    - else → roll forward to next slot, **no fire** (current behavior).
  - Always update `nextRun` for the UI.
- **`start()`** — stop unconditionally skipping missed slots forward. Initialize `nextRun` from persisted value (or compute if absent) so a slot that came due while the app was closed can be evaluated for catch-up on the first tick after wake.
- **`fire(s, { late })`** — unchanged job creation, plus: when `late`, emit a `('schedule-late', { id, title, dueAt, firedAt })` event. `main.ts` wiring turns that into a desktop notification + phone push ("Scheduled '<title>' ran late") via the existing device-notification/push path. Set `lastRun`, `lastDueAt`, `lastFireLate` via `markScheduleRun`.

### 1.3 Tests (`cron.test.ts`)

- `nextOccurrence` interval: anchored, strictly-after, multiple step sizes.
- `nextOccurrence` clock: unchanged regression.
- Catch-up: missed slot within window fires once; second tick same slot does **not** re-fire (`lastDueAt` dedupe); missed slot past window rolls forward with no fire; `catchUp:false` never catches up.

---

## Part 2 — Agent MCP tools (lands second)

### 2.1 `scheduleCtx` bridge

Add a `ScheduleCtx` (like `bgCtx`/`browserCtx`) passed into the engine's `runJob`, wrapping `store` + `cron` with: `list(filter)`, `create(args)`, `update(id, patch)`, `del(id)`, `toggle(id, enabled)`, `runNow(id)`, `listProjects()`, `listSessions(projectId)`. Created in `main.ts` where `cron`/`store` exist and threaded through to `runJob`.

### 2.2 New `mcp__maestro__*` tools (`engine.ts` maestroServer + allowed-tools list)

- `schedule_list` `{ projectId? }` → schedules with id, title, prompt, human-readable recurrence, target project/session, enabled, nextRun, lastRun, lastFireLate.
- `schedule_create` `{ projectId?, sessionId?, title, prompt, recurrence: { everyMinutes } | { time, cadence?, days? }, effort?, browser?, plan?, catchUp? }` → created schedule.
- `schedule_update` `{ id, ...patch }` → updated schedule.
- `schedule_delete` `{ id }`.
- `schedule_toggle` `{ id, enabled }`.
- `schedule_run_now` `{ id }` → fires immediately so the agent can test a schedule it just created.
- `projects_list` `{}` → projects, each with `hasMemory` (whether `.continuum`/memory exists) + their sessions, so the agent can target "the project where my WhatsApp memories live".
- `sessions_list` `{ projectId }` → sessions for a project.

All are added to the allowed-tools gate so they're active in normal (non-plan) runs. A short tool-use directive (mirroring the existing browser directive at `engine.ts:81`) tells the agent these exist and when to use them ("to set up or change a recurring/scheduled task, use mcp__maestro__schedule_* ; discover targets with projects_list/sessions_list").

### 2.3 Tests (`store.mcp.test.ts` neighbor)

Exercise the `ScheduleCtx` CRUD + `runNow` against an in-memory store; assert recurrence parsing and project/session discovery shapes.

---

## Part 3 — Contract wiring (relay + clients)

- `localApi.ts`: extend `createSchedule`/`updateSchedule` handlers for the new fields; add an `updateSchedule` case if not already routed.
- `api.ts`: add `updateSchedule(id, patch)` to the client surface; widen `createSchedule` typing for recurrence/catch-up.
- `server.ts` relay: add **`PATCH /api/schedules/:id`** → forwarded to the Mac (full edit, used by mobile + agent-over-relay). Keep existing toggle/delete/create/message/check. All continue to emit `('schedule', …)` → SSE.
- Types shared via the existing shared types path so desktop/mobile/server agree on the `Schedule` shape.

---

## Part 4 — UI (lands third)

- **Desktop `Scheduler.tsx`:** add interval option ("Every N hours / minutes"), a "Catch up if missed" toggle, a project + session picker for binding recurring schedules, and full edit of prompt/effort/kind/target. Calendar mirroring (`cadenceColumns`) updated so interval schedules render sanely (or show as a list row with "every Nh").
- **Desktop composer `SchedulePicker` (`ProjectDetail.tsx`):** add a "make recurring" path (interval or daily-at-time) beside the existing one-shot presets, writing through `createSchedule`.
- **Mobile `Queue.tsx`:** add create + edit (today display-only) using the new `PATCH` endpoint and `createSchedule`, mirroring desktop fields; keep the queued/recurring split + live countdown.

---

## Worked example — WhatsApp daily summary

No special handling. The operator (or the agent via `schedule_create`) makes one schedule:

- **target:** the project holding the WhatsApp `.continuum`/comms memory + a dedicated session.
- **recurrence:** `{ time: "09:00", cadence: "daily" }`, `catchUp: true`, window = rest of day.
- **prompt:** "Pull the latest ~50 WhatsApp messages via the comms MCP, analyze the full conversation, and send me a summary to my private chat."

At 9am the cron fires it as a Job in that session; the agent runs the prompt with the comms/WhatsApp MCP tools and the project's memory. If the Mac was asleep at 9am, it catches up later that day and the operator gets a "ran late" notice.

## Testing & done criteria

- New/extended unit tests pass: `cron.test.ts` (recurrence + catch-up), `store.mcp.test.ts` (scheduleCtx CRUD), `mcp-config.test.ts` regressions.
- Desktop typecheck + build pass.
- Manual smoke: create an interval schedule and a catch-up daily schedule via the agent (`schedule_create`), `schedule_run_now`, edit it, delete it; verify SSE updates reach mobile; verify a missed catch-up fires + notifies.
- No regression to one-shot scheduled messages, auto-continue, or auto-answer schedules.

## Rollout

Engine → MCP → contract → UI, each landing independently behind the additive (default-off `catchUp`, optional `everyMinutes`) data model so partial landings never break existing schedules. Not deployed until the operator gives the go-ahead (per the deploy gate).
