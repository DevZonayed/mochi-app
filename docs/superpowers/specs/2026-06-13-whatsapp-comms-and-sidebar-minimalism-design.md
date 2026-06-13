# WhatsApp Comms (with full history) + Sidebar Minimalism

Date: 2026-06-13
Status: approved (verbal) — building

## Goals

1. **WhatsApp is a real, working channel** in Comms (no more "Coming next").
   Connect via QR, and **store every message with full history**.
2. **Minimalist sidebar** — trim 13 root items to the operational core; move the
   rest into Settings or a demoted "More" group.

## Non-goals (this pass)

- Binding WhatsApp chats to *run jobs / approve gates* (Telegram already does
  this; WhatsApp job-control is a fast-follow). This pass is **connect +
  capture + history + browse**.
- WhatsApp *sending* from the UI (capture-only v1, mirroring the Mochi reference).
- Deep historical backfill beyond what WhatsApp pushes on link (best-effort).

## Architecture — "the Mac is the brain"

WhatsApp runs **in Maestro's own Electron main process** (approach A), mirroring
`electron/telegram.ts`. No dependency on any external/other-tool process.
Reference implementation to port from: the Mochi plugin's
`server/src/comms/whatsapp.js` (Baileys 6.7.23, QR pairing, reconnect/backoff,
single-writer lock, per-chat append-only JSONL store).

### Backend (`apps/desktop/electron`)

- **`whatsapp.ts`** — `WhatsAppProvider` class, ctor `(store, emit)`:
  - `connect()` — lazily import Baileys; `useMultiFileAuthState` in
    `userData/whatsapp/auth`; on `connection.update` with a `qr`, stash the QR
    string and `emit('comms', status)`; on `open`, mark connected + record the
    linked JID/name; on `close`, reconnect with backoff unless logged out.
  - `messages.upsert` handler → `normalize()` → `store.appendWaMessage(...)`
    (append-only, full history) + `emit('comms', status)`.
  - `disconnect()` — logout, clear auth dir + connected state.
  - `resumeOnBoot()` — reconnect if an auth session exists.
  - Single-writer `.lock` in the auth dir (port from reference).
- **Message history store** — files, NOT the 200-cap `commEvents` JSON blob:
  - `userData/comms/whatsapp/<accountId>/<chatId>/messages.jsonl` (append-only),
    `cursor.json` (newest/oldest/count), `meta.json` (chat name + kind).
  - New `store.ts` helpers: `appendWaMessage`, `listWaChats`, `getWaMessages`
    (paged, server-capped), plus `whatsapp` connection state
    (`{ connected, jid, name, connectedAt }`) and `commsStatus().whatsapp`
    upgraded from the `{ connected: false }` stub to a real status (incl. a
    transient `qr` field while pairing).
- **`localApi.ts`** — cases: `connectWhatsApp`, `disconnectWhatsApp`,
  `listWaChats`, `listWaMessages`. **`main.ts`** — instantiate the provider,
  `resumeOnBoot()`, pass into `createDispatch`, stop on quit.
- **`package.json`** — add `@whiskeysockets/baileys` (and mark it `external` in
  the electron-main rollup config, like the agent SDK). `qrcode` already present.

### Frontend (`apps/desktop/src`)

- **`api.ts`** — types `WaChat`, `WaMessage`, extend `CommsStatus.whatsapp`;
  methods `connectWhatsApp`, `disconnectWhatsApp`, `listWaChats`,
  `listWaMessages`.
- **`CommsGateway.tsx`** — split into `CommsPanel` (no AppShell) + a thin
  default export that wraps it in AppShell (keeps `/comms` working).
  - **Channels tab**: replace the dead WhatsApp card with a real flow — QR
    (rendered from the Baileys QR string via the `qrcode` lib, like
    `DevicePairing`), "Linked as …" connected state, Disconnect.
  - **History tab** (new): chats list → message thread, reading the stored
    JSONL via `listWaChats` / `listWaMessages`.

## Sidebar minimalism

- **`routes.ts`** — split `NAV_ROUTES` into `PRIMARY_NAV` (Home, Workspace,
  Projects, Jobs, Approvals, Scheduler) and `SECONDARY_NAV` (Skills, Templates,
  Trends, Studio, Publishing). Remove **Comms** and **Costs** from the sidebar
  entirely (they live in Settings now). `ALL_NAV` still includes everything for
  active-key lookup + route resolution.
- **`appShell.tsx`** — render PRIMARY, then a muted **"More"** group header +
  SECONDARY items below it.
- **`Settings.tsx`** — add `comms` and `costs` sections to `SET_NAV`; render the
  extracted `CommsPanel` and `BudgetPanel` (wider/full pane, not the 640 cap).
  Support an **initial section** via `location.state.section` so deep-links land
  right.
- Repoint **BudgetChip** (toolbar) + the ⌘K palette "Costs" → Settings · Costs.
  Keep `/comms` and `/budget` routes as standalone fallbacks.

## Data flow

WhatsApp socket (Electron main) → `messages.upsert` → normalize → append JSONL +
update cursor/meta → `emit('comms')` → renderer `subscribe({ onComms })` refetch
→ History tab shows it. QR string flows the same `emit('comms')` path while
pairing; renderer renders it to a canvas/img with `qrcode`.

## Risks / mitigations

- **Baileys is heavy / dynamic requires** → keep it `external` (runtime require
  from node_modules), lazy-import inside `connect()` so the app boots without it
  loaded. Proven by the Mochi reference build.
- **Single WhatsApp socket per session** → single-writer lockfile (ported);
  Maestro's own auth dir is independent of any other tool's (WhatsApp allows
  multiple linked devices).
- **History volume** → per-chat JSONL files + server-side paging caps; never the
  single JSON blob.

## Verification

- `pnpm --filter @maestro/desktop typecheck` clean.
- `pnpm --filter @maestro/desktop build` clean (baileys externalized).
- Launch app: WhatsApp card shows a QR; (manual) scan links; messages land in
  History; sidebar shows the trimmed primary + "More" group; Settings has Comms
  & Costs panes.
