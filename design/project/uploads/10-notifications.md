# Mobile · Page 10 — Notifications Center & Push Design

> Use together with `00-DESIGN-SYSTEM.md`. Two deliverables: the in-app notification list AND the system push notification designs.

## Part 1 — In-app list (bell icon from Home)
Large title "Activity". Grouped by day with sticky headers. Row anatomy: type icon in tinted squircle, plain one-line message, project caption, relative time; unread = blue dot + bolder title. Types & tints: Gate raised (amber), Job finished ✓ (green), Job failed ✕ (red), Budget threshold (amber gauge), Schedule fired (blue clock), Skill quarantined (indigo shield), Publish posted (teal). Tap deep-links to the right page. Swipe to clear. "Mark all read" quiet header button.

## Part 2 — System push designs (mock these as lock-screen/banner comps)
- **Gate:** Title "PsychGate needs approval" · body "Plan ready: migrate auth to NestJS guards · ≈ $0.60" · actions **Approve** / **View**. (Approve from lock screen allowed only for non-destructive types; destructive opens the app to Face ID confirm.)
- **Completion:** "Build finished ✓ · $1.12 · 14 min" · body = one-line result · action **View transcript**.
- **Failure:** "Job failed — render timeout" · action **Retry**.
- **Budget:** "PsychGate at 90% of cap" · action **Raise cap**.
- Payloads are thin: title + one line + deep link, never artifacts (4KB cap).
Show grouped/stacked notification appearance (thread per project) and a Live Activity concept for a long-running job: compact Dynamic-Island-style pill with breathing dot + mono cost, expanded view with progress bar and Cancel.

## States
Notification permission off: pinned card in the in-app list explaining what's missed + enable button.

## Micro-interactions
Unread dots fade as rows scroll past 50% viewport. Clearing swipes use native physics.
