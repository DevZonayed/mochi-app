# Desktop · Page 02 — Command Center (Home Dashboard)

> Use together with `00-DESIGN-SYSTEM.md`. Desktop, macOS chrome, iOS visual language.

## Purpose
The operator's cockpit and default screen: everything running right now, what needs a decision, what it's costing, across all projects. Glanceable in 3 seconds.

## Layout
- **Left:** standard Maestro sidebar (260px, frosted): Workspace name header, nav groups — Home, Projects, Jobs, Approvals (with red badge count), Scheduler, Skills, Studio, Publishing, Budget, Settings. Active item: blue tint pill.
- **Toolbar:** frosted, traffic lights left; center search field "Search or press ⌘K"; right: live budget chip (`$38.20 / $200` mono, turns amber at 75%, red at 90%) and a bell icon.
- **Main (3-zone grid):**
  1. **"Needs you" strip (top, full width)** — horizontally scrollable cards for pending HITL gates: each card shows project color dot, gate type icon (plan / publish / merge / over-budget), one-line summary, age ("4 min"), and two inline pill buttons Approve (blue) / Review (grey). Empty state: subtle "Nothing needs you — the fleet is working." with a calm checkmark.
  2. **Active jobs (left 2/3)** — list of live job rows: project chip, job title, animated status (Building / Reviewing / Rendering with purple breathing dot), progress bar (hairline, blue), live token/$ mini-meter in mono, elapsed time. Row click → Job Detail. Streaming rows show a single line of live agent output in mono, fading at edges.
  3. **Right rail (1/3)** — stacked glass cards: **Today's schedule** (next 5 scheduled runs with times), **Spend today** (mini bar chart by project, semantic colors), **Recently completed** (compact rows with ✓/✕ and cost).

## States
Skeleton shimmer for all three zones. Fully-empty workspace: hero invitation "Create your first project" with template thumbnails.

## Micro-interactions
Approving from the strip: card compresses, check pops, strip reflows with spring. Budget chip count-up animates on change. ⌘K opens a frosted command palette (design it: centered, 640px, recent commands + actions like "Run job…", "New project…").
