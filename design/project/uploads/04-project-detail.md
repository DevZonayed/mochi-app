# Desktop · Page 04 — Project Detail

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
The home of one project: its sub-projects, jobs, instructions, skills, allowed tools, budget, and triggers. This is where the operator hands the project a goal.

## Layout
Sidebar persists. Content header: breadcrumb (Workspace / Project), Large Title with template icon, status pill, and primary blue pill **"New job"** plus a quiet "Run from template" split option.

**Tab bar (iOS segmented control, sticky under header):** `Overview · Jobs · Instructions · Skills & tools · Budget · Settings`

### Overview tab
- **Goal composer (hero):** a large rounded input card — placeholder "Hand this project a goal…", with the **Effort Dial** (FAST/BALANCED/DEEP/MAX, signature component), an autonomy segmented control `Plan first · Gated · Unattended`, and a mono pre-run estimate line that updates live ("≈ $0.60 · ~6 min at BALANCED"). Send button = blue circle with up-arrow (iMessage style).
- Below: **Sub-projects** as horizontal chips/cards (own branch, own mini budget bar), then **Recent jobs** list (status, cost, duration).

### Jobs tab
Full job table: trigger icon (hand/clock/chat/webhook), name, shape chip (single / plan-build-review / fan-out / pipeline), status, cost mono, started, duration. Filter chips above: All · Running · Scheduled · Gated · Failed.

### Instructions tab
A two-pane editor: left = versioned instruction document (clean writing surface, SF Pro, comfortable 680px measure); right rail = "Resolved view" showing the concatenation Workspace → Project → Sub-project with origin labels, and hard guardrails listed as locked rows with a small lock glyph ("Never publish without a gate 🔒 — Workspace rule").

### Skills & tools tab
Two grouped-inset sections: **Starter skills** (rows: skill name, version chip, signature ✓shield, toggle) and **Allowed MCP servers** (deny-by-default banner on top; rows with scope summary "read-only · 3 tools"). "Add from registry" opens Page 11.

### Budget tab
Big mono spend figure, ring gauge vs hard cap, per-job spend bars, and a red-outlined "Hard cap" stepper field with confirm sheet.

## States & micro-interactions
A job hitting its gate slides a card into the Overview top with a gentle amber glow. Estimate line counts up/down as the Effort Dial changes; at DEEP/MAX the multiplier chip appears with a soft amber fade-in.
