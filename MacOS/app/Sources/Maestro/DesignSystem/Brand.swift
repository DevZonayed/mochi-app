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
