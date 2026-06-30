import SwiftUI
import AppKit

/// Provider accounts + API keys + OAuth, and the on-demand engine-binary download (EngineSetup).
struct AccountsPane: View {
    @Environment(AppEnv.self) private var env
    @State private var conns: [ProviderConn] = []
    @State private var engines: [String: EngineState] = [:]
    @State private var keyDrafts: [String: String] = [:]
    @State private var busy: String?
    @State private var ghDevice: GitHubDevice?
    @State private var ghToken: Int?

    private struct P { let id: String; let name: String; let tint: Color; let hint: String; let oauth: String? }
    private let providers: [P] = [
        .init(id: "anthropic", name: "Anthropic", tint: Tok.anthropic, hint: "sk-ant-…", oauth: nil),
        .init(id: "openai", name: "OpenAI", tint: Tok.ink, hint: "sk-…", oauth: "Sign in with ChatGPT"),
        .init(id: "fal", name: "fal.ai", tint: Tok.purple, hint: "fal key", oauth: nil),
        .init(id: "github", name: "GitHub", tint: Tok.ink, hint: "Personal access token", oauth: "Sign in with GitHub"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            PaneHead(title: "Accounts & keys", sub: "Sign in or paste API keys. Stored encrypted on this Mac.")
            GroupedList(header: "Providers") {
                ForEach(Array(providers.enumerated()), id: \.element.id) { i, p in
                    providerRow(p, last: i == providers.count - 1)
                }
            }
            GroupedList(header: "Engine runtimes", footer: "Native CLIs are downloaded on first use, not bundled.") {
                engineRow("Claude engine", "claude", Tok.anthropic, last: false)
                engineRow("Codex engine", "codex", Tok.ink, last: true)
            }
        }
        .task {
            await refresh()
            if ghToken == nil {
                ghToken = env.client.onEvent { ev in
                    guard ev.name == "github-device", let d = decodeJSON(ev.data, as: GitHubDevice.self) else { return }
                    Task { @MainActor in
                        ghDevice = d
                        if d.stage == "code", let uri = d.verificationUri, let url = URL(string: uri) { NSWorkspace.shared.open(url) }
                    }
                }
            }
        }
        .onDisappear { if let t = ghToken { env.client.removeHandler(t); ghToken = nil } }
    }

    private func conn(_ id: String) -> ProviderConn? { conns.first { $0.provider == id } }

    private func providerRow(_ p: P, last: Bool) -> some View {
        let c = conn(p.id)
        return GLRow(last: last) {
            Text(String(p.name.prefix(1))).font(.system(size: 15, weight: .bold)).foregroundStyle(p.tint)
                .frame(width: 36, height: 36).background(p.tint.opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 1) {
                Text(p.name).font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                Text(c?.detail ?? "Not signed in").font(TokFont.text(TokFont.caption)).foregroundStyle(c != nil ? Tok.green : Tok.inkTertiary)
            }
            Spacer()
            if c != nil {
                Button("Disconnect") { Task { await disconnect(p.id) } }.buttonStyle(.plain)
                    .font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.red)
            } else if let label = p.oauth {
                if p.id == "github", busy == "github", let dev = ghDevice {
                    ghDeviceView(dev)
                } else {
                    PillButton(title: busy == p.id ? "Signing in…" : label, kind: .plain, busy: busy == p.id) { Task { await oauth(p) } }
                }
            } else {
                HStack(spacing: 6) {
                    SecureField(p.hint, text: Binding(get: { keyDrafts[p.id] ?? "" }, set: { keyDrafts[p.id] = $0 }))
                        .textFieldStyle(.plain).font(TokFont.mono(TokFont.caption)).frame(maxWidth: 150).inputBox()
                    PillButton(title: "Connect", kind: .plain, disabled: (keyDrafts[p.id] ?? "").trimmed.isEmpty) { Task { await connect(p.id) } }
                }
            }
        }
    }

    private func engineRow(_ name: String, _ id: String, _ tint: Color, last: Bool) -> some View {
        let s = engines[id]
        return GLRow(last: last) {
            Text(String(name.prefix(1))).font(.system(size: 15, weight: .bold)).foregroundStyle(tint)
                .frame(width: 38, height: 38).background(tint.opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 1) {
                Text(name).font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                Text(engineDetail(s)).font(TokFont.text(TokFont.caption)).foregroundStyle(s?.installed == true ? Tok.green : Tok.inkTertiary)
            }
            Spacer()
            if s?.supported == false {
                Text("Unsupported").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
            } else if s?.installed == true {
                Icon(name: "check", size: 14).foregroundStyle(Tok.green)
            } else {
                PillButton(title: busy == "engine:\(id)" ? "Downloading…" : "Download", kind: .quiet, busy: busy == "engine:\(id)") { Task { await install(id) } }
            }
        }
    }

    private func engineDetail(_ s: EngineState?) -> String {
        guard let s else { return "…" }
        if s.installed == true { return s.source == "system" ? "System install" : "Installed · \(s.version ?? "latest")" }
        return "Not installed"
    }

    // MARK: actions
    private func refresh() async {
        conns = (try? await env.client.call("listProviders", as: [ProviderConn].self)) ?? []
        engines = (try? await env.client.call("enginesStatus", as: [String: EngineState].self)) ?? [:]
    }
    private func connect(_ id: String) async {
        busy = id; defer { busy = nil }
        try? await env.client.callRaw("connectProvider", ["provider": id, "key": keyDrafts[id] ?? ""])
        keyDrafts[id] = ""; await refresh()
    }
    private func disconnect(_ id: String) async { try? await env.client.callVoid("disconnectProvider", ["provider": id]); await refresh() }
    private func ghDeviceView(_ dev: GitHubDevice) -> some View {
        Group {
            if dev.stage == "downloading-cli" {
                Text("Downloading gh CLI… \(dev.pct ?? 0)%").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary)
            } else if dev.stage == "code", let code = dev.userCode {
                HStack(spacing: 6) {
                    Text(code).font(TokFont.mono(TokFont.footnote, .bold)).tracking(2).foregroundStyle(Tok.ink)
                        .padding(.horizontal, 8).frame(height: 26).background(Tok.fillSecondary).clipShape(RoundedRectangle(cornerRadius: 7))
                    Button { NativeBridge.copy(code) } label: { Icon(name: "command", size: 12).foregroundStyle(Tok.inkTertiary) }.buttonStyle(.plain)
                    Text("→ browser").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                }
            } else {
                Text("Starting…").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
            }
        }
    }

    private func oauth(_ p: P) async {
        busy = p.id; if p.id == "github" { ghDevice = nil }; defer { busy = nil }
        try? await env.client.callRaw(p.id == "github" ? "githubLogin" : "codexLogin", [:])
        ghDevice = nil
        await refresh()
    }
    private func install(_ id: String) async {
        busy = "engine:\(id)"; defer { busy = nil }
        try? await env.client.callRaw("installEngine", ["engine": id])
        await refresh()
    }
}
