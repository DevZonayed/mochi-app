# Maestro — project state

> Single-operator OS for AI work. Desktop (Electron + React) = the brain (auth, data, execution via Claude Agent SDK + Codex). Mobile (Expo / RN) = thin remote. Server = pure relay. Monorepo: pnpm + Turborepo.

## Layout
- `apps/desktop/` — Electron + Vite + React + TS (the 20 desktop screens, scaffolding in progress)
- `apps/mobile/` — Expo + RN + TS (12 screens, foundation running)
- `apps/server/` — relay (deploy to Dokploy via push to `DevZonayed/mochi-app`)
- `packages/design-tokens/` — `tokens.css` (web) + `theme.ts` (RN), kept in sync
- `packages/core/` — Maestro Core (engine, jobs) per ADR
- `packages/rpc-contract/` — typed RPC contract Core ↔ clients
- `design/` — Claude Design HTML/JSX handoff (pixel-perfect reference)
- `docs/agentos/` — PRD + ADR

## Conventions
- Mac is the brain. Server stays a relay — never push domain logic back onto it.
- Engines run scoped to the project repo (`settingSources:['project']`) — do NOT pull from the operator's global `~/.claude`. Prevents `.continuum`/skill pollution.
- Native browser = playwright-core `launchPersistentContext` over system Chrome. Codex via stdio-MCP (`-c mcp_servers`, needs `danger-full-access` + `approval_policy=never`). Per-project sessions.
- Image gen: Codex-first re-roll + instruction-edit; fal FLUX.1 Kontext fallback. Both routed through `engine.setImageGen` closure.
- Auto-update: electron-updater + GitHub Releases. CI uses `--ignore-scripts` (server's better-sqlite3 breaks runners). Version via `set-version.mjs`, never `-c.extraMetadata` (Windows breaks).
- Deploy = git push to `DevZonayed/mochi-app` → Dokploy. **Operator-gated**; do not push without the word.
- `master` lives in a separate worktree (`.git/worktrees/dhaka`).

## Installed skills (.claude/skills/)
Curated set; each addresses a real surface in this repo.

| Skill | Why it's here |
|---|---|
| `react-native-best-practices` (software-mansion-labs) | gold-standard RN/Expo guidance — the mobile app |
| `react-best-practices` (0xbigboss) | shared React patterns across desktop + mobile |
| `typescript-best-practices` (0xbigboss) | TS hygiene across the whole monorepo |
| `node` (mcollina) | Matteo Collina's Node best practices — Core + server |
| `turborepo` (vercel) | the actual Turborepo skill for this monorepo |
| `pnpm` (antfu) | workspaces, catalogs, overrides — pnpm here |
| `vite` (antfu) | desktop renderer build (`vite.web.config.ts`) |
| `vitest` (antfu) | unit tests for Core + packages |
| `mcp-developer` (jeffallan) | building MCP servers (registry MCP, browser-mcp, skill broker) |
| `playwright-expert` (jeffallan) | native browser layer + e2e |
| `accessibility` (addyosmani) | WCAG 2.2 for desktop web surfaces + mobile a11y |
| `telegram-bot` (claude-office) | `apps/desktop/electron/telegram.ts` comms gateway |
| `fal-ai-media` (affaan-m) | fal FLUX image gen + media studio fallback path |
| `websocket-engineer` (jeffallan) | relay realtime (phone ↔ Mac), job stream |
| `security-scan` (affaan-m) | audits the growing `.claude/` (settings, hooks, MCP, agents) |

## Deliberately NOT installed
- iOS HIG / SwiftUI skills — design is already shipped in `design/`; we're porting, not redesigning.
- Generic "design-tokens" skill — would conflict with the already-defined glass & ink token system in `packages/design-tokens/`.
- Pure-Electron skills — registry only returned decompilers (`baoyu-electron-extract`), not builders. None fit.
- Database skills (sqlite/postgres) — current persistence is local better-sqlite3, no schema design needed yet. Re-evaluate if Core grows a real schema.

## Open threads
- Desktop shell + launcher scaffolding (per `PORTING.md`) — next porting target.
- Server features like `/registry/*` need a deploy to serve phone/web; bundled Mac fallback exists.
- Conversation sync (Claude/Codex/Conductor history import) is in via rail refresh; Conductor reads sqlite read-only.
- Skill registry MCP self-install + operator UI both proven; `skills.sh` scrape token-free.
- **Safe Storage Keychain prompt** keeps firing on launch because the build is ad‑hoc signed (`build/after-pack.cjs` + `electron-builder.yml: identity: null`) — every rebuild / auto‑update gets a new signature, so the keychain ACL never matches. Permanent fix = Developer ID Application cert + notarize + drop the ad‑hoc step. Per‑Mac stopgap = patch the keychain item's partition list to include `unsigned:`: `/usr/bin/security set-generic-password-partition-list -S "apple-tool:,apple:,unsigned:" -s "@maestro/desktop Safe Storage" -a "@maestro/desktop" ~/Library/Keychains/login.keychain-db`. Note: the account is `@maestro/desktop` (not `@maestro/desktop Key` — that was a stale entry from an earlier Electron version).

## Active work — branch `integration/all-fixes` (chat path → in-app file tab)
Off `origin/master`, in this worktree.
**Uncommitted; awaiting operator review.** Typecheck clean across desktop/server/mobile.

**Feature** (user-reported "in this kind of response it gives the paths when I
click to the path such as docs in that time it should open the docs or file
to this application tab so that I can edit it or preview it or copy the
markdown file."):
chat transcripts already linkify paths like `docs/frontend/SESSION_0.md` via
`PathLink` (ProjectDetail.tsx ~1043). Clicking only ever revealed in Finder —
it never opened the file in Mochi's own tab system, so the operator couldn't
preview, edit, or copy the markdown without context-switching out of the app.
Workspace already had a tab-based `FileViewer` and a parallel `ImageOpenContext`
plumbing for images, but no equivalent for files.

**Change (5 files, +1 new, ~260 LOC):**
- NEW `apps/desktop/src/lib/openPath.tsx` — `OpenPathContext` (function
  `(path) => void`) + `pathIsInside(abs, root)` helper. When no provider is
  set (ProjectDetail standalone), PathLink keeps the old reveal-in-Finder
  behavior; when set (Workspace tabs), the click is dispatched to the host.
- `apps/desktop/src/screens/ProjectDetail.tsx` — `PathLink` consumes
  `OpenPathContext`; ⌘/Ctrl-click still reveals in Finder (VS Code reflex).
  `ChatThread` gains an `onOpenFile?: (path: string) => void` prop and wraps
  its turns in `OpenPathContext.Provider` with a stable smart wrapper:
  relative paths and paths inside `project.path` go to `onOpenFile`;
  anything else (paths outside the project, where `api.readFile`'s
  path-confine would reject anyway) falls back to reveal. The provider
  value is `useMemo([])` + refs so it never changes identity per stream
  frame, matching the existing `openImageStable` pattern.
- `apps/desktop/src/screens/Workspace.tsx` — passes
  `onOpenFile={(p) => openFile(t.projectId, p)}` to `ChatThread`, reusing
  the existing `openFile(projectId, filePath)` that already dedupes by
  path and creates a `kind: 'file'` tab rendered by `FileViewer`.
- `apps/desktop/electron/main.ts` + `electron/preload.ts` +
  `apps/desktop/src/lib/api.ts` — new `maestro:writeFile` IPC.
  Path-confined to the project root via the same `resolveInsideRoot()`
  used by `readFile`; rejects writes >4 MB, NUL-byte payloads (binary
  guard), and non-file targets; only OVERWRITES existing regular files
  (no creation, no path-escape). NEVER added to the relay dispatch, so
  phone/web remotes can't mutate local files.
- `apps/desktop/src/lib/CodeView.tsx` — `FileViewer` rewritten to support
  three view modes: **Preview** (rendered markdown, default for .md/.mdx/.markdown),
  **Source** (existing highlight.js view, default for everything else),
  **Edit** (textarea + Save). Adds a Copy-source button (toast on
  success/blocked), an in-tab Save button (⌘S inside the textarea fires
  too) with dirty indicator, and a Retry on read errors. New `Markdown`
  component renders a sensible GFM subset (headings, lists, paragraphs,
  fenced code w/ highlight, inline `code`, **bold**, *italic*, [links],
  pipe tables, blockquotes, hr) — independent of ProjectDetail's
  `renderChatBody` so it can ship without a cross-file refactor.

**Behavior post-fix:**
- Chat output cites `docs/frontend/SESSION_0.md` → operator clicks → it opens
  as a new Workspace tab. Markdown renders by default; "Source" toggles to
  the syntax-highlighted source; "Edit" swaps in a textarea + Save; "Copy"
  grabs the markdown source to the clipboard.
- ⌘-click on the same link still reveals in Finder (escape hatch).
- Clicking a path that's outside the active project falls back to reveal
  (FileViewer is path-confined; we don't want a tab that just shows an
  error).
- ProjectDetail's standalone ChatPane is unchanged — there's no Workspace
  host providing `onOpenFile`, so it keeps the original reveal behavior.

**Security:**
- `writeFile` re-uses `resolveInsideRoot` (realpath + ../ block) so
  symlinks/relative escapes can't write outside the project root.
- IPC handler only — NOT exposed in the relay dispatch (intentionally
  mirrors the read-side `readFile` decision documented in main.ts).

**Not done (operator-gated):**
- Live smoke test on the running desktop app (open a project in Workspace,
  send a chat that mentions a markdown path, click it, verify Preview/
  Source/Edit/Save/Copy).
- Commit / merge / deploy — per repo policy.

## Active work — branch `fix/persist-chat-queue`
Off `origin/master`, in this worktree.
**Uncommitted; awaiting operator review.**

**Bug** (user-reported "the queue is not showing when we defocus from chat and
get here again"):
in `ProjectDetail.tsx` line ~2120 the chat queue was a plain `React.useState`.
React-Router unmounts ProjectDetail on every navigation (Settings, Costs,
Workspace, etc.) → state is destroyed → returning to the chat shows an empty
queue. Worse: the drainer effect that fires `queue[0]` when the agent goes
idle (line ~2322-2329) is unmounted with the component, so any items the
operator had queued were **silently dropped** — they were never sent.

**Fix** (`apps/desktop/src/screens/ProjectDetail.tsx` only, +50/-3):
- New top-level hook `usePersistedQueue(activeId)` with the same `[string[],
  setter]` signature as the old `useState<string[]>([])`.
- Persists to `localStorage` keyed `maestro.queue.<sessionId>`:
  - Lazy init reads the session's queue on first mount (covers app-launch + a
    session that already had items).
  - Re-hydrates on `activeId` change (rail click → different session).
  - Writes on every setQueue (or `removeItem` when empty, so stale state
    doesn't pile up across short-lived sessions).
- Dropped the now-unnecessary `setQueue([])` line in the session-change effect
  (the hook handles per-session hydration).
- Drainer effect is unchanged; on remount, once the queue is restored, it
  fires automatically — so queued prompts that were sitting at the moment of
  navigation now actually run when the user comes back.

**Behavior post-fix:**
- Operator queues 3 messages → navigates to Settings → comes back → all 3
  visible in the QueuePanel.
- Operator queues 3 messages → switches chats → original chat's 3 messages
  preserved; other chat shows ITS own queue (or empty).
- Operator queues messages and the agent finishes while they're elsewhere →
  on return, the drainer (now re-mounted) sees the queued items + agent idle
  → fires next message immediately.
- localStorage quota / disabled → silently degrades to in-memory queue
  (try/catch around every write).

**Not done (operator-gated):**
- Typecheck — sandbox has no node. Run `pnpm --filter @maestro/desktop typecheck`.
- Commit / merge — per repo policy.

**Stash inventory** (5 prior fixes preserved, FIFO from `stash@{0}`):
- `stash@{0}` — `fix/drop-global-skills-from-settings`
- `stash@{1}` — `feat/cli-login-from-settings`
- `stash@{2}` — `fix/cost-page-settings-nav` (⚠️ still requires the
  `settingsShell.tsx` skills-removal edit on merge — see prior note)
- `stash@{3}` — `fix/codex-auth-state-mismatch`
- `stash@{4}` — `fix/conversation-sync-path-normalization`

## Earlier — branch `fix/drop-global-skills-from-settings`
Off `origin/master`, in this worktree.
**Uncommitted; awaiting operator review.**

**User request:** "We do not need global skills and tools — remove that from Settings."

**Fix (Settings.tsx only, +4/−3):**
- Removed `{ key: 'skills', icon: 'spark', label: 'Skills & tools', tint: 'var(--indigo)' }`
  from `SET_NAV`.
- Dropped the now-dead `n.key === 'skills' ? navigate('/skills-registry') :`
  ternary branch from the sub-nav button's onClick.
- Refreshed the comment that called out "Skills + Costs are launchers" → "Costs is a launcher".

**Scope decisions:**
- Left the **left main sidebar** "Skills" entry intact (it's defined in `routes.ts`
  and is a separate surface; the user said only "remove from Settings").
- Left the **/skills-registry route + screen** intact (per-project skill
  management remains the model — skills aren't globally configured but they
  exist per-project).

**⚠️ Cross-stash caveat (operator must handle on merge):**
`stash@{1}` (`fix/cost-page-settings-nav`) introduces `apps/desktop/src/lib/settingsShell.tsx`
which has its own `SETTINGS_SUB_NAV` array — AND that array still contains the
skills entry. So when the operator pops or merges `fix/cost-page-settings-nav`,
they MUST also delete this from `settingsShell.tsx`:
```ts
{ key: 'skills', icon: 'spark', label: 'Skills & tools', tint: 'var(--indigo)' },
```
and drop the `if (key === 'skills') return navigate('/skills-registry');` branch
in `SettingsSubNav`'s click handler. Otherwise the cost-page-nav fix will
reintroduce the "Skills & tools" launcher via the shared component.
(Did not touch the stash here because editing stash contents is fragile;
clearer to make the dependency explicit.)

**Not done (operator-gated):**
- Typecheck — sandbox has no node. Run `pnpm --filter @maestro/desktop typecheck`.
- Commit / merge — per repo policy.

**Stash inventory** (4 prior fixes, FIFO from `stash@{0}`):
- `stash@{0}` — `feat/cli-login-from-settings` (Sign in with Claude Code / ChatGPT buttons)
- `stash@{1}` — `fix/cost-page-settings-nav` (introduces `settingsShell.tsx`; see caveat above)
- `stash@{2}` — `fix/codex-auth-state-mismatch` (OpenAI API-key fallback for Codex)
- `stash@{3}` — `fix/conversation-sync-path-normalization` (realpath/slash variants in scanner)

## Earlier — branch `feat/cli-login-from-settings`
Off `origin/master`, in this worktree (`/Users/jonayedahamed/Desktop/Projects/Personal/Mochi`).
**Uncommitted; awaiting operator review.**

**Feature** (user-requested: "initiate Claude/Codex auth from Settings page").
Previously Settings → Accounts only offered an API key field. The operator had
to drop to a terminal to run `claude login` / `codex login` for the
subscription path. Now both flows can be kicked off in-app.

**Design choice — real OS Terminal, not in-app emulator:**
Both CLIs are interactive (Codex prints a device code; Claude opens a browser).
Embedding a TTY (node-pty + xterm.js) is heavy + adds a native module. Instead,
spawn `Terminal.app` (macOS) / `x-terminal-emulator` / `cmd.exe` running the
real login command — the operator completes it in a TTY they trust — and Maestro
watches the auth file on disk. As soon as `~/.claude/.credentials.json`,
`~/.claude.json`, or `~/.codex/auth.json` appears non-empty, we emit a `providers`
event and the row flips from "Waiting…" to "Connected" with zero refresh.

**Fix (4 files, +1 new):**
- NEW `apps/desktop/electron/cli-auth.ts` — `openLoginTerminal(provider)` (macOS
  AppleScript / Linux x-terminal-emulator / Windows cmd) + `watchAuth(provider,
  onComplete)` (fs.watch on the auth dir + 2s polling belt-and-braces + 15-min
  hard timeout). Resolves the CLI binary via the engine's existing `resolveClaude`
  / `resolveCodex` so PATH discovery is consistent with engine runs.
- `apps/desktop/electron/localApi.ts` — new dispatch cases `startCliLogin` +
  `cancelCliLogin`. At-most-one watcher per provider (Map keyed by 'claude' /
  'codex'); clicking Sign In again is idempotent. On completion, emits
  `providers` event with the fresh list.
- `apps/desktop/src/lib/api.ts` — `startCliLogin(provider)` + `cancelCliLogin
  (provider)` client methods (501 fallback for web build). `subscribe` gains
  `onProviders?` for the live update channel.
- `apps/desktop/src/screens/Settings.tsx` AccountsPane — new "Sign in with Claude
  Code" / "Sign in with ChatGPT" primary buttons alongside the API key field.
  Waiting state with spinner + Reopen + Cancel buttons. Subscribes to
  `onProviders` events; also refetches on window focus to catch any missed
  event. The API key path is still available — relabeled "Use key" so the
  hierarchy reads CLI-first, key-second.

**Edge cases handled:**
- CLI binary missing → 503 error surfaced as the row's status line ("Codex CLI
  not found — install it first.").
- User closes Terminal without finishing → watcher times out at 15 min;
  meanwhile a re-click reuses the same provider slot (no leaked watchers).
- User clicks Sign In, then Cancel → watcher torn down immediately; UI clears
  waiting state without waiting for the cancel RPC round-trip.
- Provider connects via API key while CLI watcher is armed → ignored: only
  `method: 'subscription'` clears the waiting flag.
- Already signed in before clicking → `fire()` runs once on watchAuth() entry
  (immediate completion).

**Not done (operator-gated):**
- Typecheck — sandbox has no node. Run `pnpm --filter @maestro/desktop typecheck`.
- Smoke-test on the actual Mac: click Sign In with Claude Code → confirm
  Terminal opens → run `claude login` → confirm UI flips automatically.
- Commit / merge — per repo policy.

**Stashed**: 3 prior fixes preserved as `stash@{0}` (cost-page-nav), `stash@{1}`
(codex-auth), `stash@{2}` (conversation-sync). Recover with
`git checkout <branch> && git stash pop` on the matching branch.

## Earlier — branch `fix/cost-page-settings-nav`
Off `origin/master`, in this worktree (`/Users/jonayedahamed/Desktop/Projects/Personal/Mochi`).
**Uncommitted; awaiting operator review.**

**Bug** (user-reported "Cost page do not showing the settings navigation"):
the Settings page has its OWN secondary sub-nav (General · Engines · Skills ·
Costs · Accounts · Security · …). Two of those entries — **Skills** and **Costs** —
are "launcher" keys: clicking them navigates to `/skills-registry` or `/budget`
respectively. But `BudgetDashboard` wrapped content in `<AppShell>` (the default
chrome), so the Settings sub-nav VANISHED the moment you arrived. The operator
clicked Costs from Settings → got stranded with no way to hop back to Engines /
Accounts / etc. without re-clicking Settings.

**Fix** (3 files, +1 new):
- NEW `apps/desktop/src/lib/settingsShell.tsx` — exports `SETTINGS_SUB_NAV` (the
  shared array of items) + `SettingsSubNav` component. Click handler: launcher
  keys (skills/costs) navigate to their screens; other keys either call
  `onPaneChange` (when inside Settings) or deep-link to `/settings?sec=<key>`
  (when on a launcher screen). HashRouter-safe — uses query string, not sub-hash.
- `apps/desktop/src/screens/Settings.tsx` — drops the open-coded `SET_NAV` +
  `<aside>` block, renders `<SettingsSubNav activeKey={sec} onPaneChange={setSec}/>`.
  Reads `?sec=<key>` from `useLocation().search` on mount + on every URL change,
  so deep-links from the launcher screens land on the right pane.
- `apps/desktop/src/screens/BudgetDashboard.tsx` — replaces `<AppShell>` wrapper
  with the same Sidebar+Toolbar+SettingsSubNav chrome Settings uses. `activeKey="costs"`
  in the sub-nav; `active="budget"` in the main sidebar (so both highlights agree).

**Behavioral guarantees:**
- Click "Costs" in Settings → BudgetDashboard renders WITH the Settings sub-nav
  on the left, "Costs" highlighted.
- From Cost page click "Engines" → navigates to `/settings?sec=engines`, Settings
  opens directly on Engines.
- Direct entry via the BudgetChip pill (any page → /budget) → same chrome.
- HashRouter compatible: `/settings?sec=engines` becomes `#/settings?sec=engines`
  in the URL bar; `useLocation().search` returns the right value.
- Skills launcher gets the same treatment for free if/when we apply the same
  shell to `SkillsRegistry.tsx` (out of scope for this fix; see follow-ups).

**Not done (operator-gated):**
- Typecheck — sandbox has no node. Run `pnpm --filter @maestro/desktop typecheck`.
- Apply the same `SettingsSubNav` chrome to `SkillsRegistry.tsx` for parity.
- Commit / merge — per repo policy.

**Stashed**: previous fixes preserved as `stash@{0}` (codex-auth) and `stash@{1}`
(conversation-sync). Recover with `git checkout <branch> && git stash pop` on the
matching branch.

## Earlier — branch `fix/codex-auth-state-mismatch`
Off `origin/master`, in this worktree (`/Users/jonayedahamed/Desktop/Projects/Personal/Mochi`).
**Uncommitted; awaiting operator review.**

**Bug** (user-reported "Settings says Codex signed in, ModelPicker says not signed in"):
asymmetry between `providers.list()` and `engine.status('codex')` in `engine.ts`.
Claude's status path accepts CLI login OR Anthropic API key in keychain (lines 931-935).
Codex's status path required `codex login` (auth.json) AND the CLI binary — **no API
key fallback**. A user who added an OpenAI key in Settings → Accounts but never ran
`codex login` saw:
- Settings → Accounts → "OpenAI: Connected · API key ••••XXXX" (providers.list)
- Settings → Engine status → "Codex: Not signed in"      (engine.statuses)
- ModelPicker → Codex group dimmed "· not signed in"     (buildModelGroups via engine.statuses)

**Fix (engine.ts only, +34/-10):**
- `engine.status('codex')` now mirrors Claude: require CLI binary → accept login OR
  keychain OpenAI key (returns `method: 'apiKey'`, `detail: 'OpenAI API key'`).
- `runCodex` ctx gains optional `apiKey?: string`. When set, the spawn merges
  `OPENAI_API_KEY` into the child env (`{ ...process.env, OPENAI_API_KEY }`).
  Codex CLI consults this var when not signed in via `codex login`.
- Symmetric `openaiKey` (only set when `status('codex').method === 'apiKey'`) threaded
  through ALL FOUR `runCodex` call sites: image-gen (935), primary run (1260 via
  imageCtx), reviewer pass (1330), fix-after-review (1349 via imageCtx).
- Backwards compatible: `apiKey?:` is optional; when undefined, spawn env stays
  undefined and the child inherits parent env unchanged — old behavior preserved.

**Edge case still red (intentional):** user has `codex login` but the `codex` binary
is missing from PATH. Settings → Accounts shows "Connected · Codex (ChatGPT) login"
(correctly — the login exists), Engine status shows "CLI not found" (correctly — the
runtime is missing). This is two different questions answered honestly, not a bug.
The Engine status reason text already explains the install command.

**Not done (operator-gated):**
- Typecheck — sandbox has no node. Run `pnpm --filter @maestro/desktop typecheck`.
- Commit / merge — per repo policy.

**Stashed**: previous `fix/conversation-sync-path-normalization` work is `stash@{0}`.
To recover: `git checkout fix/conversation-sync-path-normalization && git stash pop`.

## Earlier — branch `fix/conversation-sync-path-normalization`
Off `origin/master`, in this worktree (`/Users/jonayedahamed/Desktop/Projects/Personal/Mochi`).
**Uncommitted; awaiting operator review.**

**Bug** (user-reported "search seems not working / UI visible but not actually [returning hits]"):
the conversation-sync scanner did exact-string match against the project's `cwd`
for all three sources (Claude encoded dir, Codex `payload.cwd`, Conductor
`workspace_path`). Maestro stores `proj.path` as-is from the folder picker —
no realpath, no trailing-slash normalization. So a project pointing at a symlink
(e.g. user opened `~/Projects/Mochi` which is a link to `/Volumes/X/...`) would
silently return zero, identical to "no chats." Made worse by all errors being
swallowed: a missing `/usr/bin/sqlite3` looked the same as "no Conductor chats."

**Fix (4 files, ~159 +/-24 lines):**
- `apps/desktop/electron/conversation-sync.ts` — adds `pathVariants()` (literal +
  `realpathSync` + with/without trailing slash) and `canonKey()`. Each per-source
  scanner now takes the full variant set and matches by canonical key on both
  sides. Per-source errors captured in `errors: Record<ConvSource, string|null>`;
  `ScanResult` also returns `scannedPath` + `candidatePaths` for the UI.
- `apps/desktop/electron/localApi.ts` — `scanConversations` dispatch threads the
  new fields back to the client.
- `apps/desktop/src/lib/api.ts` — `ConversationScan` gains `scannedPath?`,
  `candidatePaths?`, `errors?` (all optional → backwards compat with the relay).
- `apps/desktop/src/screens/ProjectDetail.tsx` SyncModal empty state now: (a)
  shows red `alert` chip with tooltip for any source that errored, (b) shows the
  actual `scannedPath` and variant count so a path-mismatch is one glance away.

**Not done (operator-gated):**
- Typecheck — no node/pnpm in the sandbox. Run `pnpm --filter @maestro/desktop
  typecheck` to verify.
- Commit — per repo policy "never commit without explicit ask."
- Merging into the worktree that builds the desktop app (likely `lome` on
  `DevZonayed/electron-app-updates`, or wherever the current release ships from).
  This branch is off `origin/master` so it merges cleanly into either.

## Skill workflow (reminder for future turns)
1. `search_skills` BEFORE substantive work.
2. `add_skill_to_project` for the best match (default is install, not skip).
3. Read `.claude/skills/<slug>/SKILL.md` and follow it.
4. Skip only when every result is clearly unrelated; if you skip, name the top result + why it didn't fit.
