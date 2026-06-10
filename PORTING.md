# Maestro — Design → Code porting tracker

**Status: ✅ ALL 32 screens ported to native code. Both apps typecheck clean (`tsc --noEmit` EXIT 0).**

The Claude Design handoff (`design/`) is fully recreated:
- **Desktop** — `apps/desktop` (Electron + Vite + React): shared lib (`icons`, `ui`, `appShell`) + router + launcher + **20 screens**.
- **Mobile** — `apps/mobile` (Expo + React Native): theme + nav + icons + UI atoms + **12 screens**.

~16,000 lines of native app code. The bulk port was done by a 33-agent parallel workflow against fixed contracts, then integrated + typechecked.

## Verification done
- `pnpm --filter @maestro/mobile exec tsc --noEmit` → **EXIT 0**
- `pnpm --filter @maestro/desktop exec tsc --noEmit` → **EXIT 0**
- Screens confirmed substantial (not stubs).

## Still to do (next)
- **Run + visual QA** each app against the design (I can't render a GUI/simulator here — needs a launch). Desktop needs a normal `pnpm install` (downloads the Electron binary; the typecheck install used `--ignore-scripts`).
- Polish any pixel deltas the parallel ports introduced.
- Wire both apps to **Maestro Core** (`packages/core`) over the RPC contract (currently UI with mocked data from the design).

## Desktop — `apps/desktop/src/screens` (Electron + React)
✅ Onboarding · Command Center · Projects · Project Detail · Templates · Job Monitor · Session Transcript · Scheduler · Plan & Diff Gate · Approvals Center · Skills Registry · MCP Gateway · Media Studio · Publishing Center · Trend Intelligence · Comms Gateway · Budget Dashboard · Settings · Pair a Phone · Audit & History — **20/20**

## Mobile — `apps/mobile/src/screens` (React Native)
✅ Onboarding · Home · Jobs · Job Timeline · Approvals · Diff Review · New Job · Budget · Studio · Notifications · Settings · Outbox — **12/12**

## Run
```bash
pnpm install                              # normal install (gets the Electron binary)
pnpm --filter @maestro/desktop dev        # Electron desktop app
pnpm --filter @maestro/mobile start       # Expo; press i (iOS) / a (Android); npx expo install --fix once on new Node
```
