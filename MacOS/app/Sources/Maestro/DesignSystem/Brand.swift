import SwiftUI

/// The Maestro app mark: a gradient squircle with a 4-node "fleet" graph radiating from a
/// central operator core. Ported from the web `MaestroMark` SVG (96×96 viewBox), scalable.
struct MaestroMark: View {
    var size: CGFloat = 22

    var body: some View {
        let s = size / 96 // scale factor from the 96-unit viewBox
        ZStack {
            RoundedRectangle(cornerRadius: 26 * s, style: .continuous)
                .fill(
                    LinearGradient(
                        stops: [
                            .init(color: Color(nsColor: NSColor(hex: "#5E8BFF")), location: 0),
                            .init(color: Color(nsColor: NSColor(hex: "#7C5CFF")), location: 0.52),
                            .init(color: Color(nsColor: NSColor(hex: "#A24BE0")), location: 1),
                        ],
                        startPoint: .init(x: 14.0 / 96, y: 10.0 / 96),
                        endPoint: .init(x: 82.0 / 96, y: 86.0 / 96)
                    )
                )
                .overlay(
                    RadialGradient(
                        colors: [Color.white.opacity(0.55), .clear],
                        center: .init(x: 0.32, y: 0.18), startRadius: 0, endRadius: size * 0.55
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 26 * s, style: .continuous))
                )

            // Fleet links + nodes
            Canvas { ctx, _ in
                let center = CGPoint(x: 48 * s, y: 48 * s)
                let nodes = [CGPoint(x: 26 * s, y: 30 * s), CGPoint(x: 72 * s, y: 28 * s),
                             CGPoint(x: 24 * s, y: 66 * s), CGPoint(x: 70 * s, y: 68 * s)]
                for n in nodes {
                    var p = Path(); p.move(to: center); p.addLine(to: n)
                    ctx.stroke(p, with: .color(.white.opacity(0.85)), lineWidth: 2.4 * s)
                }
                for n in nodes {
                    let r = 5.2 * s
                    ctx.fill(Path(ellipseIn: CGRect(x: n.x - r, y: n.y - r, width: r * 2, height: r * 2)),
                             with: .color(.white.opacity(0.92)))
                }
                let cr = 9.5 * s
                ctx.fill(Path(ellipseIn: CGRect(x: center.x - cr, y: center.y - cr, width: cr * 2, height: cr * 2)),
                         with: .color(.white))
            }
            .frame(width: size, height: size)
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Provider glyphs (ported 1:1 from lib/icons.tsx AnthropicGlyph/OpenAIGlyph)

/// The Anthropic wordmark "A" (monochrome, inherits the given color). viewBox 40×40.
struct AnthropicGlyph: View {
    var size: CGFloat = 16
    var color: Color = Tok.ink
    private static let d = "M24.4 8h-5.1l8.9 24h5.3L24.4 8Zm-12.2 0L3 32h5.4l1.86-5.1h9.0L18.4 32h5.4L14.6 8h-2.4Zm-.2 14.4 2.96-8.1 2.96 8.1h-5.92Z"
    var body: some View {
        SVGShape(pathData: Self.d, viewBox: CGSize(width: 40, height: 40))
            .fill(color, style: FillStyle(eoFill: true))
            .frame(width: size, height: size)
    }
}

/// The OpenAI knot (monochrome, inherits the given color). viewBox 40×40.
struct OpenAIGlyph: View {
    var size: CGFloat = 16
    var color: Color = Tok.ink
    private static let d = "M34.3 17.2a8.6 8.6 0 0 0-.74-7.06 8.7 8.7 0 0 0-9.37-4.17A8.6 8.6 0 0 0 17.7 3.2a8.7 8.7 0 0 0-8.29 6.02 8.6 8.6 0 0 0-5.74 4.17 8.7 8.7 0 0 0 1.07 10.2 8.6 8.6 0 0 0 .74 7.06 8.7 8.7 0 0 0 9.37 4.17 8.6 8.6 0 0 0 6.49 2.79 8.7 8.7 0 0 0 8.29-6.03 8.6 8.6 0 0 0 5.74-4.17 8.7 8.7 0 0 0-1.06-10.2Zm-12.9 18a6.45 6.45 0 0 1-4.14-1.5l.2-.12 6.88-3.97a1.12 1.12 0 0 0 .57-.98v-9.7l2.91 1.68a.1.1 0 0 1 .06.08v8.03a6.48 6.48 0 0 1-6.48 6.47Zm-13.9-5.94a6.44 6.44 0 0 1-.77-4.34l.2.12 6.89 3.98a1.12 1.12 0 0 0 1.13 0l8.41-4.86v3.36a.1.1 0 0 1-.04.09l-6.96 4.02a6.48 6.48 0 0 1-8.85-2.37ZM5.7 14.55a6.45 6.45 0 0 1 3.37-2.84v8.18a1.12 1.12 0 0 0 .56.97l8.4 4.85-2.9 1.68a.1.1 0 0 1-.1 0l-6.96-4.02a6.48 6.48 0 0 1-2.37-8.82Zm23.92 5.56-8.41-4.86 2.9-1.67a.1.1 0 0 1 .1 0l6.96 4.01a6.47 6.47 0 0 1-1 11.67v-8.18a1.12 1.12 0 0 0-.55-.97Zm2.9-4.36-.2-.12-6.88-3.98a1.12 1.12 0 0 0-1.13 0l-8.41 4.86v-3.36a.1.1 0 0 1 .04-.09l6.96-4.01a6.47 6.47 0 0 1 9.62 6.7Zm-18.2 6 -2.91-1.68a.1.1 0 0 1-.06-.08v-8.03a6.47 6.47 0 0 1 10.62-4.97l-.2.11-6.88 3.97a1.12 1.12 0 0 0-.57.98l-.01 9.69Zm1.58-3.4 3.75-2.16 3.75 2.16v4.33l-3.75 2.16-3.75-2.16v-4.33Z"
    var body: some View {
        SVGShape(pathData: Self.d, viewBox: CGSize(width: 40, height: 40))
            .fill(color, style: FillStyle(eoFill: true))
            .frame(width: size, height: size)
    }
}

/// Picks the brand glyph for an engine. `provider == "openai"` (Codex) → OpenAI; else Anthropic.
struct ProviderGlyph: View {
    let provider: String
    var size: CGFloat = 16
    var color: Color = Tok.ink
    var body: some View {
        if provider == "openai" { OpenAIGlyph(size: size, color: color) }
        else { AnthropicGlyph(size: size, color: color) }
    }
}
