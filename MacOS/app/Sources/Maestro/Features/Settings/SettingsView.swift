import SwiftUI

/// The System-Settings-style screen: 232px section nav + a right pane. Scoped to six sections.
struct SettingsView: View {
    @Environment(AppEnv.self) private var env
    @State private var section: Section = .engines

    enum Section: String, CaseIterable, Identifiable {
        case engines = "Engines", skills = "Skills & tools", mcp = "MCP servers"
        case accounts = "Accounts & keys", ext = "Browser extension", devices = "Devices"
        var id: String { rawValue }
        var icon: String {
            switch self { case .engines: "cpu"; case .skills: "spark"; case .mcp: "terminal"
            case .accounts: "key"; case .ext: "globe"; case .devices: "smartphone" }
        }
        var tint: Color {
            switch self { case .engines: Tok.purple; case .skills: Tok.indigo; case .mcp: Tok.teal
            case .accounts: Tok.blue; case .ext: Tok.blue; case .devices: Tok.teal }
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            nav
            ScrollView {
                pane
                    .id(section)
                    .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 8)), removal: .opacity))
                    .frame(maxWidth: section == .skills ? .infinity : 640, alignment: .leading)
                    .padding(.horizontal, 32).padding(.vertical, 28).frame(maxWidth: .infinity, alignment: .leading)
            }
            .animation(.smooth(duration: 0.24), value: section)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var nav: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("Settings").font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
                .padding(.horizontal, 10).padding(.bottom, 14)
            ForEach(Section.allCases) { s in
                Button { withAnimation(.smooth(duration: 0.22)) { section = s } } label: {
                    HStack(spacing: 11) {
                        Icon(name: s.icon, size: 15)
                            .foregroundStyle(section == s ? .white : s.tint)
                            .frame(width: 26, height: 26)
                            .background(section == s ? Color.white.opacity(0.2) : s.tint.opacity(0.14))
                            .clipShape(RoundedRectangle(cornerRadius: 7))
                        Text(s.rawValue).font(TokFont.text(TokFont.subhead, section == s ? .semibold : .medium))
                            .foregroundStyle(section == s ? .white : Tok.ink)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).frame(height: 38)
                    .background(section == s ? Tok.blue : .clear).clipShape(RoundedRectangle(cornerRadius: 8))
                }.buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(20).frame(width: 232)
        .background(Tok.bgGrouped).overlay(alignment: .trailing) { Tok.separator.frame(width: Tok.hairline) }
    }

    @ViewBuilder private var pane: some View {
        switch section {
        case .engines: EnginesPane()
        case .skills: SettingsSkillsPane()
        case .mcp: McpPane()
        case .accounts: AccountsPane()
        case .ext: ExtensionPane()
        case .devices: DevicesPane()
        }
    }
}

/// Pane title + optional subtitle.
struct PaneHead: View {
    let title: String
    var sub: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(TokFont.display(TokFont.title1, .bold)).foregroundStyle(Tok.ink)
            if let sub { Text(sub).font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary) }
        }.padding(.bottom, 18)
    }
}

// MARK: - Engines
struct EnginesPane: View {
    @Environment(AppEnv.self) private var env
    @State private var statuses: [String: EngineStatus] = [:]
    @State private var routing: [String: String] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            PaneHead(title: "Engines", sub: "Which agents run, and what reviews them.")
            GroupedList(header: "Engine status") {
                engineRow("Claude Code", statuses["claude"], last: false)
                engineRow("Codex", statuses["codex"], last: true)
            }
            GroupedList(header: "Media generation", footer: "Which engine renders generated images.") {
                GLRow(last: true) {
                    Text("Image").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                    Spacer()
                    SegmentedControl(options: [("claude", "Claude", nil), ("codex", "Codex", nil)],
                                     value: Binding(get: { routing["image"] ?? "codex" }, set: { setRouting("image", $0) }))
                }
            }
        }
        .task {
            statuses = (try? await env.client.call("engineStatus", as: [String: EngineStatus].self)) ?? [:]
            routing = (try? await env.client.call("getRouting", as: [String: String].self)) ?? [:]
        }
    }

    private func engineRow(_ name: String, _ s: EngineStatus?, last: Bool) -> some View {
        GLRow(last: last) {
            Text(name).font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
            Spacer()
            if let s {
                HStack(spacing: 6) {
                    Circle().fill(s.available == true ? Tok.green : Tok.red).frame(width: 7, height: 7)
                    Text(s.available == true ? "Ready" : (s.reason?.isEmpty == false ? s.reason! : "Not signed in"))
                        .font(TokFont.text(TokFont.footnote)).foregroundStyle(s.available == true ? Tok.green : Tok.red)
                }
            } else { Text("…").foregroundStyle(Tok.inkTertiary) }
        }
    }

    private func setRouting(_ key: String, _ val: String) {
        routing[key] = val
        Task { try? await env.client.callVoid("setRouting", [key: val]) }
    }
}

// MARK: - Devices
struct DevicesPane: View {
    @Environment(AppEnv.self) private var env
    @State private var devices: [RemoteDevice] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            PaneHead(title: "Devices", sub: "This Mac is the brain; phones and web are remotes.")
            GroupedList(header: "This Mac") {
                GLRow(last: true) {
                    Icon(name: "cpu", size: 18).foregroundStyle(Tok.green).frame(width: 36, height: 36).background(Tok.green.opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: 9))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(Host.current().localizedName ?? "This Mac").font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                        Text("macOS · host · online").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.green)
                    }
                    Spacer()
                }
            }
            GroupedList(header: "Your remotes") {
                if devices.isEmpty {
                    Text("No remotes paired. Pair a phone from the mobile app.").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                        .padding(.horizontal, 14).padding(.vertical, 14).frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ForEach(Array(devices.enumerated()), id: \.element.id) { i, d in
                        GLRow(last: i == devices.count - 1) {
                            Icon(name: "smartphone", size: 18).foregroundStyle(d.live == true ? Tok.teal : Tok.inkTertiary)
                                .frame(width: 36, height: 36).background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 9))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(d.name ?? "Remote").font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                                Text(d.live == true ? "online now" : "last seen \(RelTime.ago(d.lastSeen))").font(TokFont.text(TokFont.caption)).foregroundStyle(d.live == true ? Tok.green : Tok.inkTertiary)
                            }
                            Spacer()
                        }
                    }
                }
            }
        }
        .task { devices = (try? await env.client.call("getPairing", as: PairingResult.self))?.devices ?? [] }
    }
}

enum RelTime {
    static func ago(_ ms: Double?) -> String {
        guard let ms, ms > 0 else { return "a while ago" }
        let secs = Int(Date().timeIntervalSince1970 - ms / 1000)
        if secs < 60 { return "\(max(secs, 1))s ago" }
        if secs < 3600 { return "\(secs / 60)m ago" }
        if secs < 86400 { return "\(secs / 3600)h ago" }
        return "\(secs / 86400)d ago"
    }
}
