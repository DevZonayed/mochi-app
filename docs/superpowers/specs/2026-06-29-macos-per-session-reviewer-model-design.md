# Per-session reviewer model — native macOS

**Date:** 2026-06-29
**Scope:** native macOS app only (`MacOS/app/`). No Electron renderer changes; no
shared-brain (`localApi.ts`/`engine.ts`) changes — they already support it.

## Problem

In the native macOS app each chat session can already pick its **primary** (worker)
model — the composer has a `ModelPicker` bound to `model`, remembered per session via
the `maestro.chat.models` AppStorage map and the brain's persisted `session.primary`.

The **reviewer** model has no such control. `ChatThread` holds a single hidden
`@State reviewerKey` seeded once from the global default (`getRoles().reviewer.key`,
`ChatThread.swift:35,145`). There is no picker and no per-session memory, so:

- The reviewer model is the same across every chat, and can't be changed in the UI.
- If the global default reviewer is `off` (it is, by default), turning the composer's
  **Review** toggle on does nothing — the engine gates review on
  `reviewerEnabled && reviewer != 'off'`, and the hidden `reviewerKey` is `off`.
- The composer's **Review** / **Autopilot** toggles are local `@State` that never
  restore from the session, so switching chats shows stale on/off state.

## Why no brain changes are needed

The end-to-end plumbing already honors a per-session reviewer model:

- `sendChat` persists `session.reviewer` (and `session.primary`) on every send
  (`localApi.ts:787–800`) and passes the resolved reviewer to `engine.run`.
- The scheduled/cron fire path passes `session.reviewer` too (`cron.ts:183`).
- The engine reviews with `opts.reviewer ?? roles.reviewer` (`engine.ts:3320`); the
  macOS app sends `reviewerKey` on every send, so `opts.reviewer` is always set.
- `listSessions` / the `session` event carry the full `ChatSession` (incl. `reviewer`,
  `reviewerEnabled`, `autoPilot`), which `WorkspaceStore.applySession` keeps fresh.

So the fix is purely the macOS UI binding the reviewer model to the session, exactly
the way primary already is.

## Design

Mirror the existing primary-model pattern for the reviewer, all in Swift.

### 1. `Core/Models.swift` — `ChatSession`
- Decode two fields the brain already sends: `reviewerEnabled: Bool?`, `autoPilot: Bool?`.
- Add computed `reviewerModelKey: String?` → the reviewer's picker key, or `nil` when
  the session's reviewer is `off`/unset (so the picker never shows `off`; the **Review**
  toggle owns on/off, the picker owns which model).

### 2. `Features/Codespace/Chat/Composer.swift`
- Add `@Binding var reviewerKey: String`.
- Add `onReviewChanged`/`onAutopilotChanged` callbacks fired **only** on a user tap of
  the Review/Autopilot pills (so programmatic restore doesn't write back to the brain).
- When **Review** is on, show a compact reviewer `ModelPicker` bound to `$reviewerKey`
  (trigger label "Reviews:") right after the Review pill.

### 3. `Features/Codespace/Chat/ChatThread.swift`
- Per-session reviewer memory: `maestro.chat.reviewers` AppStorage map +
  `chatReviewers()` / `setChatReviewer()` / `sessionReviewerKey()`, mirroring the
  primary `maestro.chat.models` helpers.
- `seedRoles()`: seed `reviewerKey` from saved (map → `session.reviewerModelKey`) →
  global `roles.reviewer` (if a choice) → leave empty so the picker self-seeds a real
  runnable model. Also seed the initial `review`/`autopilot` toggles from the session.
- On session switch: restore `reviewerKey` (`restoreReviewer(for:)`) and the
  `review`/`autopilot` toggles from the session — set `@State` directly, no brain write.
- Move the brain write-backs for Review/Autopilot from `.onChange` to the new tap
  callbacks (race-free during restore).
- `onChange(of: reviewerKey)`: persist to the local map only (brain persistence still
  happens on send, exactly like primary).
- When Review is turned on and `reviewerKey` is empty/`off`, seed a real runnable model
  from `ModelCatalogCache` so the first reviewed turn has a model.

## Result
- Each chat remembers its own reviewer model; switching chats restores it (and the
  Review/Autopilot toggles) from the session.
- Turning Review on always has a concrete reviewer model, so the engine actually runs it.
- Primary remains per-session (unchanged) — both controls are per-session.

## Verification
- `swift build` (MacOS package) green.
- Pure-logic check of the seed/restore precedence.
- Manual: pick reviewer in chat A, switch to B (different/none), switch back to A — A's
  reviewer restores; send and confirm the reviewer runs with the chosen model.
