# Desktop · Page 12 — Tools & MCP Gateway

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Manage MCP servers/tools per project, watch the gateway's live audit stream, and control scoping — the single chokepoint visualized. Must communicate safety without feeling like enterprise security software.

## Layout
Segmented control: `Servers · Live activity · Denials`.

### Servers tab
Project filter chip row on top. Grouped sections per project: server rows — favicon/glyph, server name, transport chip (`HTTP` / `stdio`), tool count ("12 tools · 3 loaded"), deferred-loading switch ("Load on demand" with footnote "Saves ~85% startup tokens"), scope summary ("read-only"), signature shield, and an iOS switch to enable. A grey banner atop every section: "Deny by default — agents reach only what you allow here." Add server button per section opens a sheet with registry verification step (reverse-DNS namespace shown with a verified badge).

### Live activity tab (the signature view)
A real-time vertical stream of tool calls, rendered as compact mono rows on the white canvas: timestamp · job chip · `server.tool` · scope chip · result dot (green ✓ / red ✕) · duration. New rows slide in from top with a 1px hairline flash. A pause button freezes the stream (iOS style). Filter field above.

### Denials tab
Red-tinted (subtle) rows: what was blocked, why ("Not on project allowlist", "Signature drift", "Capability not granted"), with an inline "Allow for this project…" quiet action that opens a scoped-grant confirm sheet.

## States
Empty activity: "Quiet. Tool calls will stream here in real time." A revoked job's calls grey out instantly.

## Micro-interactions
The stream must hold 60fps; rows are virtualized. Toggling a server off animates its tools count to zero with a soft collapse.
