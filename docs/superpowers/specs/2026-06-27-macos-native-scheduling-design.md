# Native macOS Scheduling — Design Spec

**Date:** 2026-06-27
**Branch:** `DevZonayed/native-mac-architecture`
**Status:** Implemented in the native macOS workspace and verified

## 1. Problem & goal

The native SwiftUI app (`MacOS/`) shipped P0–P5 of the migration (Codespace,
Design, Comms, WhatsApp, Settings) but **scheduling was never ported**. The
Electron app had three scheduling surfaces; the native app has none — no
screen, no calendar, no list, no composer button. The `clock`/`calendar`
icons exist in `Icon.swift` but are unused.

**The backend dispatch is reachable** over the sidecar WebSocket bridge, and the
native sidecar now starts the same `CronRunner` used by Electron so scheduled
messages and recurring jobs actually fire. Goal: faithfully port all three
Electron scheduling surfaces to SwiftUI, reusing existing app patterns.

## 2. Backend contract (already live — verified in `apps/desktop/electron/localApi.ts`)

All reachable today through `MaestroClient.call(...)`:

| Method | Params | Returns | Emits `schedule` event |
|---|---|---|---|
| `listSchedules` | — | `Schedule[]` | — |
| `scheduleMessage` | `{ fireAt, prompt, sessionId?, projectId?, effort?, browser?, plan?, goal? }` | `Schedule` | full record |
| `createSchedule` | `{ title, projectId?, time?, cadence?, fireAt?, sessionId?, prompt?, everyMinutes?, catchUp?, effort?, browser?, plan? }` | `Schedule` | full record |
| `updateSchedule` | `{ id, title?, prompt?, time?, cadence?, everyMinutes?, catchUp?, enabled?, effort?, browser?, plan?, sessionId?, projectId? }` | `Schedule` | full record |
| `toggleSchedule` | `{ id, enabled }` | `{ ok: true }` | partial `{ id, enabled }` |
| `deleteSchedule` | `{ id }` | `{ ok: true }` | `{ id, deleted: true }` |

Validation to respect in the UI:
- `scheduleMessage.fireAt` must be **≥ now + 30s** (cron tick floor). The picker
  enforces this and disables the confirm button otherwise.
- `createSchedule.title` is required (we derive it from the prompt).
- One-shot = `fireAt` set, no recurrence. Recurring = `everyMinutes` (interval)
  **or** `time` + `cadence` (daily / specific weekdays).
- `cadence` is a free string the brain parses: `daily`, `weekdays`, `weekend`,
  or a comma list like `Mon, Wed, Fri`.

**No `fireNow` RPC exists** → "Run now" is **out of scope** (matches Electron,
where neither the queue nor the Scheduler had a manual-fire button). The
CronRunner ticks every 30s; firing tolerance ±90s.

Because the `schedule` event arrives in three shapes (full / `{id,enabled}` /
`{id,deleted}`), the store **reloads `listSchedules` on any `schedule` event**
(the existing `ProjectsStore`/`WhatsAppStore` pattern) rather than decoding
partial patches. User-initiated mutations also update locally (optimistic) for
snappiness.

## 3. Shared model & store

### `Schedule` (add to `Core/Models.swift`)
Lenient `Codable` mirroring `store.ts`'s `Schedule` (model only the fields the
UI renders; unknown keys ignored):

```
id, projectId?, title, time?, cadence?, enabled, nextRun?, lastRun?, createdAt,
fireAt?, sessionId?, prompt?, kind?, effort?, browser?, plan?, goal?,
everyMinutes?, catchUp?, paused?
```
Computed helpers on the struct:
- `isOneShot` → `fireAt != nil && everyMinutes == nil && (time == nil)`
- `isInterval` → `everyMinutes != nil`
- `recurrenceLabel` → "Every day at 09:00" / "Weekdays at 14:30" /
  "Mon, Wed, Fri at 09:00" / "Every 3 hours" / "Once".
- `kindTint` → message = blue, auto-continue/keep-going = purple,
  auto-answer = orange, whatsapp-analyze = green, retry-run = orange.
- `kindBadge` → short uppercase label for non-`message` kinds (these are
  system-created; shown read-only in lists, never editable).

### `ScheduleStore` (new `Features/Schedule/ScheduleStore.swift`)
`@Observable @MainActor`, constructed with `MaestroClient`, mirrors
`WhatsAppStore` lifecycle:
- State: `schedules: [Schedule]`, `loading`, `error`.
- `start()` → subscribe to `schedule` events (→ `reload()`), then `reload()`.
- `stop()` → `removeHandler`.
- `reload()` → `client.call("listSchedules", as: [Schedule].self)`, sorted by
  next fire time.
