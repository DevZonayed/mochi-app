# Mobile · Page 05 — Approvals (Tab 3, the heart of the app)

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
The phone's reason to exist: approve/edit/reject/respond to gates from anywhere in under 10 seconds, with full confidence. Push notifications deep-link here.

## Layout
Large title "Approvals" with a red count badge on the tab icon. The queue as **full-width gate cards** (one per gate, generously sized):

Each card: gate-type icon in tinted squircle + type label ("Plan approval", "Publish draft", "Merge", "Over budget", "New skill"), project chip, age, then a **type-specific body**:
- **Plan:** first 3 steps as checklist rows + "View full plan" link (push to reading view).
- **Publish:** media thumbnail (tappable full-screen preview with caption + platform chips + provenance badges `AI label ✓ · C2PA ✓`).
- **Merge:** "+204 −67 · 12 files · reviewer: 0 issues" summary line + "Review diff" link (→ Page 06).
- **Over budget:** big mono "$4.10 over · cap $50" with three option rows (Raise to $60 / Downgrade model / Abort).
- **Skill:** requested capabilities as plain rows with risk tint.

**Action bar (bottom of every card, identical):** **Approve** (blue pill, prominent, with haptic), **Reject** (red text), **Edit** and **Respond** (quiet icons — Respond opens a message field sheet that feeds the agent).

## Notification → approval flow (design it)
Lock-screen notification with Approve/View actions; tapping View opens the gate card full-screen as a modal with Face ID glyph moment for destructive types ("Confirm with Face ID" for publishes/merges).

## States
Empty: serene "All clear." with soft check. Resolved-elsewhere: card flips to grey "Approved on your Mac" then auto-dismisses. Offline: cards remain actionable with an outbox note "Will apply when reconnected" (amber chip).

## Micro-interactions
Approve: blue pill fills → check pop → card slides off; next card rises. Reject requires a brief hold-to-confirm fill (0.6s) — deliberate friction.
