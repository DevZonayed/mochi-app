# Maestro — Shared iOS Design System (read this before every page prompt)

> Prepend or attach this file to every page prompt in `/desktop` and `/mobile`. It is the single source of truth for the visual language. Every page must look like it shipped from the same Apple-grade design team.

## Product context
Maestro is a single-operator "operating system for AI work": one desktop app (Electron) + one mobile thin-client (React Native/Expo) from which one person commands a fleet of AI coding and creative agents — projects, schedulers, skills, media studio, publishing, budgets, and chat-based remote control. The user is a single power-user (developer + designer + content creator + operator). The UI must feel calm, premium, and trustworthy — money and irreversible actions flow through it.

## Design language: "Apple-native, glass and ink"
- **Typography:** SF Pro Display for titles, SF Pro Text for body (fallback: `-apple-system, "SF Pro", Inter, sans-serif`). SF Mono / JetBrains Mono for code, transcripts, model IDs, costs. Large Title 34/41 bold, Title-1 28, Title-2 22, Headline 17 semibold, Body 17/15, Footnote 13, Caption 11. Tight, confident hierarchy — never more than 3 sizes per view.
- **Color (light mode default, full dark mode required):**
  - Background: `#F2F2F7` (system grouped), elevated cards `#FFFFFF`
  - Dark: background `#000000`, elevated `#1C1C1E`, secondary `#2C2C2E`
  - Accent: iOS system blue `#007AFF` (primary actions, links, active states)
  - Semantic: success `#34C759`, danger `#FF3B30`, warning `#FF9500`, purple `#AF52DE` (AI/agent activity), teal `#30B0C7` (media/studio), indigo `#5856D6` (skills)
  - Text: primary `#000`/`#FFF`, secondary `rgba(60,60,67,0.6)`, tertiary `rgba(60,60,67,0.3)`
- **Surfaces & depth:** frosted glass everywhere it earns it — sidebars, toolbars, sheets use `backdrop-filter: blur(24px) saturate(180%)` over translucent white/black. Cards: 16–20px radius, hairline border `0.5px rgba(60,60,67,0.29)`, soft shadow `0 1px 3px rgba(0,0,0,0.06)`. No hard borders, no heavy drop shadows.
- **Controls:** iOS segmented controls (pill track, sliding thumb), iOS switches (51×31), pill buttons, grouped inset lists (the Settings-app look: white rounded groups on grey), bottom sheets on mobile / centered translucent modals on desktop, SF Symbols-style line icons (1.5px stroke, use Lucide as stand-in).
- **Motion:** spring easing (`cubic-bezier(0.32, 0.72, 0, 1)`), 250–350ms. Sheets slide up with rubber-band overshoot. List items fade+rise 8px on load (staggered 30ms). Live/streaming elements get a soft breathing pulse, never blinking. Respect `prefers-reduced-motion`.
- **Spacing:** strict 8pt grid. Generous: 20–24px card padding, 16px gutters mobile, 24–32px desktop.
- **States (every page must design all of these):** loading (skeleton shimmer matching final layout), empty (icon + one-line invitation to act + primary button), error (plain explanation + retry), live/streaming (purple pulse + animated token text), and offline (mobile only — amber banner).
- **Signature element of the whole product:** the **Effort Dial** — a 4-stop segmented control `FAST · BALANCED · DEEP · MAX` that, at DEEP/MAX, reveals an inline amber cost-multiplier chip ("≈ 5× cost · 12× latency"). It appears wherever an agent run can be configured and must look identical everywhere.

## Writing rules
Sentence case everywhere. Buttons say exactly what happens: "Approve plan", "Run now", "Publish 3 drafts". Costs always shown as `$0.42` in mono. Never apologize in errors; say what happened and the fix. Agent activity described in plain verbs: "Building", "Reviewing", "Waiting for your approval".

## Platform chrome
- **Desktop:** macOS-style window — traffic-light inset top-left, full-height translucent sidebar (260px) with grouped nav, frosted toolbar, ⌘K command palette available globally, resizable panes with hairline dividers.
- **Mobile:** iOS navigation — large title that collapses on scroll, tab bar (5 tabs max) with frosted blur, swipe-back gesture, pull-to-refresh with iOS spinner, haptic-feel feedback on approve/reject, safe-area aware.
