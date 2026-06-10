# Mobile · Page 09 — Studio Gallery & Media Preview (Tab 4)

> Use together with `00-DESIGN-SYSTEM.md`.

## Purpose
Review the studio's output on the device it'll be consumed on: drafts, hero renders, and publish queue — full-screen previews, quick approvals, native share.

## Layout
Large title "Studio". Segmented: `Drafts · Rendering · Published`.

### Drafts grid
Photos-app style: 2-column masonry of thumbnails (9:16 dominant), each with a small status chip (Draft / Awaiting approval amber) and duration caption. Tap → full-screen preview.

### Full-screen preview (the core experience)
Edge-to-edge player on black, iOS video controls (scrub bar, AirPlay), swipe down to dismiss. An info sheet rises from a bottom grabber: title, caption (editable inline), platform destination chips, cost line mono ("Cost to make: $7.80"), provenance row (`AI label ✓ · C2PA ✓ · Consent ✓` where avatar used). Pinned actions: **Approve & schedule** (blue pill) / **Request changes** (opens a note field that feeds back to the studio job) / native share icon.
Swipe left/right moves between drafts like Photos.

### Rendering tab
Cards with blurred thumbnail + progress ring + stage label ("B-roll · Kling · ~90s") and live cost; cancellable.

### Published tab
Rows with platform glyph, posted time, and a small metrics line when available ("1.2k views"); tap opens the platform link.

## States
Empty drafts: "Briefs become drafts here. Start one from the Mac's Studio or Trends." Render failed: red card + Retry. Offline: cached thumbnails with amber banner.

## Micro-interactions
Grid-to-fullscreen uses the iOS zoom transition from the tapped thumbnail. Approve fires haptic + a fly-to-calendar mini animation.
