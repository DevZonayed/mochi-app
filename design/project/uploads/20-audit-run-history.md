# Desktop · Page 20 — Audit Log & Run History

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
The tamper-evident memory of the platform: every tool call, send, publish, gate decision, key access, config change, and spend event — plus replayable run history. Designed to make "what happened at 3am?" answerable in seconds.

## Layout
Segmented: `Runs · Audit`.

### Runs tab
Searchable list of completed sessions: rows with project chip, job name, outcome glyph (✓ green / ✕ red / ⏸ cancelled grey), shape chip, total cost mono, duration, and date grouped by day with sticky day headers ("Today", "Yesterday", "June 8"). Row click → read-only replay of the Page 07 transcript with a playback scrubber on top (drag to scrub through the run's timeline; events light up as you pass them).

### Audit tab
Dense, beautiful forensic table on white: monotonic seq number (mono, grey), timestamp, actor chip (job / operator / system), event type icon + plain-language line ("Published video to YouTube", "Key used: Anthropic", "Gate approved from iPhone", "Skill quarantined: description drift"), and a chain-integrity glyph column (tiny linked-chain icon, green). Top bar: filter chips by event class, date range picker (iOS calendar popover), export button.

**Integrity banner:** a slim green bar atop the table "Hash chain verified · 41,209 entries intact"; if ever broken, it becomes the page's loudest element (red, "Chain broken at #31,002 — entries after this point may have been altered").

**Redaction rows:** subject-erased entries render as a grey tombstone row "Content redacted (consent withdrawn) · event preserved" with a small ghost glyph.

## States
Empty audit (fresh install): "Every action will be recorded here, permanently." Export progress toast.

## Micro-interactions
Scrubbing the run replay animates the cost meter and step outline in sync. Hovering a chain glyph reveals the entry hash in a mono tooltip.
