# Mobile · Page 02 — Home

> Use together with `00-DESIGN-SYSTEM.md`. iPhone, tab 1 of 5 (Home · Jobs · Approvals · Studio · Settings), frosted tab bar.

## Purpose
The 5-second glance: what needs me, what's running, what it costs today. Mirrors the desktop Command Center, distilled.

## Layout (scrolling, large title "Maestro" collapsing on scroll)
1. **Needs you (top priority):** if gates pending, a swipeable card stack (one card visible, depth-stacked behind): gate icon, project, one-line summary, age — with two thumb-reach pills **Approve** (blue) and **Review**. Swipe right = approve (green sweep + haptic), swipe left = open review. Counter chip "2 more".
2. **Live now:** vertical list of running jobs as compact cards — project color dot, job name, status verb with breathing purple dot ("Building"), thin progress hairline, mono live cost. Tap → Job Live Timeline.
3. **Today:** a slim glass strip — `Spend $6.40` (mono) · `3 scheduled tonight` · `2 done ✓` as three inline stats.
4. **Recently finished:** rows with ✓/✕, cost, relative time; tap for the read-only transcript.

## Pull-to-refresh
iOS spinner; on refresh the live cards' costs tick to current values.

## States
All-clear: the Needs-you zone collapses into a single serene line "Nothing needs you" with a quiet check. Desktop-offline: full-width amber banner "Your Mac is unreachable — showing last synced state · 4 min ago" (sync still queues intents). Empty workspace: invitation card to create a project from the Mac.

## Micro-interactions
Card-stack swipes have rubber-band physics and haptics on commit. Live cost text uses a rolling-digit animation. Tab bar icons use SF-Symbol-style fill-on-active.
