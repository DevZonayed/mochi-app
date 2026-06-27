import SwiftUI
import AppKit

/// Re-centers the macOS traffic-light buttons vertically within the nav-bar height, and keeps them
/// there across resizes — so they line up with the destination pills instead of hugging the top.
struct WindowConfigurator: NSViewRepresentable {
    var barHeight: CGFloat

    func makeNSView(context: Context) -> NSView {
        let v = NSView(frame: .zero)
        DispatchQueue.main.async { context.coordinator.attach(to: v.window, barHeight: barHeight) }
        return v
    }
    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { context.coordinator.attach(to: nsView.window, barHeight: barHeight) }
    }
    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        private weak var window: NSWindow?
        private var obs: [NSObjectProtocol] = []
        private var barHeight: CGFloat = 40

        func attach(to w: NSWindow?, barHeight: CGFloat) {
            self.barHeight = barHeight
            guard let w else { return }
            if window !== w {
                window = w
                for name in [NSWindow.didResizeNotification, NSWindow.didBecomeKeyNotification, NSWindow.didEnterFullScreenNotification, NSWindow.didExitFullScreenNotification] {
                    obs.append(NotificationCenter.default.addObserver(forName: name, object: w, queue: .main) { [weak self] _ in self?.reposition() })
                }
            }
            reposition()
            // AppKit can reset the buttons on first layout — re-apply once shortly after.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in self?.reposition() }
        }

        private func reposition() {
            guard let w = window else { return }
            let btns = [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton].compactMap { w.standardWindowButton($0) }
            guard let first = btns.first, let frame = first.superview else { return }
            let h = first.frame.height
            // The buttons live in the theme frame (origin bottom-left). Center them in the top
            // `barHeight` strip of the window.
            let y = frame.bounds.height - barHeight + (barHeight - h) / 2
            for b in btns { b.setFrameOrigin(NSPoint(x: b.frame.origin.x, y: y)) }
        }
    }
}