- Mutations (optimistic local update, then fire RPC, then event reconciles):
  `scheduleMessage(...)`, `createRecurring(...)`, `update(...)`, `setEnabled(_:_:)`,
  `delete(_:)`.
- Derived: `byProject` (grouped, sorted), `pending(forSession:)` (filter for the
  inline queue: `kind == "message"`/one-shot user messages for that session).

A **single ScheduleStore instance** is created per consuming view
(`ScheduleView` and the inline queue host). Two subscriptions are cheap; each
reloads independently. (No app-level singleton — keeps lifecycle simple and
matches every other store.)

### Live countdowns
Use SwiftUI `TimelineView(.periodic(from: .now, by: 1))` to drive countdown
text and the calendar now-line — ticks only while on-screen, no manual `Timer`.
Countdown formatting (`fmtCountdown`) and friendly time (`fmtWhen`) ported 1:1
from `ProjectDetail.tsx`:
- `fmtCountdown`: `2d 3h 12m` / `1h 04m 09s` / `9m 05s` / `45s` / `now`.
- `fmtWhen`: `Today 3:00 PM` / `Tomorrow 9:00 AM` / `Fri Jun 19, 9:00 AM`.

## 4. Surface A — dedicated Schedule screen

**Navigation:** add `case schedule` to `Route` (icon `clock`, label "Schedule")
and append it to `Route.navBar` so it becomes a **5th top-level nav pill** after
WhatsApp. Wire `RootView.routeContent` → `ScheduleView()`.

**`ScheduleView` layout** (new `Features/Schedule/ScheduleView.swift`):
- Header row: title "Schedule", a `SegmentedControl` toggling **Calendar ⇄
  List**, and a primary `PillButton("New schedule", icon: "plus")` opening the
  sheet in create mode.
- Empty state (no schedules): clock-glyph hero + "Nothing scheduled" +
  "Schedule a message from any chat, or create a recurring task."

**List view** (`ScheduleListView`):
- Grouped by project (project name header; "No project" group last), using
  `GroupedList`/`GLRow`.
- Each row: kind dot (tinted, breathing when firing ≤60s) · title/prompt
  (1 line) · `recurrenceLabel` + next-fire `fmtWhen` · live countdown
  (monospace, right-aligned, orange when ≤60s) · `MSwitch` enabled toggle
  (user kinds only) · edit (`pencil`) · delete (`trash`).
- System-kind rows (auto-continue, etc.) show their badge and are read-only
  except delete.

**Calendar view** (`ScheduleCalendarView`):
- Week grid: 7 day columns (Mon–Sun, current week, with prev/next week chevrons),
  hour rows (default 06:00–22:00, auto-expanded to include any scheduled hour).
- Time-anchored schedules (one-shot `fireAt`; daily/specific-day `time`) render
  as tappable chips in their day×hour slot, tinted by kind. Tap → edit sheet.
- **Interval** (`everyMinutes`) schedules have no single time-of-day → shown as
  an "every Nh" all-day chip at the top of each day column (the List remains the
  full source of truth for them).
- Live red **now-line** across today's column via `TimelineView`.

## 5. Surface B — composer schedule button + picker

**`Composer.swift`** gains one control in `controlsRow`, placed right of the
toggles (before the trailing `Spacer`): a `clock` "Schedule" button, enabled
only when `canSend && !disabled`. Active (popover open) state tints blue, matching the
Electron button. Implementation:
- Add to `Composer`: `@State private var schedOpen = false` and a new closure
  prop `onSchedule: (ScheduleRequest) -> Void` where `ScheduleRequest` is either
  `.once(fireAt: Double)` or `.repeating(RepeatOpts)`.
- The button toggles a `.popover` hosting **`SchedulePicker`**.

**`SchedulePicker`** (new `Features/Schedule/SchedulePicker.swift`), 284pt
popover, ported 1:1:
- Header "Schedule this message" + **Once / Repeat** segmented control.
- **Once:** quick-preset pills (In 15 min, In 1 hour, Tonight 8 PM, Tomorrow
  9 AM — only those still in the future) · `DatePicker` (date, `.field` style,
  min today) + time · validation line ("Fires Today 3:00 PM · in 4h 32m" /
  "Pick a time at least 30s ahead" in red) · "Schedule" confirm (disabled until
  valid).
- **Repeat:** Daily-at (time) / Every-N-hours (number) inner toggle ·
  "Catch up if missed (same day)" checkbox · "Schedule repeating" confirm.

