# Mobile · Page 03 — Jobs & Projects (Tab 2)

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Browse every project and job from the phone: filter, drill in, pause/cancel, and fire quick runs.

## Layout
Large title "Jobs". Beneath: a horizontally scrolling **project filter row** — circular project avatars (template-tinted squircles) with name captions, "All" first; selected gets a blue ring.

**Job list (grouped by state with sticky iOS section headers):**
- **Gated** (amber group, always on top when non-empty)
- **Running** — rows: status dot (breathing), job name, project caption, mono cost ticking, elapsed; trailing chevron.
- **Scheduled** — rows with clock glyph and countdown ("in 2h 10m").
- **Done today** — compact, ✓/✕ + cost.

**Swipe actions (iOS native):** running row ← swipe reveals Pause (grey) and Cancel (red, confirm alert); scheduled row ← reveals Skip next; any row → swipe reveals Pin.

**Floating action:** a blue circular "+" above the tab bar → New Job sheet (Page 07).

## Project detail (push)
Header card: template icon, name, budget hairline bar with mono caption, autonomy + default-effort chips. Sections: Running here, Schedules (rows with pause switches), Sub-projects (chips), and a compact goal composer (single field + Effort Dial in a bottom-aligned card) for firing a job on the go.

## States
Cap-paused project: red chip on its avatar and a banner inside detail. Empty filter result: "No jobs for this project yet."

## Micro-interactions
Section counts update live. Cancel confirm uses native-style alert with destructive red.
