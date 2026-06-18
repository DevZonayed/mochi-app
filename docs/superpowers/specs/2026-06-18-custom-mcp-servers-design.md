# Custom MCP servers (one-click add) with attached skills

**Date:** 2026-06-18
**Branch:** `DevZonayed/custom-mcp-one-click`
**Status:** approved design, ready for implementation plan

## Problem

There is no way to attach a real, external MCP server to Maestro. The existing
`McpGateway.tsx` Servers tab and ProjectDetail "Allowed MCP servers" render
**cosmetic** `Server` objects derived from `Skill` records (`kind:'mcp'`) with
hard-coded `transport:'HTTP'` / `scope:'read-only'`. The only MCP servers that
actually run are Maestro's own in-process `maestro` SDK server (Claude) and the
stdio shim bridge (Codex), both exposing only Maestro's own tools.

We want: **add any MCP server in one click** (stdio command or streamable HTTP),
**list/manage** them, and **attach skills to each server** so that when the
server is active in a run, the agent is made aware of those skills.

## Goals

1. A real, persisted custom-MCP-server data model with full launch config.
2. A "Connect to a custom MCP" form matching the provided screenshots
   (STDIO and Streamable HTTP modes) plus a managed list of servers.
3. Per-server skill attachment, reusing the existing skills registry/install infra.
4. Real engine wiring: enabled servers reach both Claude and Codex; attached
   skills are ensured-installed and surfaced in the prompt when their server is active.
5. Secrets stored **by env-var-name reference** (never the secret value).

## Non-goals (explicit, to bound scope)

- Per-project allow-listing of custom servers (follow-on; this pass is a global
  library with a global enable toggle — but the type carries the seam for it).
- Mobile UI for MCP management (follow-on; the relay REST routes will exist so it
  can be added later).
- OAuth flows for HTTP MCP servers (only static URL + bearer-env + headers, per
  the screenshots).

## Data model (`apps/desktop/electron/store.ts`)

New persisted array `mcpServers: CustomMcpServer[]` on the store data, plus a
parallel type in `apps/desktop/src/lib/api.ts`.

```ts
type KV = { key: string; value: string };

interface CustomMcpServer {
  id: string;
  name: string;                  // display + namespace (sanitized to [a-z0-9_-] for tool prefix)
  enabled: boolean;
  createdAt: number;
  transport: 'stdio' | 'http';

  // stdio
  command?: string;
  args?: string[];
  env?: KV[];                    // literal key=value (non-secret config)
  envPassthrough?: string[];    // host env var NAMES forwarded as-is
  cwd?: string;

  // http (streamable)
  url?: string;
  bearerTokenEnv?: string;      // env var NAME holding the bearer token
  headers?: KV[];               // literal header key=value
  headerEnv?: { key: string; valueEnv: string }[]; // header <- host env var NAME

  // skills bound to this server
  skillIds: string[];           // registry ids; installed on-demand when active
}
```

Store methods (mirroring `installedSkills` patterns):
`listMcpServers()`, `getMcpServer(id)`, `addMcpServer(input)`,
`updateMcpServer(id, patch)`, `removeMcpServer(id)`, `setMcpServerEnabled(id, on)`.
All call `this.save()`. Input is validated/normalized (trim, drop empty rows,
enforce transport-appropriate fields, sanitize name).

## Secrets handling

`env`/`headers` literal pairs are stored as-is (intended for non-secret config).
`bearerTokenEnv`, `envPassthrough`, `headerEnv.valueEnv` store the **name** of a
host environment variable; the value is resolved from `process.env` at spawn time.
This matches the screenshots ("Bearer token env var", "Environment variable
passthrough", "Headers from environment variables") and keeps secrets out of the
persisted store.

## IPC / API surface

`localApi.ts` dispatcher cases (validate, mutate store, `emit('mcpServers', list)`):
`listMcpServers`, `addMcpServer`, `updateMcpServer`, `removeMcpServer`,
`setMcpServerEnabled`.

`api.ts` client methods are **desktop-only** (Electron `call()` with a
`Promise.reject('desktop only')` fallback), exactly like the project-skill
methods — MCP config is Mac-local (the Mac is the brain), so there is no relay
fallback and no `apps/server` routes in this pass. `localApi` still
`emit('mcpServers', …)` after each mutation so a future mobile surface can
subscribe. The desktop pane refetches after each mutation (the AccountsPane
pattern), so no `subscribe` hook is required.

## Engine wiring (`apps/desktop/electron/engine.ts`)

A pure helper module `mcp-config.ts` maps `CustomMcpServer[]` →
- **Claude**: an `mcpServers` record of SDK server configs
  (`{type:'stdio',command,args,env}` or `{type:'http',url,headers}`), env/headers
  resolved by name at build time, names sanitized; plus the `mcp__<name>__*`
  wildcard entries appended to `allowedTools`.
- **Codex**: an array of `-c mcp_servers.<name>={…}` TOML fragments for stdio
  servers (reusing the `tomlStr` quoting from `codex-bridge.ts`). HTTP MCP for
  Codex is emitted if a known-supported config shape exists, otherwise skipped
  with a logged note (best-effort, documented limitation).

Both paths are guarded so a malformed/unlaunchable server degrades to an
unavailable tool rather than failing the whole run (the Claude SDK already
tolerates a dead MCP server; we additionally try/catch config construction).

Only `enabled` servers are included. The custom servers merge **alongside** the
existing in-process `maestro` server, never replacing it.

### Skills awareness when a server is active

Before assembling the run, collect the union of `skillIds` across the enabled
servers that will be attached to this run. For each, ensure it is installed +
enabled into the project's `.claude/skills` (reuse `installSkillFiles` /
`recordSkillInstall` / `setInstalledSkillEnabled`; `addedBy:'agent'`-style record
tagged as MCP-sourced). Then extend the existing `<project_skills>` prompt block
with a short note grouping those skills under their server:

