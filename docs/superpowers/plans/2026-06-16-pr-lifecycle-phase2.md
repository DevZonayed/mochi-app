# PR Lifecycle + Tight GitHub Coupling (Phase 2) — Design & Plan

> Builds on Phase 1 (worktree isolation, shipped). Extends the spec `docs/superpowers/specs/2026-06-16-session-worktree-pr-lifecycle-design.md` §6–9 with a now-**required**, tightly-coupled GitHub integration + onboarding auth gate.

**Goal:** Detect PR availability per session (branch has commits → PR can open), drive the open-PR lifecycle (mergeable → **Merge**, conflicts → **Resolve**, merged → **Archive**) exactly like Conductor, and make GitHub a first-class required dependency — connected during onboarding, used for both REST and authenticated git push.

## Grounded current state

- GitHub is a `ProviderId` already; `providers.connect('github', pat)` validates vs `api.github.com/user`, stores PAT encrypted (`safeStorage`); `providers.getLocalKey('github')` decrypts it. **But** connect captures no login/scopes, and the token is only used in `feedbackCreateIssue`.
- **No git push / credential code exists.** `cloneRepo` sets `GIT_TERMINAL_PROMPT=0`.
- Onboarding = `apps/desktop/src/screens/Onboarding.tsx` (5 steps), gated by `localStorage['maestro.onboarded']==='1'` read in `App.tsx:entryPath()`. Provider connect UI: `api.connectProvider/listProviders/disconnectProvider`. GitHub already appears in Settings → Accounts (`Settings.tsx REAL_PROVIDERS`).

## Locked decisions

1. **Auth method:** reuse the PAT infra. Onboarding gains a **required “Connect GitHub” step**. Two connect paths: (a) paste PAT (existing), (b) **one-click import from `gh auth token`** when the `gh` CLI is already logged in. OAuth device-flow is a future upgrade (needs a registered GitHub OAuth App) — seam left open, not built now.
2. **Capture identity + scopes on connect:** read `/user` body (`login`) and the `x-oauth-scopes` response header; verify the `repo` scope (classic PAT). Fine-grained PATs omit that header → treat scopes as “unknown, allow”, validate by capability instead (a probe call).
3. **Authenticated git push (tight coupling):** push over HTTPS using the PAT via a temporary `GIT_ASKPASS` script (token passed through env `GIT_TOKEN`, never in argv or repo config). SSH remotes use the user’s existing key. No token persisted to `.git/config`.
4. **Required remote:** repo projects need a GitHub `origin`. If missing/non-GitHub, surface a “Create on GitHub” action (`POST /user/repos` + `git remote add` + initial push) — gated. Non-GitHub remotes degrade gracefully (local states still work; PR features disabled with a clear reason).
5. **GitHub access:** PAT-REST primary (one client module), `gh` CLI used only for the import shortcut. Reaffirms spec §6.

## Aspects to remember (each mapped to where it’s handled)

1. **Scope check** — verify `repo` on connect; warn if missing (can’t PR private). → 2a
2. **Token expiry/revocation** — REST 401 later → mark GitHub disconnected, prompt reconnect. → 2a/2e
3. **Async mergeability** — `mergeable` is `null` right after push; poll until resolved; show “checking…”. → 2d
4. **Merge method** — read repo’s allowed methods (`allow_squash/merge/rebase_merge`); default squash if allowed else merge; user can override. → 2e
5. **Rate limits** — poll only sessions with a pushed branch, ~30s + on focus/demand; ETag conditional requests; backoff on 403 rate-limit. → 2d
6. **Conflict resolve** — `mergeable_state==='dirty'` → merge base into the session’s **worktree**, surface conflicted files, optionally dispatch the agent to resolve, commit, push. (Reuses Phase 1 worktree.) → 2g
7. **After merge** — prune worktree (archiveSession), optional delete remote branch, mark session merged. → 2e
8. **Approval gate** — `createSessionPR` + `mergeSessionPR` open `Approval{kind:'merge'}` → Telegram notify → execute on approve. → 2e
9. **Relay guard** — every new git/PR/github method desktop-only (denylist). → 2e
10. **Relay slimming** — `git-status` events strip token + absolute worktree paths. → 2d
11. **Idempotency** — createPR detects an existing open PR (no dup); push-when-pushed = fast; merge-when-merged handled. → 2d/2e
12. **Actionable errors** — no token / missing scope / 401 / 403 / no remote / non-GitHub / non-fast-forward push / PR exists / API merge conflict. → all
13. **Default branch** — ensure `origin/HEAD`; `resolveBaseBranch` already falls back. Set via `git remote set-head origin -a` when fetch reveals it. → 2c
14. **Non-fast-forward push** — diverged remote branch → detect, surface; force-with-lease is gated behind explicit confirm. → 2c
15. **PR body generation** — title/body from the session (title + latest summary). → 2e
16. **Fine-grained PAT** — no `x-oauth-scopes`; don’t hard-fail; capability-probe instead. → 2a
17. **Repo access** — token may lack access to the project’s org/repo → `getRepo` 404 → clear message. → 2a/2d
18. **GitHub Enterprise** — out of scope; keep API base overridable (default `api.github.com`). → 2a (seam)
19. **Onboarding gate** — `entryPath()` also requires GitHub connected; backend-verified, not just localStorage. → 2b
20. **Security** — token only in main process + Keychain; never argv/repo-config/relay/logs. → all

