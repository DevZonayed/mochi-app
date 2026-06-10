# Mobile · Page 08 — Budget & Live Meters

> Use together with `00-DESIGN-SYSTEM.md`. Reached from Home's "Today" strip or Settings.

## Purpose
Bill-shock peace of mind in your pocket: month ring, per-project bars, today's ledger, instant cap edits.

## Layout (scrolling, large title "Budget")
1. **Hero ring:** a large centered activity-style ring — spend vs workspace ceiling, `$38.20` huge mono in the center with `of $200` caption; ring blue → amber 75% → red 90%. Beneath, a projected line "≈ $96 by Jun 30" (amber when projecting over).
2. **Today strip:** hour-by-hour micro bar chart with the day's total.
3. **Per-project caps:** grouped-inset rows — project dot + name, hairline progress bar, mono `$14.20 / $50`; tapping opens a cap-edit sheet (number pad, parent-remaining hint, red-styled save when raising). Cap-paused projects show the red "Paused" chip.
4. **Savings card:** "Caching & batch saved $41.07 this month" green-tinted.
5. **Today's ledger:** compact rows (time, item in plain words, mono amount); "View all on Mac" footer link.

## Alerts integration
Design the budget push notifications: "PsychGate at 90% of its cap" (amber) and "Hard cap reached — jobs paused" (red) with a Raise-cap notification action that deep-links to the cap-edit sheet.

## States
Loading: rings sweep in with fixed-width number slots. A live expensive run (video render) pins a small ticking card on top: "Rendering · $3.40 and counting" with a Cancel link.

## Micro-interactions
Ring sweeps on load (600ms). Numbers roll. Cap save triggers haptic + the row's bar re-scales smoothly.
