# Mobile · Page 04 — Job Live Timeline (Streaming Transcript)

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Watch one agent run live from the phone: streamed narration, tool calls, checkpoints, cost — readable on a 390pt screen while walking.

## Layout
- **Header (compact, frosted):** back chevron, job name + project caption, status pill with breathing dot, overflow menu (Pause · Cancel · Share).
- **Meter strip (pinned under header):** three mono stats in a hairline-divided row — `$0.84` ticking · `12:40` elapsed · effort chip `BALANCED`. Tapping expands a detail sheet (tokens, model roles, loaded skills).
- **Timeline (the body):** a single-column stream optimized for mobile reading:
  - Narration: body text streaming with caret, 17pt, comfortable line height.
  - Tool calls: full-width grey chips `▸ bash · npm test ✓ 3.2s` — tap to expand stdout in a mono code sheet (bottom sheet, scrollable, share button).
  - Step markers: centered tiny labels with hairlines ("Plan ✓ — Build —") as the run advances.
  - Diffs: a compact card "12 files changed +204 −67" → opens Diff Review (Page 06).
  - Gate: when the run parks, an amber inline card with Approve/Review pills (same component as Approvals).
- **Floating "Jump to live ↓" pill** appears when the user scrolls up.

## States
Suspended at gate (amber pinned banner), resumed-from-checkpoint system row, failed (red summary + "Retry from checkpoint"), completed (green summary card: cost, duration, artifact buttons — "View PR", "Play video").

## Micro-interactions
New content rises in smoothly; never jumps under the thumb. Haptic tick when the run changes phase. Pull down from top reveals the run outline (step list) as a sheet.
