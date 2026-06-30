import SwiftUI

/// The one connection-status surface, bound to `supervisor.engineState`. Because RPCs now await
/// readiness, the user never sees a dead "Not connected" — at worst this:
///   - while the app is up and the engine blips (`.recovering`) or is still confirming, a small
///     self-clearing "Reconnecting…/Connecting…" pill pinned bottom-center;
///   - when the engine is terminally `.down`, a centered card with the real reason + Retry.
///
/// During the very first boot the LaunchScreen owns the "starting" visual, so the pill stays
/// hidden until the app content is visible (`appVisible`).
struct EngineGate: View {
    @Environment(AppEnv.self) private var env
    /// True once the main app content is shown (so we don't double up with the LaunchScreen).
    let appVisible: Bool

    var body: some View {
        switch env.supervisor.engineState {
        case .ready:
            EmptyView()
        case .down(let reason):
            downOverlay(reason)
        case .starting, .connecting, .recovering:
            if appVisible {
                VStack {
                    Spacer()
                    pill(env.supervisor.engineState.label)
                        .padding(.bottom, 18)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .allowsHitTesting(false)
                .transition(.opacity)
            }
        }
    }

    private func pill(_ text: String) -> some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(text).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Tok.bgElevated, in: Capsule())
        .overlay(Capsule().stroke(Tok.separator, lineWidth: 1))
        .shadow(color: .black.opacity(0.12), radius: 10, y: 2)
    }

    private func downOverlay(_ reason: String) -> some View {
        ZStack {
            Tok.backdrop.ignoresSafeArea()
            VStack(spacing: 14) {
                Icon(name: "x", size: 22)
                    .foregroundStyle(Tok.red)
                    .frame(width: 52, height: 52)
                    .background(Tok.red.opacity(0.12))
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                Text("Engine unavailable")
                    .font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
                if !reason.isEmpty {
                    Text(reason)
                        .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
                        .multilineTextAlignment(.center)
                        .lineLimit(8)
                        .frame(maxWidth: 440)
                }
                PillButton(title: "Retry") { env.supervisor.retry() }
                    .padding(.top, 4)
            }
            .padding(28)
            .background(Tok.bgElevated, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .shadow(color: .black.opacity(0.22), radius: 28, y: 8)
            .frame(maxWidth: 520)
            .padding(40)
        }
        .transition(.opacity)
    }
}
