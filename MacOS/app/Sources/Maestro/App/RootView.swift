import SwiftUI

struct RootView: View {
    @Environment(AppEnv.self) private var env
    @State private var minElapsed = false

    /// Ready once the sidecar's first project list has loaded (and a short minimum so the splash
    /// doesn't flash on a warm start).
    private var ready: Bool { (env.workspace.map { !$0.loading } ?? false) && minElapsed }

    var body: some View {
        ZStack {
            Wallpaper()
            VStack(spacing: 0) {
                TopNav()
                ZStack {
                    routeContent
                        .id(env.route)
                        .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 6)), removal: .opacity))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .animation(.smooth(duration: 0.26), value: env.route)
            }
            // Let the nav row rise into the title bar so it sits inline with the traffic lights
            // (no wasted empty strip up top) — the standard macOS unified-toolbar look.
            .ignoresSafeArea(.container, edges: .top)

            if !ready { LaunchScreen().transition(.opacity).zIndex(10) }

            // The one connection-status surface: a self-clearing "Reconnecting…" pill while the
            // app is up, or a real-reason + Retry card when the engine is terminally down. RPCs
            // wait for readiness, so this is the only thing the user ever sees — never a dead error.
            EngineGate(appVisible: ready).zIndex(20)
        }
        .background(Tok.bg)
        .background(WindowConfigurator(barHeight: 40))
        .animation(.easeOut(duration: 0.4), value: ready)
        .animation(.easeOut(duration: 0.3), value: env.supervisor.engineState)
        .task { try? await Task.sleep(for: .milliseconds(650)); minElapsed = true }
    }

    @ViewBuilder private var routeContent: some View {
        switch env.route {
        case .codespace: WorkspaceView()
        case .design: DesignWorkspace()
        case .comms: CommsGateway()
        case .whatsapp: WhatsAppView()
        case .schedule: ScheduleView()
        case .settings: SettingsView()
        }
    }
}

/// Temporary destination for phases not yet built (Design/Comms/WhatsApp/Settings come in P2–P4).
struct Placeholder: View {
    let title: String
    let icon: String
    var body: some View {
        VStack(spacing: 14) {
            Icon(name: icon, size: 32)
                .foregroundStyle(Tok.inkTertiary)
                .frame(width: 64, height: 64)
                .background(Tok.fillSecondary)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            Text(title).font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
            Text("Coming in a later phase of the native migration.")
                .font(TokFont.text(TokFont.body)).foregroundStyle(Tok.inkSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