**Wiring in `ChatThread.send` host:** `onSchedule` calls
`store.scheduleMessage(...)` (once) or `store.createRecurring(...)` (repeat),
passing the composer's current `text`, `effort`, `plan`, `goal`, `model`, then
clears the composer text on success and shows a brief confirmation. `ChatThread`
owns a `ScheduleStore` for this (also feeds Surface C).

## 6. Surface C — inline "N scheduled" queue

In `ChatThread`, above the `Composer` (sibling to the existing `bgPanel`),
render **`ScheduledQueuePanel`** when `store.pending(forSession: sessionId)` is
non-empty:
- Collapsible header: `clock` (blue) + "N scheduled message(s)" + rotating
  chevron. Collapsed state in local `@State` (default expanded).
- Each row (live, `TimelineView`-driven): breathing kind dot · title (1 line) ·
  `fmtWhen(fireAt)` · countdown badge · edit (`pencil`, refills composer text +
  reopens picker, then deletes the old one on reschedule) · cancel (`x` →
  `delete`). Styling mirrors `bgPanel` (bgGrouped, 12pt radius, hairline).

## 7. Fidelity / tokens

Use existing primitives only: `Tok.*` colors, `TokFont.*`, `Icon`, `PillButton`,
`IconButton`, `SegmentedControl`, `MSwitch`, `GroupedList`/`GLRow`, `Spinner`,
`.pressable()`, `.hoverFill()`, `.cardShadow()`. Breathing dot = a scale/opacity
`repeatForever` animation. No new colors or fonts. `clock`/`calendar`/`pencil`/
`trash`/`x`/`plus`/`chevronRight` already exist in `Icon.sfMap`.

## 8. Implementation plan (ordered, each step keeps `swift build` green)

1. **Model** — add `Schedule` + helpers and `ScheduleRequest`/`RepeatOpts` to
   `Core/Models.swift`; add `fmtCountdown`/`fmtWhen`/cadence helpers (new
   `Features/Schedule/ScheduleFormat.swift`).
2. **Store** — `Features/Schedule/ScheduleStore.swift`.
3. **Nav** — `Route.schedule` (+ label/icon/navBar) in `AppEnv.swift`;
   `RootView` switch → `ScheduleView`.
4. **Screen** — `ScheduleView` + `ScheduleListView` + `ScheduleCalendarView` +
   `ScheduleSheet` (create/edit form: project, run target [new session vs.
   existing chat], when [Once/Daily/Every-N-hours/Specific-days + catch-up],
   prompt, effort, browser).
5. **Picker** — `SchedulePicker.swift`.
6. **Composer** — add schedule button + `onSchedule`; thread through
   `ChatThread`.
7. **Queue** — `ScheduledQueuePanel.swift`; mount in `ChatThread`.
8. **Build & verify** (§9).

New files under `MacOS/app/Sources/Maestro/Features/Schedule/`:
`ScheduleStore.swift`, `ScheduleFormat.swift`, `ScheduleView.swift`,
`ScheduleListView.swift`, `ScheduleCalendarView.swift`, `ScheduleSheet.swift`,
`SchedulePicker.swift`, `ScheduledQueuePanel.swift`.
Edited: `Core/Models.swift`, `App/AppEnv.swift`, `App/RootView.swift`,
`Features/Codespace/Chat/Composer.swift`, `Features/Codespace/Chat/ChatThread.swift`.

## 9. Verification

- `cd MacOS/app && swift build` is clean (primary gate — the project's standard
  verification; SwiftUI has no unit-test target here).
- `swift run Maestro --selftest`, `node MacOS/sidecar/src/smoke-test.mjs`,
  `node MacOS/sidecar/build.mjs --external-natives`, and
  `node MacOS/sidecar/src/smoke-test.mjs --bundle` pass against live local data.
- Pure logic (`fmtCountdown`, `fmtWhen`, cadence ↔ days, validation floor) is
  written as small pure functions; if a test target exists they get unit tests,
  otherwise they are exercised via a tiny `#if DEBUG` preview/selftest.
- Manual smoke (documented for the operator): nav shows Schedule; create a
  one-shot from the composer → appears in queue + list + calendar with a live
  countdown; toggle/edit/delete reflect immediately; a recurring daily schedule
  shows the right `recurrenceLabel` and calendar chips.

## 10. Out of scope

- No "Run now" (no RPC). No changes to the brain/sidecar. No new schedule
  *kinds* (we render the existing system kinds read-only but don't create them).
  No notifications wiring (separate feature). No mobile.
