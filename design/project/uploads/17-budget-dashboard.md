# Desktop · Page 17 — Budget & Cost Governance

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
The operator's bill-shock shield: workspace ceiling, per-project caps, live meters, the unified ledger, savings from caching/batch, and auto-downgrade rules. Numbers are the heroes — set them in mono, large, confident.

## Layout
- **Hero band:** three glass stat cards — **This month** (`$38.20` huge mono with ring gauge vs `$200` ceiling), **Today** (with hour sparkline), **Projected** (`≈ $96 by Jun 30`, amber if > ceiling). Ring colors: blue → amber 75% → red 90%.
- **Per-project caps:** horizontal bar list — project name, hairline track with fill, cap value as an editable mono field at the bar's end (tap to edit, confirm sheet), and a chip when capped ("Paused at cap"). Drag handle absent — caps edit numerically only.
- **Cost breakdown:** stacked area or bar chart by category with semantic colors and a legend of plain words: Models · Video · Images · Voice/Avatar · Search · Renders · Publishing. Toggle chips: `By project · By category · By model role`.
- **Savings card (delight moment):** "Caching & batch saved **$41.07** this month" with a small green leaf-free icon (use a down-arrow-in-circle), breakdown lines: cache hits 90% off, batch −50%.
- **Ledger:** the append-only table — time, project ▸ job, item ("Opus tokens · build pass", "Video render · 24s"), qty, unit cost, total (mono right-aligned), all filterable; row click opens the originating session.
- **Rules section (grouped-inset):** Auto-downgrade switch ("Near a cap, switch to cheaper models automatically"), threshold stepper, notification thresholds.

## States
A 429/cap event surfaces as a pinned red card: "PsychGate hit its $50 cap and paused · Raise cap / Review jobs". Loading skeletons keep number slots fixed-width to avoid jumpiness.

## Micro-interactions
Numbers count-animate on load (fast, 400ms). Ring gauges sweep in. Editing a cap shows live "remaining for jobs" math beneath the field.
