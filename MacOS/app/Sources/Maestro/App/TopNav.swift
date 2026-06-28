import SwiftUI

/// The slim 46px frosted genre top-nav: MaestroMark · expanding icon-pill nav · spacer ·
/// theme toggle · search · Settings gear. Mirrors the web `CodingTopNav`.
struct TopNav: View {
    @Environment(AppEnv.self) private var env
    @Environment(\.colorScheme) private var scheme
    @State private var feedbackOpen = false

    var body: some View {
        @Bindable var env = env
        HStack(spacing: 8) {
            HStack(spacing: 3) {
                ForEach(Route.navBar) { r in
                    NavPill(route: r, active: env.route == r) { env.route = r }
                }
            }

            Spacer(minLength: 0)

            tbIcon("search") {}
            tbIcon("feedback") { feedbackOpen = true }
            tbIcon(scheme == .dark ? "sun" : "moon") { withAnimation(.smooth(duration: 0.35)) { env.theme.toggle(current: scheme) } }
            tbIcon("settings", active: env.route == .settings) { env.route = .settings }
        }
        .padding(.leading, 76) // clear the traffic lights
        .padding(.trailing, 10)
        .frame(height: 40)
        .background(.ultraThinMaterial)
        .overlay(alignment: .bottom) {
            Tok.separator.frame(height: Tok.hairline)
        }
        .sheet(isPresented: $feedbackOpen) {
            FeedbackModal(screen: String(describing: env.route), onClose: { feedbackOpen = false }).environment(env)
        }
    }

    private func tbIcon(_ name: String, active: Bool = false, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name: name, size: 15)
                .foregroundStyle(active ? Tok.ink : Tok.inkSecondary)
                .frame(width: 28, height: 28)
                .hoverFill(Tok.fillSecondary, radius: 7)
                .contentShape(Rectangle())
        }
        .pressable()
    }
}

/// A genre nav item: a 34×34 icon when inactive that expands to a blue label-pill when active.
struct NavPill: View {
    let route: Route
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: active ? 6 : 0) {
                Icon(name: route.icon, size: 15, weight: active ? .semibold : .medium)
                if active {
                    Text(route.label)
                        .font(TokFont.text(TokFont.footnote, .semibold))
                        .fixedSize()
                }
            }
            .foregroundStyle(active ? Color.white : Tok.inkSecondary)
            .padding(.horizontal, active ? 10 : 0)
            .frame(width: active ? nil : 28, height: 28)
            .background(active ? Tok.blue : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: active ? Tok.Radius.pill : 7, style: .continuous))
            .hoverFill(active ? .clear : Tok.fillSecondary, radius: 7)
        }
        .pressable()
        .animation(.spring(response: 0.32, dampingFraction: 0.82), value: active)
    }
}
