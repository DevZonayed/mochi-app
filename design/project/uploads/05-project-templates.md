# Desktop · Page 05 — Project Templates (Gallery + Editor)

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Templates are the "hats": saved presets (engine roles, effort defaults, starter skills, instruction scaffold, allowed triggers, UI layout). The operator browses shipped templates (Claude, Claude-Code, Claude-Design), clones, edits, authors new ones, and exports/imports.

## Layout
### Gallery (default view, also used as the "New project" modal)
Header "Templates" + "New template" pill + "Import" quiet button. Card grid: each template card shows tinted icon squircle, name, version chip (`v1.2.0` mono), one-line purpose, and a footer of tiny capability glyphs (effort default badge, review on/off, trigger icons). Shipped templates carry a subtle "Maestro" watermark chip; user templates show "Yours". Hover reveals two pill actions: **Use** (blue) and **Clone**.

### Editor (full-page, opens on edit/clone)
Left column (forms, grouped-inset sections):
1. **Identity** — name, icon picker (SF-symbol grid in a popover), color.
2. **Engine & effort** — logical role rows (Builder / Driver / Subagent / Reviewer) shown as read-only role chips with "routed by config" footnote; plan/build/review **Effort Dials** stacked; reviewer toggle with status chip `Eval-gated`.
3. **Starter skills & allowed tools** — token-field style chips with add button.
4. **Allowed triggers** — four iOS switches: Manual, Schedule, Chat message, Webhook.
5. **Instruction scaffold** — embedded mini editor.

Right column: **Live preview** — a miniature mock of the resulting project Overview (goal composer with the chosen defaults), plus a yellow callout if default effort > BALANCED: "DEEP default ≈ 5× cost on every run — sure?"

## States
Version history sheet (list of semver rows, "Rebase existing projects" explicitly absent — copy: "Editing creates v1.3.0. Existing projects keep their snapshot."). Export produces a toast "Template exported".

## Micro-interactions
Clone: card visually duplicates with a spring offset then opens the editor. Switching default effort animates the preview's estimate chip.
