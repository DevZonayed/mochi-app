import SwiftUI

/// The two-blob radial wallpaper painted behind every screen (`.app-wallpaper`).
struct Wallpaper: View {
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            ZStack {
                Tok.bg
                RadialGradient(
                    colors: [Tok.blobA.opacity(0.28), .clear],
                    center: .init(x: 0.16, y: 0.0),
                    startRadius: 0, endRadius: max(w, h) * 0.6
                )
                RadialGradient(
                    colors: [Tok.blobB.opacity(0.24), .clear],
                    center: .init(x: 1.0, y: 1.0),
                    startRadius: 0, endRadius: max(w, h) * 0.6
                )
            }
            .ignoresSafeArea()
        }
        .allowsHitTesting(false)
    }
}
