# Desktop · Page 08 — Scheduler

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
The lead differentiator: per-project durable cron. Create and manage recurring/one-off schedules, concurrency, retries, and misfire policies — and trust that nothing dies when the lid closes.

## Layout
Header: "Scheduler", segmented `Calendar · List`, blue pill "New schedule".

### Calendar view (default)
A clean week grid (iOS Calendar aesthetic: white canvas, hairline grid, red now-line). Scheduled runs as small rounded chips colored by project, with a tiny trigger glyph. Missed runs (machine was asleep) render with a dashed amber outline and a tooltip "Missed — fired on wake (policy: fire-now)". Clicking a chip opens the schedule inspector.

### List view
Grouped by project: rows show cron summary in plain words ("Every weekday at 06:00"), next run countdown ("in 7h 12m" mono), concurrency badge, misfire policy chip, and an iOS switch to pause.

## New/Edit schedule (centered frosted sheet, 520px)
1. Project + job template picker (two grouped rows).
2. **When** — natural-language field ("every Monday 9am") with a parsed-preview line beneath ("Mon 09:00 · next: 16 Jun"), plus an "Advanced cron" disclosure revealing a mono cron field.
3. **Durability group** (grouped-inset): Misfire policy segmented `Fire now · Skip · Coalesce` with one-line explanations; Retries stepper + backoff picker; Concurrency limit stepper.
4. **Budget** — per-run cap field with parent-remaining hint ("Project has $31.40 left").
5. Footer: estimate line "≈ $0.18/run · ≈ $5.40/month at this cadence" and Save pill.

## States
Empty: "Schedules run even while you sleep — the job resumes from checkpoint if the Mac does too." Paused schedules grey. A schedule blocked by budget cap shows red chip "Blocked — cap".

## Micro-interactions
Natural-language parse updates live with a gentle text morph. Toggling pause animates the row's tint. The week grid's now-line moves in real time.
