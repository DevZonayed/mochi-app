# Desktop · Page 16 — Comms Gateway (Telegram & WhatsApp)

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Configure chat lanes: Telegram bot (default), WhatsApp Lane A (own number, opt-in, high ban risk, isolated) and Lane B (Business API). Bind chats to projects, manage the allowlist, watch the send queue.

## Layout
Segmented: `Channels · Chat bindings · Activity`.

### Channels tab
Two large channel cards:
- **Telegram** (blue tint): status pill `Connected`, bot handle mono, "2GB media server ✓" chip, message counter today, Configure button.
- **WhatsApp** (green tint): two lane rows inside —
  - Lane A "Your own number": OFF by default; enabling opens a deliberate risk sheet (amber, iOS-alert styled but full sheet): plain copy "Unofficial connection. Accounts get banned — sometimes within weeks. Runs isolated; a ban can't touch your jobs." with a typed-confirmation toggle and QR pairing step (WhatsApp-style QR card).
  - Lane B "Business API": cost note "$0.004–0.025/message", connect via provider.
  Lane A when on shows a persistent small amber dot + "Isolated process · healthy" status and linked-devices list with an alert style if an unknown device appears.

### Chat bindings tab
Grouped rows: chat avatar + name → arrow → bound project chip; trigger permission switches per binding ("Can start jobs", "Receives reports", "Can approve gates"). Add binding flow: pick chat from a searchable sheet, pick project. A footnote on every binding: "Messages are input, never authority — sensitive actions still gate."

### Activity tab
Unified outbound queue: rows with channel glyph, recipient, payload preview, state (queued / sent ✓ / rate-limited ⏳ with countdown), and the global rate-limit meter on top.

## States
Telegram disconnected: card grey with reconnect. WhatsApp banned: red but composed — "Number banned by WhatsApp. Jobs unaffected. You can retry with another number." Empty bindings invitation.

## Micro-interactions
The risk sheet's confirm switch has deliberate friction (hold-to-confirm fill animation, 1s).
