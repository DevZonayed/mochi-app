# Session Worktree Isolation + PR Lifecycle — Design Spec

**Date:** 2026-06-16
**Branch:** `DevZonayed/conductor-session-memory-management`
**Status:** Approved direction (Approach A — true worktrees). Forks resolved: PAT-REST + `gh` fallback; additive non-breaking migration.

## 1. Goal

Port Conductor's git architecture into the Maestro desktop app, "pixel perfect" with its behavior:

1. **True per-session isolation** — each chat session runs in its own `git worktree` directory (own working tree + HEAD + index), not a shared-folder branch checkout.
2. **PR-availability detection** — know whether a session branch has commits beyond its base (a PR *can* be opened), and whether one already exists.
3. **PR lifecycle** — when a PR is open, detect mergeable vs. conflicting and surface the matching action (**merge** vs **resolve**), plus archive on merge — the same action set Conductor exposes.

## 2. Current state (grounded)

| Area | Today | File |
|---|---|---|
| Session ↔ branch | `ChatSession.branch?` exists; branch-per-chat via `git checkout -b mochi/<slug>-<id4>` **in the shared `project.path`** | `store.ts:121`, `engine.ts:1118`, `git.ts:75` (`ensureBranch`) |
| Working dir | One per project: `workDirFor()` → `project.path` or `~/Maestro/<name>` | `engine.ts:252` |
| Git helpers | Functional, native `child_process`, pattern `execFileSync(git, ['-C', dir, ...])`. clone/branch/snapshot/repoInfo only. **No push/fetch/ahead-behind/PR/merge.** | `git.ts` |
| GitHub auth | PAT encrypted in Keychain via `safeStorage`; `providers.getLocalKey('github')`. REST `fetch` pattern already used for feedback→issues. `gh` CLI assumed for private clone. | `providers.ts`, `localApi.ts` (feedbackCreateIssue) |
| Approval gate | `ApprovalKind` includes `'merge'` — **defined but unhandled** | `store.ts:30,128` |
| Dispatch | `createDispatch(store, engine, media, research, publishing, telegram, providers, emit, relayUrl, browser?)` big `switch` | `localApi.ts:50` |
| Events | `emit(name, data, {live?, desktopOnly?})`; relay-slimmed; `approval` pending → Telegram | `main.ts:259` |
| Relay guard | Desktop-only methods throw 403 in `onCommand` denylist | `main.ts:356` |
| Renderer | `maestro.call(method)` + `maestro.onEvent` bridge; session UI in `SessionTranscript.tsx` | `preload.ts`, `src/screens/` |

