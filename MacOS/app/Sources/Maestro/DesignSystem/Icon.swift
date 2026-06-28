import SwiftUI

/// Line-icon set. The web app uses a ~80-name Lucide-style catalog (24×24, stroke 1.75).
/// For parity on macOS we map each name to the closest SF Symbol (native, crisp, theme-aware);
/// brand glyphs that have no SF equivalent (MaestroMark, WhatsApp, provider marks) are drawn
/// as custom paths in `Brand.swift`. Names that need a pixel-exact custom path can be promoted
/// from the SF mapping later without changing call sites.
struct Icon: View {
    let name: String
    var size: CGFloat = 18
    var weight: Font.Weight = .medium

    private static let sfMap: [String: String] = [
        "terminal": "terminal", "brush": "paintbrush", "layers": "square.stack.3d.up",
        "jobs": "list.bullet", "shield": "checkmark.shield", "calendar": "calendar",
        "spark": "sparkles", "telescope": "binoculars", "clapper": "film",
        "send": "paperplane.fill", "chat": "bubble.left.and.bubble.right",
        "whatsapp": "message.fill", "gauge": "gauge", "settings": "gearshape",
        "feedback": "exclamationmark.bubble", "sidebar": "sidebar.left", "search": "magnifyingglass",
        "bell": "bell", "sun": "sun.max", "moon": "moon", "chevronDown": "chevron.down",
        "chevronRight": "chevron.right", "plus": "plus", "check": "checkmark", "x": "xmark",
        "refresh": "arrow.clockwise", "play": "play.fill", "square": "stop.fill",
        "folder": "folder", "gitMerge": "arrow.triangle.merge", "more": "ellipsis",
        "trash": "trash", "eye": "eye", "eyeOff": "eye.slash", "clock": "clock",
        "key": "key", "cpu": "cpu", "globe": "globe", "smartphone": "iphone",
        "bolt": "bolt", "alert": "exclamationmark.triangle", "pencil": "pencil",
        "archive": "archivebox", "enter": "arrow.turn.down.left", "target": "scope",
        "maximize": "arrow.up.left.and.arrow.down.right", "minimize": "arrow.down.right.and.arrow.up.left",
        "bookmark": "bookmark", "paperclip": "paperclip", "sliders": "slider.horizontal.3",
        "command": "command",
        // Tool/transcript + file-surface glyphs (parity with lib/icons.tsx)
        "file": "doc", "image": "photo", "checkCircle": "checkmark.circle",
        "xCircle": "xmark.circle", "gitBranch": "arrow.triangle.branch",
        "copy": "doc.on.doc", "pause": "pause.fill",
        "arrowLeft": "arrow.left", "arrowRight": "arrow.right", "dollar": "dollarsign",
    ]

    var body: some View {
        Image(systemName: Self.sfMap[name] ?? "questionmark")
            .font(.system(size: size, weight: weight))
            .imageScale(.medium)
    }
}
