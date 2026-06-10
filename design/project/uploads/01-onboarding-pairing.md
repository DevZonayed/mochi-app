# Mobile · Page 01 — Onboarding & QR Pairing

> Use together with `00-DESIGN-SYSTEM.md`. iPhone-first (390×844 safe-area aware), React Native/Expo, pure iOS feel.

## Purpose
First launch of the Maestro phone app: explain the thin-client model in one breath, pair with the desktop via QR, land in Home. Three screens, zero friction.

## Screens
### 1. Welcome
Full-bleed soft gradient (deep blue → black). Maestro mark centered, Large Title "Your fleet, in your pocket.", subtitle "Approve, watch, and steer the agents running on your Mac." Single blue pill "Pair with your Mac" pinned above safe area. Quiet footnote link "What gets synced?" opening an info sheet (bullet rows: live runs ✓, approvals ✓, your keys ✗ never leave the Mac).

### 2. Scanner
Native camera view with an iOS-style scan reticle: rounded-square viewfinder with animated corner brackets and a soft scanning shimmer. Caption above: "Scan the code on your Mac (Settings ▸ Devices)". Manual-entry fallback: "Enter code instead" opens a bottom sheet with a spaced mono code field (`H4KQ-92`) and number-row-friendly keyboard.

### 3. Confirm & handshake
After scan: bottom sheet rises — Mac device card (Mac name, workspace name), shield row "End-to-end encrypted · relay sees only ciphertext", and a prominent "Confirm pairing" pill. Then a brief handshake state: two device glyphs with an animated encrypted-link line connecting them, followed by the draw-on green check and an automatic push-permission prompt framed first by a pre-prompt card ("Gates and finished jobs arrive as notifications — enable to approve from anywhere").

## States
Camera permission denied: instructive card with Settings deep-link. Expired code: red footnote + "Ask your Mac for a fresh code". Offline: amber banner.

## Micro-interactions
Reticle brackets pulse subtly. Successful scan triggers a haptic + bracket snap-to-QR animation. Sheet transitions use iOS detents (medium → large).
