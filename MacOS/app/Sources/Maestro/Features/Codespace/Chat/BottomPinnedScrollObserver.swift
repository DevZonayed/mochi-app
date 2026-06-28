import SwiftUI
import AppKit

/// Keeps the enclosing transcript `NSScrollView` pinned to the bottom only while the user is already
/// near the bottom. This avoids SwiftUI's continuous `.defaultScrollAnchor(.bottom)` re-anchoring,
/// which can make AppKit stretch/rebound the scrollbar when streaming content changes height.
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
        private var programmaticScroll = false
        var enabled = true

        deinit { observations.forEach(NotificationCenter.default.removeObserver) }

        func attach(from view: NSView, resetKey: String, enabled: Bool) {
            self.enabled = enabled
            guard let scroll = view.enclosingScrollView else { return }
            if scrollView !== scroll {
                observations.forEach(NotificationCenter.default.removeObserver)
                observations = []
                scrollView = scroll
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
                ) { [weak self] _ in self?.viewportDidResize() })
                if let doc = scroll.documentView {
                    observations.append(NotificationCenter.default.addObserver(
                        forName: NSView.frameDidChangeNotification,
                        object: doc,
                        queue: .main
                    ) { [weak self] _ in self?.documentDidResize() })
                }
            }

            if lastResetKey != resetKey {
                lastResetKey = resetKey
                pinnedToBottom = true
                scrollToBottomAsync()
            }
        }

        private func viewportDidMove() {
            guard !programmaticScroll else { return }
            pinnedToBottom = isNearBottom()
        }

        private func viewportDidResize() {
            if enabled && pinnedToBottom { scrollToBottomAsync() }
            else { pinnedToBottom = isNearBottom() }
        }

        private func documentDidResize() {
            if enabled && pinnedToBottom { scrollToBottomAsync() }
            else { pinnedToBottom = isNearBottom() }
        }

        private func isNearBottom(threshold: CGFloat = 36) -> Bool {
            guard let scrollView, let doc = scrollView.documentView else { return true }
            let visible = doc.visibleRect
            if doc.isFlipped {
                return doc.bounds.maxY - visible.maxY <= threshold
            } else {
                return visible.minY - doc.bounds.minY <= threshold
            }
        }

        private func scrollToBottomAsync() {
            guard enabled else { return }
            DispatchQueue.main.async { [weak self] in self?.scrollToBottom() }
        }

        private func scrollToBottom() {
            guard enabled, let scrollView, let doc = scrollView.documentView else { return }
            let clip = scrollView.contentView
            let maxY = max(doc.bounds.minY, doc.bounds.maxY - clip.bounds.height)
            let targetY = doc.isFlipped ? maxY : doc.bounds.minY
            programmaticScroll = true
            clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: targetY))
            scrollView.reflectScrolledClipView(clip)
            programmaticScroll = false
            pinnedToBottom = true
        }
    }
}
