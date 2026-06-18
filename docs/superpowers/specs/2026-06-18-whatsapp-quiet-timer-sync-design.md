# WhatsApp Quiet-Timer Sync — Design

**Date:** 2026-06-18
**Branch:** `DevZonayed/whatsapp-quiet-timer-sync`
**Status:** approved (operator: "do whatever's needed, make it smooth")

## One-line goal

When a tracked WhatsApp chat stops getting messages for 15 minutes, automatically
summarize what happened and send that summary to my own number — and keep chats
sorted by project/session.

## Behaviour (from the plain-English spec)

1. **Connect** the primary WhatsApp number to the desktop app (QR / pairing).
   Before the app takes any *meaningful* action (sending a message), it asks the
   operator a confirmation question rather than acting silently.
2. **Organize** each tracked chat into a project **and** a session.
3. **Quiet timer:** an incoming message in a tracked chat starts a 15-min
   countdown for that chat. A new message before expiry **resets** it to 15 min.
   Only a full 15 min of silence makes the timer **expire**.
4. **Analyze:** on expiry, read that conversation and understand what was
   discussed, decided, and whether anything needs action.
5. **Report:** send a short summary of that analysis to the primary number.
6. **Efficiency:** per-chat timers — only the chat that just received a message
   has its timer touched; analysis runs **once per quiet period**, not repeatedly.

## Architecture decision

**The desktop (Electron main) owns its own Baileys WhatsApp socket**, as a sibling
to `electron/telegram.ts`. Rationale:

- The Mac is the brain (owns data/auth/execution); a connection that only lives
  while an agent MCP session is attached is not always-on → not "smooth".
- Capturing **and** sending on one number requires that number's authenticated
  socket. The `mochi:comms` plugin is read-only and lives in a versioned global
  plugin cache — editing it won't ship in this repo's PR and is wiped on update.
- Owning the socket is the codebase's existing pattern (`telegram.ts`), is fully
  in-repo / shippable, and makes send-to-self trivial.

The `mochi:comms` plugin's `server/src/comms/whatsapp.js` is the **proven
reference** we adapt (auth via `useMultiFileAuthState`, exponential-backoff
reconnect with permanent-failure codes 401/440/500, QR/pairing via
`connection.update`, capture via `messages.upsert`). We are not inventing the
fragile parts — we are porting known-good ones.

### Components (each isolated, testable)

| Unit | File | Responsibility | Depends on |
|---|---|---|---|
| **WhatsApp client** | `electron/whatsapp.ts` (new) | Own one Baileys socket per account: connect (QR/pairing), capture inbound, send, reconnect, persist auth in userData, `powerMonitor` resume/suspend, `resumeOnBoot`. Pure-logic core (`quiet-timer.ts`) split out for tests with a mock socket. | `store`, `engine`, `providers`, `qrcode`, `@whiskeysockets/baileys` |
| **Quiet-timer logic** | `electron/quiet-timer.ts` (new, pure) | Given (chat, now) → compute/reset the 15-min deadline; decide expiry. No I/O → fully unit-tested. | — |
| **Scheduler glue** | `electron/cron.ts` (extend) | New `Schedule.kind: 'whatsapp-analyze'`; `fire()` routes it to the analysis path instead of a normal job prompt. | `store`, `engine`, WhatsApp client |
| **Analysis + report** | `electron/whatsapp-analyze.ts` (new) | Build transcript from store → `engine.run()` a summary job → send summary to self via the client. Confirmation gate (ask-question) before the **first** send per account. | `store`, `engine`, client |
| **Store schema** | `electron/store.ts` (extend) | WhatsApp account state; `ChatBinding` + `sessionId` + `whatsapp` kind; per-chat captured message log (cap-bounded); reuse one-shot `Schedule` (keyed by chatId) as the timer. | — |
| **API / dispatch** | `electron/localApi.ts` + `src/lib/api.ts` (extend) | `connectWhatsApp`/`whatsappQr`, `disconnectWhatsApp`, `listWaChats`, `bindWaChat({chatId, projectId, sessionId, ...})`, status in `commsStatus`. | — |
| **UI** | `src/.../CommsGateway.tsx` (extend) | WhatsApp panel: link via QR, pick allowlisted chats, assign chat→project+session, show connection + per-chat timer state + recent reports. | API |

