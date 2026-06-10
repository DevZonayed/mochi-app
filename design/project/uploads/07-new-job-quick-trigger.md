# Mobile · Page 07 — New Job (Quick Trigger Sheet)

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Fire a job from the phone in three taps: pick a project, state the goal (text or voice), set effort, go. Presented as a bottom sheet from the "+" button anywhere.

## Layout (bottom sheet, medium detent → expands to large)
1. **Project picker row:** horizontally scrolling project squircles (most recent first); selected gets blue ring + name confirms in the sheet title ("New job · PsychGate").
2. **Goal field:** large rounded input, 17pt, placeholder "What should it do?" — with a mic button on the right that flips the field into an iOS voice-waveform state (animated bars, live transcription appearing).
3. **Effort Dial:** the signature 4-stop segmented control; selecting DEEP/MAX reveals the amber multiplier chip ("≈ 5× cost · 12× latency") with a soft expand.
4. **Autonomy row:** segmented `Plan first · Gated · Unattended` (Plan first preselected) with a one-line caption that changes per choice ("You'll approve the plan before anything runs.").
5. **Estimate line:** mono, live — "≈ $0.60 · ~6 min · within budget ✓" (turns amber with "needs $2 over cap — will gate" when relevant).
6. **Send:** full-width blue pill "Start job" (or "Get plan first" when Plan-first) with haptic on fire; the sheet collapses into a small floating progress chip that docks into the Jobs tab badge.

## Schedule option
A small calendar-clock icon next to Send opens scheduling rows: "Run once at…" (iOS date wheel) or "Repeat…" (natural-language field with parsed preview "Weekdays 06:00").

## States
No projects: sheet explains projects are created on the Mac. Offline: "Will start when your Mac reconnects" amber note, job queues to outbox. Voice permission denied: inline fix link.

## Micro-interactions
The sheet uses native detents and rubber-banding. The docking animation (sheet → tab badge) is the delight moment — a small blue dot flies into the tab bar.
