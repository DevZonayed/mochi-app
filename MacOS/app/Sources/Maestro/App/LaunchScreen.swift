import SwiftUI

/// The launch splash shown while the headless sidecar boots and the first project list loads —
/// then it fades into the app. Keeps the window from showing an empty/half-built UI on cold start.
struct LaunchScreen: View {
    @State private var pulse = false
    @State private var appeared = false

    var body: some View {
        ZStack {
            Tok.backdrop.ignoresSafeArea()
            RadialGradient(colors: [Tok.blue.opacity(0.16), .clear], center: .center, startRadius: 0, endRadius: 380)
                .ignoresSafeArea()
            VStack(spacing: 18) {
                MaestroMark(size: 76)
                    .scaleEffect(pulse ? 1.04 : 0.97)
                    .shadow(color: Tok.blue.opacity(0.40), radius: 30, y: 8)
                    .animation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true), value: pulse)
                VStack(spacing: 7) {
                    Text("Maestro").font(TokFont.display(28, .bold)).tracking(-0.4).foregroundStyle(Tok.ink)
                    HStack(spacing: 7) {
                        Spinner(size: 13).tint(Tok.inkTertiary)
                        Text("Starting…").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
                    }
                }
                .opacity(appeared ? 1 : 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .onAppear { pulse = true; withAnimation(.easeOut(duration: 0.4)) { appeared = true } }
    }
}
