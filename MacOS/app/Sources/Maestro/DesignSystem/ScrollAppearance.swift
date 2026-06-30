import AppKit
import ObjectiveC

/// Forces macOS to use thin, floating **overlay** scrollers everywhere in the app — regardless of the
/// user's "Show scroll bars" System Setting.
///
/// The default for many users (especially with a mouse attached, where the setting becomes "Always")
/// is the heavy **legacy** scroller. Legacy scrollers (a) look bold/chunky, not the slim Claude /
/// ChatGPT / Messenger style bar, and (b) reserve layout width. That reserved width is what makes the
/// chat pane "vibrate": as a transcript streams, content reflows against the narrower width → its
/// height changes → the bottom-pin re-scrolls → the scroller's presence toggles → width changes
/// again … a visible feedback loop.
///
/// `NSScrollView` derives its style from the `NSScroller.preferredScrollerStyle` class getter;
/// swizzling that single getter to return `.overlay` flips every scroll view in the process at once —
/// Codespace chat, Settings, Design, Workspace, sheets, pickers — to the thin overlay bar. Idempotent;
/// call once at launch.
enum OverlayScrollers {
    private static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true
        let sel = #selector(getter: NSScroller.preferredScrollerStyle)
        guard let method = class_getClassMethod(NSScroller.self, sel) else { return }
        let overlay: @convention(block) (AnyObject) -> NSScroller.Style = { _ in .overlay }
        method_setImplementation(method, imp_implementationWithBlock(overlay))
        // Nudge any scroll views already created this launch to re-read the (now overlay) style.
        NotificationCenter.default.post(name: NSScroller.preferredScrollerStyleDidChangeNotification, object: nil)
    }
}