## Module map

| File | Responsibility | Change |
|---|---|---|
| `electron/github.ts` | **new** — PAT-REST client (injectable `fetch`), pure & unit-testable: `ghRequest`, `getViewer`(login+scopes), `getRepo`, `findOpenPr`, `getPullStatus`, `createPull`, `mergePull`, `createRepo`, `parseGitHubRemote`, error normalization + ETag cache | Create |
| `electron/git.ts` | push + PR-availability git: `aheadBehind`, `isDirty`, `remoteHasBranch`, `pushBranch`(askpass), `setRemoteHead`, `mergeBaseIntoBranch`, `buildAskpassScript` | Modify |
| `electron/pr-state.ts` | **new** — pure `deriveState(local, pr)` → `SessionGitState` (9 states); unit-tested table | Create |
| `electron/github-auth.ts` | **new** — `ghCliToken()` (import from `gh auth token`), `githubConnectionStatus(providers)` → {connected, login, scopes, hasRepoScope} | Create |
| `electron/git-service.ts` | **new** — `GitService`: `localState`, `prState`, `fullStatus` (merge+cache+emit `git-status`), polling, the action methods backing dispatch | Create |
| `electron/store.ts` | `SessionGitStatus`/`PrStatus` types + cache field; github identity (login/scopes) | Modify |
| `electron/localApi.ts` | dispatch: `githubStatus`, `importGithubFromCli`, `getSessionGitStatus`, `refreshSessionGitStatus`, `pushSession`, `createSessionPR`, `mergeSessionPR`, `resolveSession` (+ archiveSession exists) | Modify |
| `electron/main.ts` | instantiate `GitService`; thread into dispatch; poll loop; relay denylist + slim | Modify |
| `electron/providers.ts` | github validate captures login + scopes | Modify |
| `src/screens/Onboarding.tsx` | required “Connect GitHub” step + gh-import | Modify |
| `src/App.tsx` | `entryPath()` requires GitHub connected | Modify |
| `src/screens/SessionTranscript.tsx` (+ a `useGitStatus` hook) | PR status chip + Checks panel + action button | Modify |
| `src/lib/api.ts` | typed client methods for the new dispatch | Modify |

## State machine (spec §6, recap)

`deriveState(local,pr)`: `clean | uncommitted | ready-to-push | ready-for-pr | pr-mergeable | pr-conflicts | pr-blocked | pr-merged | pr-closed`. `mergeable_state==='clean'`→**Merge**, `'dirty'`→**Resolve**, `blocked/behind/unstable`→wait/update.

## Build order (each sub-phase: TDD where pure, build-verify glue, commit)

- **2a — GitHub REST client + auth status.** `github.ts` (mocked-fetch unit tests: getViewer parses login+scopes; error normalization; parseGitHubRemote ssh/https/enterprise), `github-auth.ts` (ghCliToken, connection status), providers github validate captures login+scopes, dispatch `githubStatus`/`importGithubFromCli`. **Foundation.**
- **2b — Onboarding gate.** Required GitHub step in `Onboarding.tsx` (+ gh-import button), `entryPath()` requires GitHub, backend-verified. Build-verify.
- **2c — Push auth + remote.** `git.ts`: `aheadBehind`, `isDirty`, `remoteHasBranch`, `buildAskpassScript` (pure, tested), `pushBranch` (tested vs a local bare remote), `parseGitHubRemote`, `ensureGitHubRemote`/createRepo seam.
- **2d — Detection + state machine + events.** `pr-state.ts deriveState` (full table test), `git-service.ts` localState+prState+fullStatus, ETag cache, `git-status` event + relay slim, dispatch `getSessionGitStatus`/`refreshSessionGitStatus`, polling loop in main.ts.
- **2e — Actions + approval gate.** dispatch `pushSession`/`createSessionPR`/`mergeSessionPR`, `Approval{kind:'merge'}` wiring + Telegram, merge-method detection, relay denylist, idempotency. Outward actions confirmed with the operator before first live run.
- **2f — UI.** `useGitStatus` hook + PR chip/Checks panel + action button, matching existing styling.
- **2g — Conflict resolve flow.** `mergeBaseIntoBranch` in the worktree, conflict surface, `resolveSession` dispatch (+ optional agent dispatch), push → recompute.

## Out of scope (YAGNI)

OAuth device flow (seam only), GitHub Enterprise, GitLab/Bitbucket, stacked PRs, in-app PR review comments, CI config generation.

## Verification

Pure modules (github.ts, pr-state.ts, git push/ahead-behind, askpass builder) → Vitest with mocked fetch / local bare remotes. Electron/renderer glue → typecheck + `vite build`. Live outward actions (push/PR/merge) → require the operator’s connected GitHub + a real repo + go-ahead; verified manually then.
