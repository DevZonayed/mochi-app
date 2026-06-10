# Desktop · Page 01 — Onboarding & First-Run Setup

> Use together with `00-DESIGN-SYSTEM.md`. Design a desktop screen (Electron, macOS-first), 1440×900 default, iOS/Apple design language.

## Purpose
First launch of Maestro. The operator creates their single Workspace, connects provider accounts (Anthropic + OpenAI via OAuth), sets a master budget ceiling, and optionally pairs their phone. Must feel like a macOS setup assistant — calm, one decision per step, zero clutter.

## Layout
Full-window experience, no sidebar yet. Centered glass card (560px wide, 20px radius, frosted blur over a soft animated gradient backdrop in muted blue/purple). Step indicator at top: 5 hairline dots that fill with system blue. Bottom-right "Continue" pill button, bottom-left quiet "Back" text button.

## Steps to design (each is a state of the same card)
1. **Welcome** — Maestro mark, Large Title "One operator. A fleet of agents.", one-line subtitle, Continue.
2. **Workspace** — single text field "Workspace name" (grouped-inset style), helper text "Everything lives under one workspace — yours."
3. **Connect providers** — two provider rows (Anthropic, OpenAI) as grouped list items with logo, status pill (`Not connected` grey → `Connected` green with checkmark), and a "Connect" button that triggers a browser OAuth flow; show an inline "Waiting for browser…" spinner state and a success state. Footnote: "Keys are stored in your Mac's Keychain. Agents can use them but never see them."
4. **Budget ceiling** — large mono dollar input `$ 200 / month`, an iOS slider beneath, caption "Hard cap. Jobs stop at the line — never a surprise bill." Small live preview chip showing example: "≈ 40 deep coding runs or 5 video minutes".
5. **Pair your phone (optional)** — QR code in a white rounded tile, caption "Scan with the Maestro app · code expires in 2:00" with a live countdown ring; "Skip for now" text link.

## States
Loading per OAuth row, error row state ("Connection failed — try again" in red footnote with retry), completed step gets a green check in the dot indicator.

## Micro-interactions
Card cross-fades + slides 24px between steps with spring easing. QR countdown ring depletes smoothly. Confetti-free finish: final step is a quiet "You're set" with the dashboard fading in behind the dissolving card.
