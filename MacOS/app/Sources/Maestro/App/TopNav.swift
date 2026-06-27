import SwiftUI

/// The slim 46px frosted genre top-nav: MaestroMark · expanding icon-pill nav · spacer ·
/// theme toggle · search · Settings gear. Mirrors the web `CodingTopNav`.
struct TopNav: View {
    @Environment(AppEnv.self) private var env
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        @Bindable var env = env
        HStack(spacing: 8) {
            MaestroMark(size: 22)
                .padding(.trailing, 2)

            HStack(spacing: 3) {
                ForEach(Route.navBar) { r in
                    NavPill(route: r, active: env.route == r) { env.route = r }
                }
            }

            Spacer(minLength: 0)

            tbIcon(scheme == .dark ? "sun" : "moon") { env.theme.toggle(current: scheme) }
            tbIcon("search") {}
            tbIcon("settings", active: env.route == .settings) { env.route = .settings }
        }
        .padding(.leading, 80) // clear the traffic lights
        .padding(.trailing, 14)
        .frame(height: 46)
        .background(.ultraThinMaterial)
        .overlay(alignment: .bottom) {
            Tok.separator.frame(height: Tok.hairline)
        }
    }

    private func tbIcon(_ name: String, active: Bool = false, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name: name, size: 18)
                .foregroundStyle(active ? Tok.ink : Tok.inkSecondary)
                .frame(width: 34, height: 34)
                .background(Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: Tok.Radius.icon, style: .continuous))
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
    }
}

/// A genre nav item: a 34×34 icon when inactive that expands to a blue label-pill when active.
struct NavPill: View {
    let route: Route
    let active: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: active ? 7 : 0) {
                Icon(name: route.icon, size: 18, weight: active ? .semibold : .medium)
                if active {
                    Text(route.label)
                        .font(TokFont.text(TokFont.subhead, .semibold))
                        .fixedSize()
                }
            }
            .foregroundStyle(active ? Color.white : Tok.inkSecondary)
            .padding(.horizontal, active ? 12 : 0)
            .frame(width: active ? nil : 34, height: active ? 32 : 34)
            .background(active ? Tok.blue : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: active ? Tok.Radius.pill : Tok.Radius.icon, style: .continuous))
        }
        .buttonStyle(.plain)
        .contentShape(Rectangle())
        .animation(.spring(response: 0.32, dampingFraction: 0.82), value: active)
    }
}
