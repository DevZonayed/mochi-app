# SP1 — Model picker redesign + per-role (primary/reviewer) defaults

**Date:** 2026-06-13
**Status:** Design — awaiting user review
**Part of:** "Coding engine, Conductor-class" program (sub-project 1 of 8)
**Depends on:** nothing external. **Feeds:** SP2 (goal mode), SP3 (parallel review loop).

---

## 1. Goal

Replace Maestro's flat model dropdown (Auto / Claude / Sonnet / Haiku / Codex, all tagged "auto") with a **provider-grouped model picker** (per reference `UJEpUl`), and make the coding agent run with two explicitly chosen roles:

- a **Primary** model (writes the code), and
- a **Reviewer** model (reviews it) — with a sane default, per-chat override, and an **Off** switch.

This sub-project establishes *selecting, storing, and showing* those two models. It does **not** build the parallel review loop itself (that is SP3) or goal mode (SP2).

## 2. Decisions locked in brainstorming

1. **Cursor is a real engine.** Add `cursor` as a provider/engine alongside `claude` and `codex`, driven by Cursor's headless CLI the same way Codex's `codex exec` is driven. If the Cursor CLI is absent/not-signed-in, Cursor is *listed but unrunnable* with an honest "not signed in" reason — never faked.
2. **The model list comes from the providers.** The catalog is owned by the engine/provider layer, not hardcoded in the UI. Each provider contributes its models; the UI renders whatever `listModels()` returns.
3. **Reviewer = default + per-chat override + disable.** A workspace default is set in Settings; any chat may override the primary and/or reviewer, and may switch the reviewer **Off**.

## 3. Scope

**In:** provider-owned model registry; `listModels()` API + relay route; new grouped picker component; role data model (`primary` / `reviewer|off`); Settings → Engines role pickers; composer primary picker + reviewer chip; per-chat + per-job persistence; Cursor provider + engine; `engineStatus` extended to Cursor; types mirrored to `api.ts` + mobile.

**Out (later sub-projects):** the parallel review *loop* and its chat UI (SP3); goal mode (SP2); the `image`/`video` routing roles (kept dormant, untouched).

## 4. Architecture

### 4.1 Provider-owned model registry — `apps/desktop/electron/models.ts` (new)

Each provider exposes a catalog. A `ModelDescriptor` is:

```ts
interface ModelDescriptor {
  id: string;            // engine-native model id passed to the run (e.g. 'claude-opus-4-8', codex '-m' value, cursor model id)
  key: string;           // stable picker id, 'claude:opus-4-8' | 'codex:gpt-5.x' | 'cursor:composer-2.5'
  label: string;         // 'Opus 4.8'
  provider: 'claude' | 'codex' | 'cursor';
  family?: string;       // 'Opus' | 'Sonnet' | 'Haiku' | 'Fable' | 'GPT' | 'Composer'
  badge?: 'NEW';
  tierNote?: string;     // 'Most capable' | 'Balanced' | 'Fastest'
  external?: boolean;    // show the ↗ glyph (provider runs out-of-process)
}
```

`listModels()` returns providers in fixed order with their catalogs **and** a `runnable`/`reason` per provider derived from the existing `engineStatus(engine)` — so unrunnable providers render greyed with the same "sign in" hint we already show. Where a provider exposes a live list it is fetched and merged:

