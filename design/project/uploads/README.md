# Maestro — UI/UX Design Prompts (Desktop + Mobile)

One markdown file per page. Each is a self-contained, copy-paste-ready design prompt for AI design/build tools (Lovable, v0, Figma Make, Claude, etc.) — **always pair it with `00-DESIGN-SYSTEM.md`** so every page lands in the same Apple-grade, iOS-styled visual language.

## How to use
1. Open `00-DESIGN-SYSTEM.md` — paste it first (or attach it) in every design session.
2. Pick a page file, paste its content as the prompt.
3. Iterate per page; the design system keeps everything consistent.

## Desktop application (Electron, macOS-first) — 20 pages
| # | File | Page |
|---|------|------|
| 01 | desktop/01-onboarding-setup.md | First-run setup wizard (workspace, OAuth, budget, pairing) |
| 02 | desktop/02-command-center-dashboard.md | Command Center home dashboard |
| 03 | desktop/03-projects-list.md | Projects overview (grid/list) |
| 04 | desktop/04-project-detail.md | Project detail (goal composer, tabs) |
| 05 | desktop/05-project-templates.md | Template gallery + editor |
| 06 | desktop/06-job-monitor.md | Fleet job monitor (swim-lane timeline) |
| 07 | desktop/07-session-transcript.md | Job detail / live streaming transcript |
| 08 | desktop/08-scheduler.md | Per-project scheduler (calendar + durability) |
| 09 | desktop/09-plan-review-diff-gate.md | Plan gate + code diff review gate |
| 10 | desktop/10-approvals-center.md | HITL approvals queue |
| 11 | desktop/11-skills-registry.md | Skills registry / personal marketplace |
| 12 | desktop/12-mcp-gateway-tools.md | Tools & MCP gateway (live audit stream) |
| 13 | desktop/13-media-studio.md | Creative media studio pipeline |
| 14 | desktop/14-publishing-center.md | Publishing center (drafts, calendar, quotas) |
| 15 | desktop/15-trend-intelligence.md | Trend & research intelligence |
| 16 | desktop/16-comms-gateway.md | Telegram & WhatsApp comms gateway |
| 17 | desktop/17-budget-dashboard.md | Budget & cost governance |
| 18 | desktop/18-settings-security.md | Settings, secrets & security |
| 19 | desktop/19-device-pairing.md | Phone pairing (QR) |
| 20 | desktop/20-audit-run-history.md | Audit log & run replay |

## Mobile application (React Native / Expo, iPhone-first) — 12 pages
| # | File | Page |
|---|------|------|
| 01 | mobile/01-onboarding-pairing.md | Welcome + QR pairing |
| 02 | mobile/02-home-dashboard.md | Home (needs-you stack, live jobs) |
| 03 | mobile/03-projects-jobs-list.md | Jobs & projects tab |
| 04 | mobile/04-job-live-timeline.md | Live streaming job timeline |
| 05 | mobile/05-approvals-gate-queue.md | Approvals queue (the heart) |
| 06 | mobile/06-diff-review.md | Mobile diff review |
| 07 | mobile/07-new-job-quick-trigger.md | New job quick-trigger sheet |
| 08 | mobile/08-budget-meters.md | Budget ring & caps |
| 09 | mobile/09-media-gallery-preview.md | Studio gallery & full-screen preview |
| 10 | mobile/10-notifications.md | Notifications center + push designs |
| 11 | mobile/11-settings-devices.md | Settings & device security |
| 12 | mobile/12-offline-outbox.md | Offline mode & intent outbox |

## Cross-platform components defined in the system file
Effort Dial (signature), HITL gate card, budget meters/rings, provenance badges, streaming transcript blocks, frosted chrome. Keep these pixel-identical in spirit across both apps.
