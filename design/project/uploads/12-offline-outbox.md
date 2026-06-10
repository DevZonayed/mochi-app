# Mobile · Page 12 — Offline Mode & Intent Outbox

> Use together with `00-DESIGN-SYSTEM.md`. This is a cross-cutting state layer + one dedicated screen — design both.

## Purpose
The phone keeps working when the relay or Mac is unreachable: browse synced state, queue approvals and job requests as **intents**, reconcile on reconnect with zero lost actions and zero duplicates. The design must make queued-vs-applied unmistakable.

## Part 1 — Global offline treatment
- A slim amber banner under the nav bar on every screen: "Offline — showing state from 4 min ago" with a subtle cloud-slash glyph; turns blue "Reconnecting…" with an indeterminate hairline progress, then green "Synced" for 2s before dismissing.
- Any action taken offline gets an immediate optimistic UI + an **amber outline + clock chip** ("Queued") instead of the usual confirmation, with haptic still firing.

## Part 2 — Outbox screen (from Settings or banner tap)
Large title "Outbox". List of queued intents as cards: intent icon + plain description ("Approve plan — PsychGate", "Start job — Kvanti research"), queued time, and a small red ✕ to withdraw (confirm alert). Footer caption: "Applies in order when your Mac is reachable. Each action carries a one-time token — nothing runs twice."

## Part 3 — Reconciliation moments (design these states)
- **Applied:** card flashes green check and slides out; a stacked toast summarizes "3 actions applied".
- **Rejected on validation:** card flips to a red-tinted result ("Couldn't apply: this gate timed out at 09:14") with a "View job" link — honest, specific, no apology.
- **Conflict (already decided on Mac):** grey result "Already approved on your Mac — nothing to do."

## States
Empty outbox: "Nothing waiting. Actions you take offline will queue here."

## Micro-interactions
Banner state changes cross-fade. The reconnect "Synced" moment has a single soft haptic. Queue cards reorder with spring when one is withdrawn.