- **Claude:** the curated current catalog — Fable 5 (`claude-fable-5`, NEW), Opus 4.8 (`claude-opus-4-8`), Sonnet 4.6 (`claude-sonnet-4-6`), Haiku 4.5 (`claude-haiku-4-5-20251001`). If an **Anthropic API key** is connected, also fetch `GET /v1/models` live and merge (subscription login has no list endpoint, so the curated catalog is the source there). Exact ids re-verified at build against the Agent SDK + `claude-api` skill.
- **Codex:** the Codex default plus any models the `codex` CLI exposes via `-m` (probed at build; wrong/unknown id surfaces as an honest run error, matching today's behavior).
- **Cursor:** Composer (+ any models the Cursor CLI exposes). Catalog maintained in the cursor provider module.

"Comes from providers" = the catalog lives in / is sourced by the provider modules and the engine layer, surfaced through one `listModels()` call; the renderer never hardcodes the list.

### 4.2 Role data model — `apps/desktop/electron/store.ts`

Upgrade the engine-only `routing` to model-level **roles**, keeping `image`/`video` untouched for compatibility:

```ts
interface RoleChoice { engine: EngineId; model?: string }  // model omitted = engine default
interface Roles {
  primary: RoleChoice;                 // default { engine: 'claude', model: 'claude-opus-4-8' }
  reviewer: RoleChoice | 'off';        // default 'off' (matches current reviewer default)
}
```

- Stored under the existing routing object (add `roles`; legacy `master`/`reviewer`/`image`/`video` retained, with `master`↔`primary.engine` and `reviewer`↔`reviewer` kept consistent by a small migration so nothing else breaks).
- `getRoles()` / `setRoles(patch)` dispatch methods; migration in `load()` seeds `roles` from existing `master`/`reviewer`.

### 4.3 Per-chat + per-job persistence

- **ChatSession** gains optional `primaryKey?` and `reviewer?: string | 'off'` — a chat remembers its overrides and restores them when reopened. Absent = use workspace defaults.
- **Job** already has `engine?`/`model?`; add `reviewerEngine?`/`reviewerModel?` so each run records exactly what it used (history + the future SP3 loop reads these).
- Composer override flow: a chat's effective primary/reviewer = session override ?? workspace default.

### 4.4 New grouped picker — `apps/desktop/src/lib/ModelPicker.tsx` (new; replaces `ModelSwitcher`)

Renders `listModels()` grouped by provider (per `UJEpUl`): section header with provider glyph; rows = glyph · label · `NEW` badge · ⌘-number shortcut (1–9 across the flattened runnable list) · ★ favorite · ✓ when selected; greyed + "sign in" hint when not runnable; ↗ when `external`. Keyboard: ↑/↓ move, number keys jump, Enter selects, ⌘K-style filter. Favorites persisted in store settings (`favoriteModels: string[]`) so they sync to mobile/relay. One component, three mount points: composer primary, composer reviewer chip, Settings role pickers.

### 4.5 Composer integration — `apps/desktop/src/screens/ProjectDetail.tsx` (`ChatThread`)

`ChatThread` is shared by the project view **and** the Workspace tabs, so wiring the picker here makes the model "selectable from the workspace" automatically (your requirement) as well as per-job.

- The current `ModelSwitcher` pill → the new picker bound to the chat's **Primary**.
- New compact **`Reviewer: <label> ▾`** chip beside it; opens the same picker with an extra **Off** row; writes the session reviewer override.
- On send, `sendChat` carries `{ engine, model }` (primary, as today) **plus** `{ reviewerEngine, reviewerModel | off }`; `localApi` persists them on the job and (when the user changed them) on the session.

### 4.6 Settings → Engines pane — `apps/desktop/src/screens/Settings.tsx`

The `master`/`reviewer` dropdowns become two **role pickers** (Primary, Reviewer-or-Off) using the new component, writing `setRoles`. The status grid gains a **Cursor** row. `image`/`video` rows stay as-is.

### 4.7 Cursor engine — `apps/desktop/electron/engine.ts` + `providers.ts`

- `EngineId += 'cursor'`; `providers.ts` detects Cursor sign-in (CLI auth file / `cursor-agent` presence) and reports via `engineStatus('cursor')`.
- A `runCursor()` modeled on `runCodex()`: spawn the Cursor headless CLI, stream stdout → transcript frames, support cancel via child kill, cost per its output (0 if subscription). **Exact CLI invocation verified at build;** if no driveable CLI exists, Cursor stays listed-but-unrunnable (honest), and SP1 still ships with Claude + Codex fully working.

### 4.8 Plumbing

- **Dispatch (`localApi.ts`):** `listModels`, `getRoles`, `setRoles`; extend `sendChat`/`runJob` to accept reviewer fields.
- **Relay (`server.ts`):** `GET /api/models` (from snapshot), `POST /api/roles`; snapshot gains `models` + `roles`.
- **Clients:** mirror `ModelDescriptor`, `Roles`, new session/job fields into `apps/desktop/src/lib/api.ts` and `apps/mobile/src/api.ts`.
- **engineStatus:** returns claude + codex + cursor.

## 5. Honesty & fallbacks

- Unrunnable providers/models are shown greyed with the real reason (reuses `engineStatus`) — never hidden, never faked.
- Selecting an unrunnable model is blocked with the sign-in hint.
- If a saved role model later becomes invalid (e.g. provider signed out), the run falls back to the engine default and the chat surfaces why — same pattern as today's master-unavailable fallback.

## 6. Risks

- **Cursor CLI** is the one real unknown — whether a driveable headless `cursor-agent` exists with a stable JSON/stream contract. Mitigation: registry + status ship regardless; the run engine degrades to honest "not signed in" if the CLI isn't there. Confirmed at build before wiring `runCursor`.
- **Model enumeration on subscription login** (Claude/Codex) isn't a clean API. Mitigation: provider-maintained catalog is the source; live fetch only where it genuinely exists (Anthropic API key).
- **Model-id drift.** Ids live in one place per provider module; verified at build against the SDK/CLI + `claude-api` skill.

## 7. Verification (live, via CDP — same as prior work)

1. Picker renders grouped (Claude / Codex / Cursor), shortcuts + ★ + ✓ work, unrunnable greyed with hint.
2. Set workspace Primary=Opus 4.8, Reviewer=Codex in Settings → persists + appears in composer.
3. Per-chat: override Primary to Sonnet and switch Reviewer Off → persists on the session, restores on reopen, does not change other chats.
4. Run a chat → job records the exact `engine/model` (+ reviewer fields).
5. Cursor: signed-out shows honest "not signed in"; if CLI present, a Cursor run streams.
6. `tsc` clean on desktop + mobile + server; relay `GET /api/models` returns the catalog with a Bearer token.

## 8. Out of scope (explicit)

Parallel review execution (SP3), goal mode (SP2), image/video roles. SP1 makes selection real; SP3 consumes it.
