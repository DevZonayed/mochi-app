# Desktop · Page 11 — Skills Registry & Personal Marketplace

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Browse, search, publish, and inspect the operator's own skill registry (npm-for-skills, zero payments). Includes the security story: signatures, scan results, rug-pull quarantine.

## Layout
Header: "Skills", big iOS search field ("Search your registry — semantic"), segmented `All · Installed in projects · Published by you · Quarantined`, and a blue pill "Publish skill".

**Results as list rows (grouped-inset), not a store grid — this is a registry, keep it utilitarian-premium:**
Each row: skill icon (auto-generated tinted glyph), name (mono-ish emphasis), version chip, one-line description, trust cluster on the right — signature shield (green ✓ / grey unsigned), scan status chip (`Scanned ✓` green, `Re-scan pending` amber, `Quarantined` red), and download/use count caption.

**Skill detail (push navigation within the page):**
- Header card: name, version picker (semver dropdown, mono), signed-by line, SHA-256 (truncated mono, copy on click).
- Tabs: `About` (the SKILL.md description rendered beautifully, "what + when" emphasized), `Capabilities` (declared permissions as rows — network hosts, FS paths, tools — each with a plain-language line), `Versions` (timeline with scan result per version), `Security` (scan findings list; if drifted: red banner "Description changed since approval — quarantined until you re-approve" with diff of old/new description and a **Re-approve** flow).
- Primary action: "Add to project…" (project picker popover).

## Publish sheet
Drag-and-drop zone for the bundle, auto-read manifest preview, signing row ("Sign with your key ✓"), scan progress (3 staged steps with check animations: Integrity → Static scan → Listed), publish pill.

## States
Empty registry: "Publish your first skill — agents will find it by meaning, not name." Quarantine tab uses calm red, never alarming.

## Micro-interactions
Semantic search results reorder with spring as the query refines. The scan steps complete sequentially with check pops.
