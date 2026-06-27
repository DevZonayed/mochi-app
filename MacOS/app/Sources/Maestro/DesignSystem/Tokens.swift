import SwiftUI
import AppKit

// MARK: - Color helpers

extension Color {
    /// A dynamic color that resolves to `light` or `dark` based on the effective NSAppearance.
    /// Driven app-wide by `.preferredColorScheme(theme.resolved)` on the root view, so these
    /// adapt automatically when the operator flips the theme toggle.
    static func dyn(_ light: NSColor, _ dark: NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return isDark ? dark : light
        })
    }
}

extension NSColor {
    /// `#RRGGBB` / `#RRGGBBAA` hex.
    convenience init(hex: String) {
        var s = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        if s.count == 6 { s += "FF" }
        var v: UInt64 = 0
        Scanner(string: s).scanHexInt64(&v)
        self.init(
            srgbRed: CGFloat((v >> 24) & 0xFF) / 255,
            green: CGFloat((v >> 16) & 0xFF) / 255,
            blue: CGFloat((v >> 8) & 0xFF) / 255,
            alpha: CGFloat(v & 0xFF) / 255
        )
    }
    /// RGB 0–255 with explicit alpha (matches the CSS `rgba(...)` tokens precisely).
    static func rgba(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat) -> NSColor {
        NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
    }
}

// MARK: - Design tokens (ported 1:1 from packages/design-tokens/src/tokens.css)

/// The single source of truth for the visual language. Every value mirrors the CSS custom
/// properties exactly (light / dark). See docs/superpowers/specs §4.
enum Tok {
    // Accents — identical in light & dark
    static let blue       = Color(nsColor: NSColor(hex: "#007AFF"))
    static let bluePress  = Color(nsColor: NSColor(hex: "#0062CC"))
    static let green      = Color(nsColor: NSColor(hex: "#34C759"))
    static let red        = Color(nsColor: NSColor(hex: "#FF3B30"))
    static let orange     = Color(nsColor: NSColor(hex: "#FF9500"))
    static let purple     = Color(nsColor: NSColor(hex: "#AF52DE"))
    static let teal       = Color(nsColor: NSColor(hex: "#30B0C7"))
    static let indigo     = Color(nsColor: NSColor(hex: "#5856D6"))
    static let anthropic  = Color(nsColor: NSColor(hex: "#D97757"))

    // Surfaces
    static let bg          = Color.dyn(NSColor(hex: "#F2F2F7"), NSColor(hex: "#000000"))
    static let bgElevated  = Color.dyn(NSColor(hex: "#FFFFFF"), NSColor(hex: "#1C1C1E"))
    static let bgGrouped   = Color.dyn(.rgba(255, 255, 255, 0.72), .rgba(44, 44, 46, 0.66))
    static let backdrop    = Color.dyn(NSColor(hex: "#E7E9F3"), NSColor(hex: "#06070D"))

    static let fillSecondary = Color.dyn(.rgba(118, 118, 128, 0.12), .rgba(120, 120, 128, 0.24))
    static let fillTertiary  = Color.dyn(.rgba(118, 118, 128, 0.08), .rgba(120, 120, 128, 0.16))

    // Ink (text)
    static let ink          = Color.dyn(NSColor(hex: "#000000"), NSColor(hex: "#FFFFFF"))
    /// Softened body text for long-form reading — easier on the eye than pure #000/#FFF.
    static let inkBody      = Color.dyn(.rgba(28, 28, 32, 0.92), .rgba(235, 235, 245, 0.90))
    static let inkSecondary = Color.dyn(.rgba(60, 60, 67, 0.60), .rgba(235, 235, 245, 0.60))
    static let inkTertiary  = Color.dyn(.rgba(60, 60, 67, 0.30), .rgba(235, 235, 245, 0.30))

    // Separators (hairlines render at 0.5pt)
    static let separator       = Color.dyn(.rgba(60, 60, 67, 0.18), .rgba(84, 84, 88, 0.55))
    static let separatorStrong = Color.dyn(.rgba(60, 60, 67, 0.29), .rgba(84, 84, 88, 0.65))

    // Wallpaper blobs
    static let blobA = Color.dyn(NSColor(hex: "#6B8CFF"), NSColor(hex: "#2B3F8C"))
    static let blobB = Color.dyn(NSColor(hex: "#9B7BFF"), NSColor(hex: "#5A3F8C"))

    // Radii
    enum Radius {
        static let pill: CGFloat = 980
        static let card: CGFloat = 20
        static let group: CGFloat = 12
        static let icon: CGFloat = 9
        static let menu: CGFloat = 12
    }

    // Hairline
    static let hairline: CGFloat = 0.5
}

// MARK: - Type ramp (iOS scale, px → pt)

enum TokFont {
    static func display(_ size: CGFloat, _ weight: Font.Weight = .bold) -> Font {
        .system(size: size, weight: weight, design: .default)
    }
    static func text(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .default)
    }
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    // Named ramp
    static let largeTitle: CGFloat = 34
    static let title1: CGFloat = 28
    static let title2: CGFloat = 22
    static let headline: CGFloat = 17
    static let body: CGFloat = 17
    static let callout: CGFloat = 16
    static let subhead: CGFloat = 15
    static let footnote: CGFloat = 13
    static let caption: CGFloat = 11
}

// MARK: - Shadows

extension View {
    /// The standard elevated-card shadow (light/dark aware via two layered shadows).
    func cardShadow() -> some View {
        self
            .shadow(color: .dyn(.rgba(0, 0, 0, 0.06), .rgba(0, 0, 0, 0.40)), radius: 1.5, y: 1)
            .shadow(color: .dyn(.rgba(15, 20, 60, 0.10), .rgba(0, 0, 0, 0.55)), radius: 20, y: 12)
    }
}
