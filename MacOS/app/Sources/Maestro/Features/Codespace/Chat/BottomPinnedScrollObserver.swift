import SwiftUI
import AppKit

/// Keeps the enclosing transcript `NSScrollView` pinned to the bottom **only** while the user is
/// already near the bottom — the Claude / ChatGPT / Messenger "bottom-first" behaviour: open at the
/// latest message, follow new output, but never yank the user back down once they scroll up to read.
///
/// It deliberately avoids SwiftUI's `.defaultScrollAnchor(.bottom)`, which continuously re-anchors on
/// every layout pass and made AppKit stretch/rebound the scrollbar. Two things keep this smooth:
///  - bursts of resize notifications (one per streamed token) are **coalesced** into a single scroll
///    per runloop turn, so the transcript glides instead of stepping;
///  - a scroll that's already at the bottom is a **no-op**, so we don't re-arm the scroller's active
///    state every tick (the "vibration").
struct BottomPinnedScrollObserver: NSViewRepresentable {
    var resetKey: String
    var enabled: Bool = true

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        DispatchQueue.main.async { context.coordinator.attach(from: view, resetKey: resetKey, enabled: enabled) }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {
        context.coordinator.enabled = enabled
        DispatchQueue.main.async { context.coordinator.attach(from: view, resetKey: resetKey, enabled: enabled) }
    }

    final class Coordinator {
        weak var scrollView: NSScrollView?
        private var observations: [NSObjectProtocol] = []
        private var lastResetKey = ""
        private var pinnedToBottom = true
        /// True while our own programmatic scroll (and the bounds-change it posts) is settling, so we
        /// don't misread it as the user scrolling away from the bottom.
        private var suppressMoveTracking = false
        /// Set when a scroll-to-bottom is already queued for this runloop turn — coalesces the burst of
        /// resize notifications a stream produces into a single scroll.
        private var scrollScheduled = false
        var enabled = true

        deinit { observations.forEach(NotificationCenter.default.removeObserver) }

        func attach(from view: NSView, resetKey: String, enabled: Bool) {
            self.enabled = enabled
            guard let scroll = view.enclosingScrollView else { return }
            if scrollView !== scroll {
                observations.forEach(NotificationCenter.default.removeObserver)
                observations = []
                scrollView = scroll
                // Thin floating scrollbar that reserves no width (belt-and-suspenders with the app-wide
                // `OverlayScrollers` swizzle) — also stops the legacy-scroller reflow loop on this pane.
                scroll.scrollerStyle = .overlay
                scroll.contentView.postsBoundsChangedNotifications = true
                scroll.contentView.postsFrameChangedNotifications = true
                scroll.documentView?.postsFrameChangedNotifications = true

                observations.append(NotificationCenter.default.addObserver(
                    forName: NSView.boundsDidChangeNotification,
                    object: scroll.contentView,
                    queue: .main
                ) { [weak self] _ in self?.viewportDidMove() })
                observations.append(NotificationCenter.default.addObserver(
                    forName: NSView.frameDidChangeNotification,
                    object: scroll.contentView,
                    queue: .main
                ) { [weak self] _ in self?.contentOrViewportDidResize() })
                if let doc = scroll.documentView {
                    observations.append(NotificationCenter.default.addObserver(
                        forName: NSView.frameDidChangeNotification,
                        object: doc,
                        queue: .main
                    ) { [weak self] _ in self?.contentOrViewportDidResize() })
                }
            } else {
                scroll.scrollerStyle = .overlay
            }

            if lastResetKey != resetKey {
                lastResetKey = resetKey
                pinnedToBottom = true
                scheduleScrollToBottom()
            }
        }

        /// The viewport moved. If it wasn't us, recompute whether the user is still riding the bottom.
        private func viewportDidMove() {
            guard !suppressMoveTracking else { return }
            pinnedToBottom = isNearBottom()
        }

        /// Content grew (a streamed token) or the viewport resized (window resize). Follow the bottom
        /// only while pinned; otherwise just keep `pinnedToBottom` honest.
        private func contentOrViewportDidResize() {
            guard enabled else { return }
            if pinnedToBottom { scheduleScrollToBottom() }
            else if !suppressMoveTracking { pinnedToBottom = isNearBottom() }
        }

        private func isNearBottom(threshold: CGFloat = 48) -> Bool {
            guard let scrollView, let doc = scrollView.documentView else { return true }
            let visible = doc.visibleRect
            if doc.isFlipped {
                return doc.bounds.maxY - visible.maxY <= threshold
            } else {
                return visible.minY - doc.bounds.minY <= threshold
            }
        }

        /// Collapse every resize this runloop turn into one bottom scroll.
        private func scheduleScrollToBottom() {
            guard enabled, !scrollScheduled else { return }
            scrollScheduled = true
            DispatchQueue.main.async { [weak self] in
                self?.scrollScheduled = false
                self?.scrollToBottom()
            }
        }

        private func scrollToBottom() {
            guard enabled, pinnedToBottom, let scrollView, let doc = scrollView.documentView else { return }
            let clip = scrollView.contentView
            let maxY = max(doc.bounds.minY, doc.bounds.maxY - clip.bounds.height)
            let targetY = doc.isFlipped ? maxY : doc.bounds.minY
            // Already at the bottom (within a hair)? Don't re-scroll — re-scrolling re-arms the
            // scroller's active state every tick, which is exactly the shimmer/vibration we're killing.
            if abs(clip.bounds.origin.y - targetY) < 0.5 { return }
            suppressMoveTracking = true
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0
                ctx.allowsImplicitAnimation = false
                clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: targetY))
                scrollView.reflectScrolledClipView(clip)
            }
            pinnedToBottom = true
            // Release move-tracking AFTER this turn so the bounds-change our scroll just posted isn't
            // mistaken for the user scrolling away.
            DispatchQueue.main.async { [weak self] in self?.suppressMoveTracking = false }
        }
    }
}
