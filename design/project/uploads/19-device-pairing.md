# Desktop · Page 19 — Pair a Phone (Remote Control)

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Pair the mobile thin-client over the E2EE relay using a QR + short-lived token. The screen must radiate "secure but effortless" — AirPods-pairing energy.

## Layout
Centered glass card (480px):
- Title "Pair your iPhone", subtitle "Approve gates, watch runs, and get results anywhere."
- Large QR tile (white, 24px radius, generous quiet zone) with a thin circular **countdown ring** around it (2:00, blue depleting to amber in the last 20s). Beneath: token short-code in spaced mono (`H4KQ-92`) as a manual fallback, copy on click.
- Steps row (3 mini steps with glyphs): "Open Maestro on your phone → Tap Pair → Scan".
- Security footnote with shield glyph: "End-to-end encrypted. The relay only ever sees ciphertext. No ports opened on this Mac."

## Live states (the card morphs through these)
1. **Waiting** — QR + ring.
2. **Phone detected** — QR cross-fades to a phone glyph with radiating soft rings, "Confirming on your iPhone…"
3. **Paired** — green check pop, device card appears (iPhone name, E2EE chip, "Send a test notification" quiet button), then auto-navigates to Settings ▸ Devices.
4. **Expired** — ring empties, QR blurs, "Code expired" + blue "Generate new code" pill.
5. **Error** — "Couldn't verify the device. Generate a new code and try again."

## Micro-interactions
QR regenerates with a card flip. The detection rings animate outward at 2s intervals. The success check uses the iOS-style draw-on checkmark.
