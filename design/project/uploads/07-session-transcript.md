# Desktop · Page 07 — Job Detail & Live Session Transcript

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Inside one job: the live streaming agent transcript (plan → build → review), tool calls, checkpoints, cost meter, and controls. The operator should be able to read an agent's work like a clean conversation, not a log dump.

## Layout (3-column)
- **Left (220px):** run outline — vertical step list of workflow nodes (Plan ✓ → Build ● live → Review ○ → Gate ○) as a connected dot-line; clicking jumps the transcript. Below: checkpoints list ("Checkpoint 4 · 2 min ago") with a restore icon.
- **Center (fluid, max 760px measure):** the transcript. Message-bubble-free design — instead, **content blocks** on the white canvas:
  - Agent narration: SF Pro body text streaming in word-by-word with a soft caret.
  - Tool calls: collapsed mono rows in a grey rounded chip — `▸ bash · npm test · 3.2s ✓` — expand inline to show stdout in a code block (SF Mono 13, subtle syntax tint).
  - Thinking: optional collapsed lavender block "Thinking · 1.4k tokens" (expandable).
  - File diffs: mini diff cards with green/red hairline gutters and an "Open in review" link.
  - Gate moments: full-width amber card with the gate UI inline (see Page 10 component).
- **Right rail (300px):** live meters — token count + $ cost (mono, counting), elapsed, effort chips (build/review), model role chips ("builder · routed"), loaded skills list with shield icons, and buttons: Pause, Cancel (red), "Fork from checkpoint".

## Header
Breadcrumb Project / Job, status pill with breathing dot, Effort Dial (read-only here, shows what it ran at), share/export icon.

## States
Live (streaming caret + purple pulse on status), suspended-at-gate (amber banner pinned top: "Waiting for your approval — 12 min"), resumed-after-sleep (quiet grey system row in transcript: "Resumed from checkpoint after sleep"), failed (red summary card with error text + "Retry from checkpoint" blue pill), completed (green summary card with total cost, duration, artifacts row).

## Micro-interactions
Auto-scroll follows the stream but pauses the moment the user scrolls up (show a "Jump to live ↓" floating pill). Tool chips expand with spring. Cost ticks smoothly, no flicker.
