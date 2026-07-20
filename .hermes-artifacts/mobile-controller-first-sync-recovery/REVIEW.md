# Mobile Controller First Sync Recovery

Date: Monday, July 20, 2026
Branch: `mochi/newport/native-controller-production-rel`
Base / head referenced by request: `d723fccb84ba51be6d996726324447a9ced02e49` / `33273474c6f16cf4aa92b1ed7037a08488998bde`

Verdict: `READY FOR FINAL RE-REVIEW`

## Scope

Android secure-controller recovery defects proven by live ADB acceptance on Vivo V2240, implemented in the WebKit-era app tree without touching Electron or deprecated pure Swift surfaces.

## Root causes

1. `controllerMode.restoreControllerMode()` still collapsed "authenticated but account identity unproven" into `restored=true` and `active=false`. `chooseRootTree()` then treated that as proven inactive and mounted the legacy direct-mutation tree, even though the app had not re-proved which account owned the token.
2. `shadowEnrollmentRuntimeFactory.resolveAccountId()` also used an unbounded `get-session` fetch. Cold-start controller bootstrap could stall permanently before the mobile runtime truthfully surfaced offline state.
3. Concurrent `restoreControllerMode()` calls were unfenced. A late restore for token/session A could resolve after token/session B and still overwrite in-memory mode state or persisted token/account binding.
4. `ShadowControllerService` needed deterministic behavioral proof that overlapping `connect()` and scheduled `tick()` calls share one serialized load/drain/apply path, avoid duplicate application, preserve the highest stable head, and emit truthful notification edges.
5. There was no explicit neutral retry UI for the authenticated-but-unproven account-resolution failure. A user could fall through to legacy or lose the safe retry affordance.

## Fix

### Explicit account-resolution error gate

- Added a 15s abort ceiling to mobile `get-session` lookups in:
  - `apps/mobile/src/controllerMode.ts`
  - `apps/mobile/src/shadowEnrollmentRuntimeFactory.ts`
- Reworked controller-mode restore from a plain `restored/active` boolean pair into an explicit snapshot model:
  - `pending`
  - `signed-out`
  - `inactive` with proven account resolution
  - `active`
  - `resolution-error`
- Authenticated `get-session` timeout/failure now lands in `resolution-error`, never `active` for account A and never `legacy`.
- `apps/mobile/src/navigation.tsx` now renders a neutral secure retry gate for `resolution-error`, with visible network error copy and a Retry button that re-runs the real restore path.
- The gate keeps the user out of both the legacy direct-mutation tree and the controller content tree until account ownership is freshly re-proved.

### Fenced restore concurrency

- Added a restore generation fence in `apps/mobile/src/controllerMode.ts`.
- Each restore captures token + generation before awaiting network/digest work.
- Any late completion after `invalidateControllerMode()`, token switch, sign-out, or a newer restore now no-ops before mutating:
  - in-memory snapshot
  - `activeAccountId`
  - persisted last-account metadata
  - persisted token/account binding
- `invalidateControllerMode()` now bumps the restore generation, so the existing session/host subscriptions in `App.tsx` automatically fence stale completions.

### Truthful first-sync drain and online gating

- Reworked `apps/mobile/src/shadowControllerService.ts` so controller sync work is deduplicated through one in-flight sync seam.
- `connect()` and timer `tick()` now share the same sync path:
  - fetch host-signed transitions
  - reconcile authority
  - drain `/api/shadow/connect` across multiple pages up to a bounded stable head
  - poll ACKs
  - only set `online` once the full bounded baseline is durably caught up
- Added projection notifications after applied event pages and at sync completion.
- If the mobile cannot reach the stable head within the bounded page budget, it stays offline and records `baseline-drain-incomplete`.

### Explicit offline startup / recovery UI

- Added first-sync recovery gating in `apps/mobile/src/screens/controller/ShadowShell.tsx`.
- When the controller is offline, has never applied a baseline, and the projection is empty, the shell now shows explicit secure-sync recovery UI instead of empty product state.
- The recovery copy gives the cryptographically safe path for the force-stop-before-approval defect:
  - retry secure sync if the Mac is still open
  - otherwise revoke the device on the Mac and re-enroll
  - never trust a server-only grant without local signed proof

### Deterministic behavioral coverage

- `apps/mobile/src/controllerMode.test.ts` now proves:
  - authenticated timeout enters `resolution-error`;
  - malformed binding storage is ignored safely;
  - a late restore for token/account A cannot overwrite a newer token/account B restore.
- `apps/mobile/src/controllerRoot.test.ts` now proves the root decision treats the indeterminate authenticated state as neutral, not legacy.
- `apps/mobile/src/shadowControllerService.test.ts` now proves:
  - overlapping `connect()` and scheduled `tick()` join one load/drain/apply seam;
  - multi-page drain reaches stable head once, with no duplicate application;
  - notification edges surface partial offline progress and final online truth;
  - incomplete bounded drain never regresses `lastSeq` to zero and stays offline.

## Files changed

- `apps/mobile/src/controllerMode.ts`
- `apps/mobile/src/controllerMode.test.ts`
- `apps/mobile/src/controllerRoot.ts`
- `apps/mobile/src/controllerRoot.test.ts`
- `apps/mobile/src/navigation.tsx`
- `apps/mobile/src/shadowEnrollmentRuntimeFactory.ts`
- `apps/mobile/src/shadowControllerService.ts`
- `apps/mobile/src/shadowControllerService.test.ts`
- `apps/mobile/src/screens/controller/ShadowShell.tsx`

## Verification

Focused:

- `pnpm --filter @maestro/mobile test -- --run src/controllerMode.test.ts src/controllerRoot.test.ts src/shadowControllerService.test.ts`
- `pnpm --filter @maestro/mobile typecheck`

Full:

- `pnpm --filter @maestro/mobile test`
  - 33 files, 378 tests passed
- `pnpm --filter @maestro/realtime typecheck`
- `pnpm --filter @maestro/realtime test`
  - 25 files, 789 tests passed
- `pnpm --filter @maestro/macos typecheck`
- `pnpm --filter @maestro/macos build`
- `pnpm --filter @maestro/macos test:all`
  - 2264 Mac Vitest tests passed
  - 335 renderer tests passed
  - 50 DOM tests passed
  - Mac build passed
- `swift build` in `MacOS/webview-app`
- `pnpm --filter @maestro/server typecheck`
- `pnpm --filter @maestro/server build`
- `pnpm --filter @maestro/server test`
  - 89 tests passed, 83 package-gated skips
- `git diff --check`
- bounded changed-file secret scan on the touched mobile files

## Final-review blocker disposition

1. Blocker 1 fixed: authenticated-but-unproven restore now renders a neutral secure retry gate with visible error and Retry, never controller account A and never the legacy tree.
2. Blocker 2 fixed: concurrent restore completions are generation- and token-fenced; late A cannot overwrite newer B state or persisted binding.
3. Blocker 3 fixed: deterministic behavioral tests now cover malformed binding storage and overlapping controller-service drain/tick semantics at runtime level, not source shape.

## Known warnings only

- existing `NO_COLOR` / `FORCE_COLOR` node warnings
- existing mobile Node SQLite experimental warnings

## Constraints honored

- no commit
- no push
- no EAS build
- no deploy
- no app install
- no app restart
- no live DB/request/controller mutation