> These skills support the **<server>** MCP server — read the relevant SKILL.md
> before using that server's tools.

This gives the requested "aware of the skills when using that MCP" behavior using
the existing injection path, with no new prompt machinery.

## UI (`apps/desktop/src/screens/Settings.tsx` + a new pane file)

- Add `{ key: 'mcp', icon: 'plug'|'globe', label: 'MCP servers', tint: 'var(--teal)' }`
  to `SET_NAV`, and register the pane in the `panes` record.
- **`McpServersPane`**: a `GroupedList` of configured servers — glyph, name,
  transport badge, attached-skills count, an `enabled` `Switch`, and row click →
  edit. A header button **"＋ Connect a custom MCP"** opens the form. Empty state
  with a one-line explainer + the same button.
- **`McpServerForm`** (the screenshots): `PaneHead` "Connect to a custom MCP" with
  a Docs link; Name input; `Seg(['STDIO','Streamable HTTP'])`; conditional fields:
  - STDIO: Command to launch, Arguments (add/remove rows), Environment variables
    (KV add/remove), Environment variable passthrough (add/remove), Working directory.
  - HTTP: URL, Bearer token env var, Headers (KV add/remove), Headers from
    environment variables (KV add/remove).
  - **Skills** section (both modes): list of attached skills + "＋ Attach skill"
    that searches the registry (`api.searchSkills`) and adds ids to `skillIds`.
  - Save (create or update) + Back; delete available when editing.
- Reusable local subcomponents for the repeatable row groups (`KvEditor`,
  `ListEditor`, `SkillPicker`) built from inputs + an add button + a trash icon,
  styled inline like `AccountsPane`.
- `McpGateway.tsx` is **left untouched**: its Servers/activity/denials cards are a
  separate, still-prototype "audit gateway" concept built around fabricated fields
  (tool counts, signature verification, deferred-loading, fake project buckets) we
  don't have for real servers. Shoehorning real servers into those invented fields
  would add new half-truths, so the canonical, fully-real management surface is the
  Settings pane. Wiring McpGateway to real data (incl. a real audit log) is a
  follow-up.

## Testing

- Unit tests for `mcp-config.ts` (pure): stdio→SDK config, http→SDK config,
  env-by-name resolution, name sanitization, allowedTools generation, Codex TOML
  fragment generation, disabled servers excluded, malformed server skipped.
- Unit tests for the store CRUD + validation (add/update/remove/enable, empty-row
  pruning, transport field enforcement).
- Manual end-to-end verification: add a real stdio MCP server (e.g. a filesystem
  MCP), confirm it appears in the list, is passed to a Claude run, its tools are
  callable, and an attached skill is installed + referenced in the prompt.

## Files touched (as built)

- `apps/desktop/electron/store.ts` — `CustomMcpServer`/`McpKv` types + CRUD + migration + persistence.
- `apps/desktop/electron/mcp-config.ts` — **new** pure mapping helpers (self-contained `tomlStr`).
- `apps/desktop/electron/mcp-config.test.ts` — **new** unit tests (pure).
- `apps/desktop/electron/store.mcp.test.ts` — **new** store-CRUD tests.
- `apps/desktop/electron/localApi.ts` — dispatcher cases + `normalizeMcpInput` validator.
- `apps/desktop/electron/engine.ts` — merge custom servers into Claude `mcpServers`
  + Codex `-c` fragments + per-run skill activation + `<mcp_servers>` prompt note.
- `apps/desktop/src/lib/api.ts` — `CustomMcpServer`/`McpServerInput` types + desktop-only client methods.
- `apps/desktop/src/screens/Settings.tsx` — `SET_NAV` entry + pane registration + import.
- `apps/desktop/src/screens/McpServersPane.tsx` — **new** pane (list) + connect form + skill picker.

**Not touched (deliberate):** `McpGateway.tsx` (separate prototype, see UI note),
`apps/server/*` (MCP config is Mac-local / desktop-only).

## Verification

- `tsc --noEmit` (src + electron): clean.
- `vitest run`: 120/120 pass (incl. 17 new), no regressions.
- Adversarial code review pass applied: note↔config namespace drift, fix-pass
  parity, `cwd` emission (Claude), Codex TOML newline-escaping, stale-field clearing.
- `vite build`: renderer + electron main/preload bundle clean.
- Runtime end-to-end (add a real server, see it reach a live run) needs the
  packaged app + auth + a real MCP server, so it's left for manual smoke-testing.
```
