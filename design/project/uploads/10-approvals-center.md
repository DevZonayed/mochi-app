# Desktop · Page 10 — Approvals Center (HITL Gate Queue)

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Every pending human-in-the-loop gate across the workspace in one queue: plan approvals, publish drafts, merges, outbound sends, over-budget escalations, unverified-skill prompts. Designed for fast, confident decisions.

## Layout
Split view:
- **Left (360px) — queue list:** grouped by urgency (Over budget / Waiting longest / New). Each row: gate-type icon in tinted squircle (plan = blue doc, publish = purple play, merge = green branch, send = teal paper-plane, budget = amber gauge, skill = indigo shield), project chip, one-line summary, age, and source glyph if raised by a scheduled job (tiny clock). Unread = bold + blue dot.
- **Right — gate detail:** renders the appropriate gate component:
  - Plan → compact plan card (from Page 09 Mode A)
  - Publish → media preview card with caption, platform chips, provenance badge "C2PA ✓ · AI label ✓", consent badge where avatar/voice used
  - Merge → diff summary + reviewer verdict
  - Over-budget → big mono numbers "This run needs $4.10 more · cap $50" with options **Raise cap to $60 · Downgrade model · Abort**
  - Skill → manifest summary, requested capabilities listed as rows (network hosts, FS paths) with risk tint
- **Persistent action bar:** Approve / Edit / Reject / Respond — identical placement for every gate type so muscle memory works.

## States
Empty: serene full-bleed state — "All clear. Decisions will queue here, and on your phone." Resolved-from-phone rows collapse with a small device glyph "Approved on iPhone". Keyboard: ⌘↩ approve, ⌘⌫ reject — show shortcuts as subtle key chips in the bar.

## Micro-interactions
Deciding advances auto-focus to the next gate with a smooth list shift. Over-budget approve shows a 1-step confirm ("Raise this project's cap to $60?" sheet).
