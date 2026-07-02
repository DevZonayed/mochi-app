# Hide projects from the Projects view

**Date:** 2026-06-24
**Status:** Approved, ready for implementation

## Problem

The Maestro desktop Projects view (`apps/desktop/src/screens/Projects.tsx`)
shows every project as a card/row. There is no way to declutter the view by
hiding projects you don't want to see, short of deleting them (which removes
jobs/sessions/schedules and is irreversible for the project record).

We want a **reversible hide**: mark a project hidden so it drops out of the
default Projects view, with a way to reveal and unhide it. The flag should
sync to the mobile remote so the phone shows the same filtered list.

## Approach

Reuse the existing soft-state pattern. Projects already carry an optional
`order?` field and an `updatedAt` that drives the relay's delta-sync; sessions
already model a reversible `archived?` state. We add one optional boolean and
route it through the existing `updateProject` mutation — no new endpoint, no
migration, no server change.

## Data model

Add to the `Project` interface in **both** stores (kept in sync by hand today):

- `apps/desktop/electron/store.ts` — `hidden?: boolean`
- `apps/desktop/src/lib/api.ts` — `hidden?: boolean`
- `apps/mobile/src/api.ts` — `hidden?: boolean`

`undefined`/`false` = visible (so existing persisted projects need no
migration). `true` = hidden.

## Mutation path (reused, not new)

1. **store** — whitelist `hidden` in `updateProject`'s `Partial<Pick<…>>`
   patch type. `Object.assign` + `updatedAt = now()` already handle persistence
   and the delta-sync bump.
2. **localApi** (`apps/desktop/electron/localApi.ts`, `updateProject` case) —
   accept a boolean `hidden` into the patch: `if (typeof p.hidden === 'boolean')
   patch.hidden = p.hidden;`. The existing `emit('project', proj)` fans the
   updated project (with the flag) to renderer + relay.
3. **desktop api** (`apps/desktop/src/lib/api.ts`) — add `hidden` to the
   `updateProject` patch pick type. The IPC payload (`{ id, ...patch }`) and the
   REST fallback (`POST /api/projects/:id/update`) both carry it automatically.
4. **relay/server** — no change. The relay proxies `updateProject` and syncs the
   project JSON by `updatedAt`; the new field rides along.

## Desktop UI (`Projects.tsx`)

1. **Per-project menu.** Today each card/row has a trash-only button
   (`onMenu` → delete-confirm). Replace it with a small **⋯ menu** offering
   **Hide** and **Delete**. (Delete keeps its existing confirm dialog.)
2. **Default filter.** The loaded `projects` state is split into visible
   (`!p.hidden`) and hidden. Grid, list, ⌘K palette, and empty-state logic all
   render the visible set.
3. **Reveal toggle.** A subtle **"Hidden (N)"** chip near the view switcher
   toggles a `showHidden` flag. When on, hidden projects render dimmed with an
   **Unhide** action. N is derived from the already-loaded list — no extra fetch.
4. **Optimistic + undo.** Hiding/unhiding updates local state immediately and
   fires `api.updateProject(id, { hidden })` in the background (mirrors the
   existing optimistic `deleteProject`). Show an undo affordance (toast or the
   reveal chip) so an accidental hide is one click to reverse.

`hidden` is a renderer-local concept on the `Project` row type built by
`toRow`; carry it through from the `ApiProject`.

## Mobile UI (`apps/mobile/src/screens/Projects.tsx`)

One-line filter: exclude `p.hidden` from the rendered list. The flag arrives
via the existing sync. No mobile-side mutation UI in this iteration (hide is
driven from the Mac, which is the brain).

## Testing

- **Store unit test** (new, following `store.reorder.test.ts`):
  - `updateProject(id, { hidden: true })` persists and is returned by
    `getProject`/`listProjects`.
  - `updatedAt` is bumped on hide and on unhide.
  - Round-trip: hide → unhide returns to visible.
  - Survives a reload (new `Store` over the same data dir).
- **localApi**: `hidden` boolean is accepted into the patch and emitted;
  non-boolean is ignored.
- **UI**: verified by running the app — hide a project, confirm it leaves the
  grid, reveal via "Hidden (N)", unhide, confirm it returns.

## Out of scope (YAGNI)

- Bulk hide/unhide.
- Hiding sessions/chats (sessions already have `archived`).
- A mobile-side hide control (desktop-driven only for now).
- Per-device hide (the flag is project-global and syncs to all clients).
