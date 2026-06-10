# Mobile · Page 06 — Diff Review

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Reviewing a code diff on a phone is hard; make it the best-in-class mobile diff: readable, swipeable, honest about scale.

## Layout
- **Header:** file position indicator "3 of 12 files", file path (middle-truncated mono), language chip.
- **Summary first:** the page opens on a **summary card**, not raw code — change overview written by the reviewer in 2–3 plain sentences, stats row (+204 −67), reviewer verdict pill ("0 issues" green / "2 issues" amber), and findings list rows (severity dot + terse text, tap to jump).
- **Diff body:** unified view only (no side-by-side on phone): SF Mono 12, additions tinted `#E8F8EE`, deletions `#FDEBEC`, hairline gutters, collapsed unchanged regions as tappable "··· 41 unchanged lines" pills. Horizontal scroll per code block with a subtle edge fade; pinch to zoom text size between 11–14.
- **File navigation:** swipe left/right between files with a spring page transition; a bottom file-dots indicator (or "3/12" chip). A files-list bottom sheet via the header tap.
- **Pinned action bar (frosted):** **Approve & merge** (blue), **Request fixes** (sends findings back), **Reject** — identical semantics to desktop Page 09.

## States
Huge diff: an upfront honesty card "This diff is 3,400 lines — consider reviewing on your Mac" with "Review anyway" and "Send to Mac" (raises it in the desktop Approvals). Loading: skeleton code lines.

## Micro-interactions
Jump-to-finding scrolls with a brief amber line highlight. Approve uses the Face ID confirm moment. File swipes have haptic detents.
