# Desktop · Page 03 — Projects Overview

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Browse all projects under the single Workspace. Each project is typed by a template (Code / Design / Content / Research / custom) and carries its own budget, schedule, and live status.

## Layout
Sidebar + toolbar as standard. Header: Large Title "Projects", right-aligned segmented control `Grid · List`, and a blue "New project" pill.

**Grid view (default):** responsive cards (320px min), 20px radius, white. Each card:
- Top row: template icon in a tinted squircle (Code = blue terminal, Design = teal brush, Content = purple play, Research = indigo telescope) + project name (Headline) + overflow "···" menu.
- Middle: status line — "2 jobs running · 1 gate waiting" with colored dots; or "Idle".
- Budget mini-bar: hairline track, fill colored by health (blue → amber ≥75% → red ≥90%), mono caption `$14.20 / $50`.
- Bottom row: sub-project count chip, next scheduled run ("Next: 06:00"), last activity timestamp.
- A thin colored top edge (3px) in the template color.

**List view:** grouped-inset table rows with the same data in columns; sortable by spend / activity.

## States
Empty: large friendly illustration-free state — "Projects keep instructions, budget, and schedules together. Create one from a template." + template quick-pick row. Card skeletons. A project at hard cap shows a red "Paused — budget cap" ribbon.

## Micro-interactions
Cards lift 2px + shadow deepen on hover. "New project" opens the Template Gallery (Page 05) as a frosted modal. Drag a card onto another is NOT supported — keep it calm.