### Data flow

```
inbound WA message (messages.upsert)
  → client._capture(): store.appendWaMessage(chatId, msg)  [allowlisted only]
  → if chat is tracked: store.upsertWaTimer(chatId)         [fireAt = now + 15m]
      (one-shot Schedule kind='whatsapp-analyze'; existing one for this chat → just bump fireAt = RESET)
CronRunner.tick() (existing 30s loop)
  → a 'whatsapp-analyze' schedule whose fireAt <= now fires once, then disables
  → fire(): analyzeQuietChat(chatId, sessionId)
      → transcript = store.getWaTranscript(chatId, sinceLastReport)
      → job = engine.run(summary prompt over transcript)     [LocalEngine / Claude]
      → gate: if first send for this account → ask-question confirm; else silent
      → client.sendToSelf(summary)
      → store.markWaReported(chatId, now)
```

### Quiet-timer = one-shot Schedule (reuse, don't reinvent)

`CronRunner` already fires one-shot `Schedule`s at `fireAt`, once, then disables
(cron.ts:84-94). The quiet timer is exactly this: one `Schedule` per tracked
chat, `kind: 'whatsapp-analyze'`, `fireAt = now + 15min`, carrying `chatId` +
`sessionId`. "Reset on new message" = update that one schedule's `fireAt`
(touch only the affected chat — the efficiency requirement). "Analyze once per
quiet period" = a fired one-shot disables itself; the next inbound message
re-arms a fresh one. Survives restart (schedules are JSON-persisted; forward-only
re-init on boot is the correct semantics — a chat quiet across a restart simply
fires on the next tick).

### Confirmation gate (ADR §11: inbound is untrusted; sends gated)

Per `docs/agentos/ADR.md §11`, outbound sends are gated behind allowlist +
explicit confirmation. Concretely: the **first** outbound send for an account
raises an approval ("Maestro wants to start sending WhatsApp summaries to your
own number — allow?"). Once approved, subsequent quiet-period summaries send
silently. Stored as `whatsapp.sendApproved` per account. Linking itself, chat
allowlisting, and analysis are non-destructive and don't gate.

### Send-to-self

The linked account's own JID = `jidNormalizedUser(sock.user.id)`. The report is
`sock.sendMessage(ownJid, { text })` — it lands in the operator's "message
yourself" chat / Note to Self.

## Security / safety

- **Allowlist-only capture:** only chats the operator has bound/allowed are
  stored or timed (mirrors the plugin's read+write allowlist guard).
- **Inbound untrusted:** captured text is treated as data for summarization, never
  as instructions to the agent; the analysis prompt frames it as third-party
  transcript to summarize, not commands to follow.
- **Auth isolation:** Baileys auth lives in `userData/whatsapp/<accountId>/auth/`,
  never in the relay snapshot, never committed.
- **Ban-risk consent:** linking the operator's own number carries WhatsApp ban
  risk (ADR §11) — surfaced as a one-time warning in the link UI.

## Scope / phasing

**This branch (smooth, end-to-end):** all components above, with:
- TDD'd pure logic (quiet-timer reset/expiry; transcript assembly; gate state).
- Mock-socket unit tests for the client lifecycle (mirrors plugin tests).
- Full UI to link + assign + observe.

**Honest verification limit:** scanning the QR with a real phone to link a live
number and observing real messages flow **cannot** be done headless in this
environment — that step is operator-driven. Everything else (logic, store, build,
typecheck, tests, UI render) is verified here; live capture is verified by the
operator after merge.

## Out of scope (YAGNI)

- WhatsApp Lane B (official Cloud API), groups admin, media summarization,
  replying *into* the tracked chat (we only report to self), mobile UI for this
  feature (desktop-first), configurable timer duration (fixed 15 min; trivial to
  surface later).
