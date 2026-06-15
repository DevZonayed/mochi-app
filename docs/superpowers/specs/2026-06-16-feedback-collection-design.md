# Feedback collection mechanism — design

**Status:** approved (operator: "go ahead… a button icon such as `!`, click opens a modal").
**Branch:** `DevZonayed/feedback-collection-mechanism`.

## Goal

A handy, always-available way to collect feedback inside Maestro: an `!`-style
icon button in the app chrome that opens a lightweight modal. Submissions are
stored on the Mac (the brain), reviewable in an in-app inbox, and optionally
escalated to a GitHub issue.

## Architecture (respects "the Mac is the brain")

- **Data + logic on the Mac.** A new `feedback` collection in the local JSON
  store; all create/list/update/delete + GitHub-issue logic in the shared
  `dispatch` (`localApi.ts`). The relay stays a pure conduit.
- **One renderer, two surfaces.** `apps/desktop/src` builds both the desktop app
  (IPC → dispatch) and the web remote (REST → relay → dispatch). Building the
  feature here covers desktop **and** web.
- **Relay + native mobile** get the submit path too; they only go live after a
  server deploy (gated), so they're built ready-but-dormant and flagged.

## Components

1. **Entry point** — `FeedbackButton` (a `tb-icon` with a new `feedback` glyph =
   message bubble + `!`) injected into `Toolbar` (general shell) and
   `CodingTopNav` (coding/design shells), so it shows on every screen.
2. **Modal** — `FeedbackModal`: category chips (Bug / Idea / Other) + message +
   auto-captured context (app version, platform, current screen, timestamp),
   shown collapsed. Submit → toast. Self-contained (injects its own keyframes;
   `position: fixed` overlay). A "View all feedback" link → `/feedback`.
3. **Store** — `Feedback { id, category, message, status, source, context,
   issueUrl?, issueNumber?, createdAt, updatedAt }`; capped at 500.
4. **Dispatch** — `submitFeedback`, `listFeedback`, `updateFeedback`,
   `deleteFeedback`, `feedbackCreateIssue` (last one desktop-only — uses the
   local GitHub token; blocked on the relay).
5. **Inbox screen** — `/feedback` (uses `AppShell`): filter by category/status,
   triage (new → triaged → done), delete, and one-click "Create GitHub issue"
   reusing the existing `github` provider token + a configurable target repo
   (`AppSettings.feedbackRepo`).
6. **Relay routes** — `GET/POST /api/feedback`, `POST /api/feedback/:id/update`,
   `POST /api/feedback/:id/delete`; `feedback` added to the snapshot. (Deploy-gated.)
7. **Native mobile** — `api.submitFeedback` + a "Send feedback" entry in the
   mobile Settings screen. (Deploy-gated.)

## Decisions / YAGNI

- Local inbox + optional GitHub routing (approach B). No pure pass-through.
- Screenshot attach deferred to a fast-follow.
- GitHub repo is configured once (inline in the inbox, persisted to settings);
  the action is hidden unless GitHub is connected.

## Out of scope (this pass)

- Deploying the relay/mobile path (operator-gated git push → Dokploy).
- A full mobile feedback inbox (mobile can submit; the Mac/desktop reviews).