**The divergence:** sessions swap branches in one working tree (can't run in parallel; checkout refuses on a dirty tree). Conductor gives each session its own worktree dir. Closing that gap is the core of this work.

## 3. Target architecture

```
project.path  (the repo the user opened/cloned)  ──►  acts as Conductor's "root checkout"
   └── .git/                     shared object store + refs (single source of truth)
   └── .git/worktrees/<id>/      per-session admin dir (HEAD + index), created by git

~/Maestro/worktrees/<projectId>/<sessionId>/   ◄── each session's WORKING TREE
   └── .git  (pointer file → project.path/.git/worktrees/<id>)
```

- **Worktrees only when** `project.path` exists **and** `isGitRepo(project.path)`. Non-repo / design / nameless projects keep today's in-place behavior (back-compat).
- **Base branch:** `resolveBaseBranch(repo)` = `origin/HEAD` default → else main checkout's current branch → else `main`/`master`. `git fetch origin` first (best-effort; offline is non-fatal).
- **Branch name:** unchanged scheme `mochi/<slug>-<id4>` (`branchSlug`).
- **1:1 branch↔worktree** is git-enforced (a branch checked out in one worktree can't be checked out in another) — the isolation invariant.

### 3.1 Worktree lifecycle

| Phase | Trigger | Action |
|---|---|---|
| **Create** | first run of a session in a repo project | `fetch origin` → `resolveBaseBranch` → `git -C <repo> worktree add <wtPath> -b <branch> <base>` → copy `copyGlobs` (default `['.env*']`) from repo root → run optional `project.setupScript` |
| **Resolve** | every run | `workDirFor` returns `session.worktreePath` when set |
| **Prune** | session archive/delete | `git -C <repo> worktree remove --force <wtPath>` → `git worktree prune` → optional `git branch -D <branch>` |

Setup is **configurable, not forced** (mirrors Conductor): no automatic dependency install. `copyGlobs` + `setupScript` are per-project, both optional.

## 4. Data-model changes (`store.ts`)

```ts
// Project — add (all optional, non-breaking):
defaultBaseBranch?: string;   // base to fork worktrees from; default auto-detected
setupScript?: string;         // run once per worktree after create
copyGlobs?: string[];         // gitignored files to copy into each worktree; default ['.env*']

// ChatSession — add:
worktreePath?: string;        // absolute path of this session's worktree (set on create)
baseBranch?: string;          // base this session forked from
archivedAt?: number;          // set when worktree pruned
// (existing `branch?` retained)

// New cached status (not persisted as source of truth; recomputed, cached on session):
export interface SessionGitStatus {
  sessionId: string;
  isRepo: boolean;
  branch: string | null;
  base: string | null;
  ahead: number;            // commits branch is ahead of base
  behind: number;           // commits behind base
  dirty: boolean;           // uncommitted changes in the worktree
  pushed: boolean;          // origin/<branch> exists and is up to date
  pr: PrStatus | null;
  state: SessionGitState;   // derived label (see §6)
  lastCheckedAt: number;
}
export interface PrStatus {
  number: number; url: string; title: string;
  state: 'open' | 'closed' | 'merged';
  mergeable: boolean | null;            // GitHub async-computed; null = unknown
  mergeableState: 'clean' | 'dirty' | 'blocked' | 'behind' | 'unstable' | 'draft' | 'unknown';
  checks: { name: string; status: 'pending' | 'success' | 'failure' }[];
}
export type SessionGitState =
  | 'clean' | 'uncommitted' | 'ready-to-push' | 'ready-for-pr'
  | 'pr-mergeable' | 'pr-conflicts' | 'pr-blocked' | 'pr-merged' | 'pr-closed';
```

`'merge'` approval gate (`ApprovalKind`) is now wired (see §7).

## 5. `git.ts` extensions (same native style)

New pure functions (best-effort, never throw; `{ ok, …, reason? }`):

```ts
resolveBaseBranch(repoDir): string                       // origin/HEAD → current → main
fetchOrigin(repoDir): { ok: boolean; reason?: string }   // best-effort
addWorktree(repoDir, wtPath, branch, base): { ok; reason? }
removeWorktree(repoDir, wtPath, opts?: {deleteBranch?: string}): { ok; reason? }
listWorktrees(repoDir): { path: string; branch: string|null; head: string }[]   // `worktree list --porcelain`
aheadBehind(dir, base): { ahead: number; behind: number }                       // `rev-list --left-right --count base...HEAD`
isDirty(dir): boolean                                                            // `status --porcelain`
remoteHasBranch(repoDir, branch): boolean                                        // `ls-remote --heads` / `rev-parse origin/<b>`
pushBranch(dir, branch): { ok; reason? }                                         // `push -u origin <branch>`
parseGitHubRemote(remote): { owner: string; repo: string } | null
mergeBaseConflicts(dir, base): boolean                                           // `merge-tree --write-tree` dry conflict probe
mergeBaseIntoBranch(dir, base): { ok; conflicts: string[]; reason? }             // for the resolve flow
copyGlobsInto(srcRepo, wtPath, globs): void                                      // copy gitignored files
```

`ensureBranch` is retained for the non-worktree fallback path.

## 6. PR-availability + lifecycle state machine (the heart)

Computed per session = `localState` (git) ⊕ `prState` (GitHub).

| `SessionGitState` | Detection | Surfaced action |
|---|---|---|
| `clean` | `ahead==0 && !dirty` | — |
| `uncommitted` | `dirty` | Commit / snapshot |
| `ready-to-push` | `ahead>0 && !pushed` | **Push** |
| `ready-for-pr` | `pushed && ahead>0 && pr==null` | **Create PR** ← *"branch has commits → PR available"* |
| `pr-mergeable` | `pr.state==='open' && mergeableState==='clean'` | **Merge** |
| `pr-conflicts` | `pr.state==='open' && mergeableState==='dirty'` | **Resolve conflicts** |
| `pr-blocked` | open + `blocked`/`behind`/`unstable` (checks) | Update branch / wait on checks |
| `pr-merged` | `pr.merged===true` | **Archive** (prune worktree) |
| `pr-closed` | closed, unmerged | Reopen / Archive |

`clean`→`dirty` (`isDirty`); ahead/behind via `aheadBehind`; `pushed` via `remoteHasBranch` + ahead-of-`origin/<branch>`==0. The `mergeableState` `clean`→Merge / `dirty`→Resolve split **is** Conductor's merge-vs-resolve behavior.

**Resolve flow:** in the session's worktree (it already holds the conflicting checkout): `fetchOrigin` → `mergeBaseIntoBranch(wt, base)` → on conflicts, expose conflicted files and offer to dispatch the agent (a chat turn with a resolve directive) → commit → `pushBranch` → PR recomputes to `pr-mergeable`.

## 7. Dispatch methods + relay guard + approval gate

New `createDispatch` param: `gitService: GitService` (threaded from `main.ts`).

New `switch` cases (all operate on a session/its worktree):

- `getSessionGitStatus { sessionId }` → `SessionGitStatus` (read; cheap local + cached PR)
- `refreshSessionGitStatus { sessionId }` → force PR re-fetch
- `pushSession { sessionId }` → `pushBranch` (no approval gate — a feature-branch push is reversible)
- `createSessionPR { sessionId, title?, body?, base? }` → **approval gate** → REST/`gh` create
- `mergeSessionPR { sessionId, method? }` → **approval gate** → REST/`gh` merge
- `resolveSession { sessionId, useAgent? }` → merge base, surface/resolve conflicts, push
- `archiveSession { sessionId, deleteBranch? }` → prune worktree, mark `archivedAt`

**Only `createSessionPR` and `mergeSessionPR` open an `Approval{kind:'merge'}`** (the outward/irreversible actions) → existing `emit('approval', …)` → Telegram notify (`main.ts:269`); each fires on approve via the existing approval-resolution path. `createSessionPR` pushes the branch first if needed. Read/worktree ops and standalone `pushSession` run without a gate. This matches the operator rule "confirm only outward-facing/irreversible actions."

**Relay denylist (`main.ts:356`):** add `getSessionGitStatus`, `refreshSessionGitStatus`, `pushSession`, `createSessionPR`, `mergeSessionPR`, `resolveSession`, `archiveSession` — they run git on the Mac and spend the operator's GitHub token, so they must throw 403 over the relay (same rule as `snapshotProject`/`feedbackCreateIssue`). The phone can still *see* status via the slimmed snapshot/events, just not invoke local-execution.

## 8. `GitService` (main process)

New `electron/gitService.ts`:

```ts
class GitService {
  constructor(store: Store, emit: EmitFn, providers: Providers) {}
  ensureWorktree(session, project): Promise<{ cwd: string }>   // create-or-resolve; called by engine
  localState(session): SessionGitStatus(partial)               // ahead/behind/dirty/pushed
  prState(session): Promise<PrStatus | null>                   // GitHub via PAT-REST / gh
  fullStatus(session): Promise<SessionGitStatus>               // merge + cache + emit('git-status')
  push/createPR/merge/resolve/archive(...)                     // back the dispatch methods
}
```

- **Engine hook:** `engine.ts:1108–1122` — replace the `ensureBranch` block with `gitService.ensureWorktree(session, project)` returning the cwd (only for repo projects; else fall back to `workDirFor`). `workDirFor` itself gains a worktree-aware first branch: `if (session?.worktreePath) return session.worktreePath`.
- **Polling:** sessions with a pushed branch poll `prState` ~30s + on window focus + on demand. `localState` recomputes after each agent turn and on `getSessionGitStatus`.
- **GitHub access (fork = accepted):** primary = `providers.getLocalKey('github')` PAT via `fetch` to `api.github.com` (`/repos/{o}/{r}/pulls`, `/pulls/{n}/merge`, commit `check-runs`); fallback = `gh` CLI (`gh pr view/create/merge --json …`) when no PAT but `gh auth` present. **Push** uses the operator's existing git credentials (credential helper/SSH), as Conductor does.

## 9. IPC events + renderer

- New event `git-status` via `emit`. Desktop windows get the full `SessionGitStatus`; **relay slimmed**: strip `worktreePath` and any absolute paths (add to the slim logic alongside asset/job/browser in `main.ts:273`).
- Renderer: `useGitStatus(sessionId)` hook subscribing to `maestro.onEvent` `git-status` + initial `getSessionGitStatus` call (mirror existing job-event pattern). No new preload channels needed (reuses `call` + `onEvent`).
- UI: a per-session **status chip + Checks-style panel** showing the `SessionGitState` label, ahead/behind, check rollup, and the single contextual action button (Push / Create PR / Merge / Resolve / Archive). Styling matches existing components in `src/screens/` — no new visual language invented.

## 10. Migration / back-compat (fork = additive, accepted)

- New sessions in repo projects get worktrees. Existing sessions (in-place `branch`, no `worktreePath`) keep working unchanged via the fallback path.
- Optional **"Move to isolated worktree"** action promotes an existing session: create the worktree from its current branch, set `worktreePath`.
- No data migration; all new fields optional.

## 11. Error handling & edge cases

- git not installed → all ops return `{ ok:false, reason }`; UI shows current behavior (no crash).
- Offline → `fetchOrigin`/`prState` best-effort; `localState` still works; status shows `lastCheckedAt` staleness.
- Dirty worktree on resolve → never auto-discard; surface to operator.
- Worktree dir already exists / orphaned → `listWorktrees` reconciles; `git worktree prune` clears stale admin dirs.
- No GitHub remote / non-GitHub remote → `parseGitHubRemote` null → PR features disabled, local states (`ready-to-push` etc.) still work.
- PAT missing scopes → REST 403 → fall back to `gh`; if both fail, surface an actionable message.
- Concurrency: worktrees make parallel session runs safe; the engine's per-`jobId` `running` map already supports it. No new global lock; per-session ops serialize on the session.

## 12. Testing strategy (TDD)

- **`git.ts` units** against a temp git repo fixture: `addWorktree`/`removeWorktree`/`listWorktrees`, `aheadBehind` (0/ahead/behind/diverged), `isDirty`, `resolveBaseBranch`, `parseGitHubRemote` (ssh/https/enterprise), `mergeBaseConflicts` true/false, `pushBranch` against a bare-repo "remote".
- **State machine**: pure `deriveState(localState, prState)` table-tested across all nine states.
- **GitService**: PR fetch/create/merge with a mocked `fetch` (and a `gh` fallback path); approval-gated actions assert an `Approval{kind:'merge'}` is opened and the action only fires on approve.
- **Engine hook**: a session in a repo project resolves to its worktree cwd; non-repo falls back.
- **Relay guard**: each new method throws 403 via `onCommand`.

## 13. Out of scope (YAGNI)

Multi-repo per project; GitLab/Bitbucket; in-app PR review comments; CI config generation; auto-merge policies. Push back if any are needed.

## 14. Open risks

- GitHub `mergeable` is async/null right after push → poll until resolved; show "checking…".
- Large repos → worktree working-tree disk cost (shared objects mitigate most of it) — Conductor's accepted tradeoff.
- `gh` availability varies → PAT-REST is primary precisely to not depend on it.

## 15. Implementation phasing

Two plans, shippable independently:

- **Phase 1 — Isolation:** data-model fields (§4), `git.ts` worktree functions (§5), `GitService.ensureWorktree` + engine hook (§8), prune on `archiveSession`, migration fallback (§10). Delivers true per-session worktrees with no PR features.
- **Phase 2 — PR lifecycle:** `prState` + state machine (§6), PR dispatch methods + approval gate + relay guard (§7), `git-status` events + `useGitStatus` + chip/panel UI (§9). Delivers detection + merge/resolve/archive actions.

`writing-plans` produces Phase 1 first; Phase 2 follows after Phase 1 lands and is verified.
