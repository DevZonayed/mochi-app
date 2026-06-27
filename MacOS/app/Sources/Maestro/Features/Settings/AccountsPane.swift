import SwiftUI

/// Provider accounts + API keys + OAuth, and the on-demand engine-binary download (EngineSetup).
struct AccountsPane: View {
    @Environment(AppEnv.self) private var env
    @State private var conns: [ProviderConn] = []
    @State private var engines: [String: EngineState] = [:]
    @State private var keyDrafts: [String: String] = [:]
    @State private var busy: String?

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
        .task { await refresh() }
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
                PillButton(title: busy == p.id ? "Signing in…" : label, kind: .plain, busy: busy == p.id) { Task { await oauth(p) } }
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
    private func oauth(_ p: P) async {
        busy = p.id; defer { busy = nil }
        try? await env.client.callRaw(p.id == "github" ? "githubLogin" : "codexLogin", [:])
        await refresh()
    }
    private func install(_ id: String) async {
        busy = "engine:\(id)"; defer { busy = nil }
        try? await env.client.callRaw("installEngine", ["engine": id])
        await refresh()
    }
}
