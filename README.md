# Maestro

A single-operator **operating system for AI work** — one desktop app (Electron) and one mobile thin-client (React Native), from which one person commands a fleet of AI coding & creative agents: projects, schedulers, skills, a media studio, publishing, budgets, and chat-based remote control.

> Product spec lives in [`docs/agentos/PRD.md`](docs/agentos/PRD.md) (18-section PRD) and [`docs/agentos/ADR.md`](docs/agentos/ADR.md) (binding architecture decisions). The UI was designed in Claude Design and exported to [`design/`](design/) — these are the pixel-perfect reference for the apps.

## Monorepo layout

```
maestro/  (pnpm + Turborepo)
├── apps/
│   ├── desktop/        Electron + Vite + React + TS   → the 20 desktop screens   [scaffolding]
│   └── mobile/         Expo + React Native + TS        → the 12 mobile screens    [foundation running]
├── packages/
│   ├── design-tokens/  iOS "glass & ink" design system — tokens.css (web) + theme.ts (RN)
│   ├── core/           Maestro Core — UI-agnostic Node service (engine, jobs) per the ADR
│   └── rpc-contract/   typed RPC contract shared by Core ↔ clients
├── design/             raw Claude Design handoff (HTML/JSX prototypes — pixel-perfect reference)
└── docs/agentos/       PRD · ADR · ecosystem decomposition · 17-domain research
```

## Design system — one source, two surfaces

`packages/design-tokens` is the shared iOS visual language (SF Pro / JetBrains Mono, full light + dark, system colors, the signature **Effort Dial**):

- **Web / desktop** consume `@maestro/design-tokens/tokens.css` (CSS custom properties).
- **React Native / mobile** consume `@maestro/design-tokens` → `makeTheme('light'|'dark')` (a TS mirror, since RN can't read CSS vars).

Keep `tokens.css` and `theme.ts` in sync — they are the same values in two formats.

## Getting started

```bash
pnpm install                 # install the whole workspace

# Mobile (Expo / React Native)
pnpm --filter @maestro/mobile start       # then press i (iOS sim) / a (Android)
# On a brand-new Node, reconcile RN/Expo versions once:  npx expo install --fix

# Desktop (Electron + Vite)  — scaffolding in progress
pnpm --filter @maestro/desktop dev

# Backend (Maestro Core)
pnpm --filter @maestro/core test
```

## Porting status

The design is **100% complete** (20 desktop + 12 mobile screens). The apps recreate it natively, screen by screen — see [`PORTING.md`](PORTING.md) for the per-screen tracker and the recipe to port the next one.

- ✅ **Mobile foundation** — theme bridge, navigation (5-tab + stack), icon set, UI atoms, and the **Home** screen ported to RN; the other 11 screens render themed placeholders until ported.
- ⏳ **Desktop** — Electron + React shell + launcher next (the desktop prototypes are already React, so they port directly).
