# Desktop · Page 14 — Publishing Center

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Draft-mode-first auto-publishing to YouTube, TikTok, Instagram/Threads, X, LinkedIn, Pinterest, Bluesky. Manage drafts awaiting approval, the publish calendar, platform connections, quotas, and the provenance ledger.

## Layout
Segmented: `Drafts · Calendar · Platforms · Ledger`.

### Drafts tab (default)
Card grid of pending publishes: 9:16 or 16:9 thumbnail, title, caption preview (2 lines), destination platform chips (each with its brand glyph in monochrome), scheduled time, provenance badges (`AI label ✓ · C2PA ✓`), and two pills: **Approve & schedule** (blue) / **Edit**. TikTok/IG drafts carry an info chip "Goes to in-app drafts (platform rule)".

### Calendar tab
Month/week grid (iOS Calendar look) with publish chips colored per platform; drag to reschedule (chip lifts with shadow, snaps to slot, confirm toast).

### Platforms tab
Grouped rows per platform: brand glyph, connection status pill, quota meter (hairline bar — "4 / 6 uploads today" for YouTube units; "Tokens refresh in 14h" for TikTok), audit-state chip where relevant (`Audit pending · posts are self-only`), cost note for X ("~$0.20 per post with URL — links go in replies"), and Connect/Reconnect button.

### Ledger tab
Append-only table: time, asset thumb, platforms, outcome ✓/✕, quota cost, provenance hash (mono truncated). Read-only, exportable.

## States
Empty drafts: "The studio's output lands here first. Nothing publishes without you." Quota-exhausted platform rows turn amber with countdown to reset. Failed publish row: red dot + "Retry" inline.

## Micro-interactions
Approving a draft animates it from the grid into a small calendar fly-to. Platform connect uses the same OAuth waiting state as onboarding.
