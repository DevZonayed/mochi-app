# Desktop · Page 06 — Job Monitor (Fleet Timeline)

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Mission control for every running, queued, scheduled, gated, and recently finished job across all projects — built to watch 10+ parallel agents without jank.

## Layout
Header: Large Title "Jobs", segmented control `Timeline · Table`, filter chips (All projects ▾, Running, Gated, Scheduled, Failed), and a live counter cluster: `7 running · 2 gated · 14 queued` as tinted pills.

### Timeline view (signature)
A horizontal swim-lane board: one lane per project (project color edge + name pinned left, 56px lane height). Time axis along top (now-line in blue, gently pulsing). Jobs render as rounded capsule bars positioned by start time and growing live; capsule shows status icon + truncated name + mono cost ticking up. States by fill: running = soft purple gradient with breathing edge; gated = amber with pause glyph; queued = grey outline; failed = red outline; done = solid quiet grey with ✓. Scheduled future jobs appear as dashed ghost capsules to the right of the now-line.

### Table view
Dense data table, iOS-styled (white grouped container, hairline row separators): columns Project · Job · Shape · Trigger · Status · Effort · Cost ($ mono) · Started · Duration · Actions (pause/cancel icon buttons).

## Right inspector (slide-over, 380px, frosted)
Click any job: inspector slides in with summary, live last-line of transcript, effort + autonomy chips, budget mini-meter, buttons **Open transcript** (→ Page 07), **Cancel job** (red, confirm sheet).

## States
Empty: "No jobs yet — schedules and triggers will fill this view." Skeleton lanes. A lane whose project hit its cap dims with a red cap chip.

## Micro-interactions
Now-line drifts in real time. Capsules extend smoothly (no jumps). Cancel: capsule collapses with a quick red flash then settles to failed style. 60fps with 50+ capsules — virtualize.
