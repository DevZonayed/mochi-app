import SwiftUI
import AppKit

/// Process entry. `--selftest` runs a headless integration check (boots the sidecar, connects
/// over WS, calls a real RPC, prints, exits) without opening a window — used to verify the
/// Swift⇄sidecar path in CI/dev. Otherwise launches the normal SwiftUI app.
@main
struct Launcher {
    static func main() {
        if CommandLine.arguments.contains("--toolviz") {
            ToolVizSelfTest.run()
        } else if CommandLine.arguments.contains("--statusdemo") {
            StatusBarDemo.run()
        } else if CommandLine.arguments.contains("--selftest") {
            SelfTest.run()
        } else {
            MaestroApp.main()
        }
    }
}

struct MaestroApp: App {
    @State private var env = AppEnv()

    init() {
        // Thin overlay scrollbars app-wide (Codespace + every screen) instead of the bold legacy bars.
        OverlayScrollers.install()
    }

    var body: some Scene {
        Window("Maestro", id: "main") {
            RootView()
                .environment(env)
                .preferredColorScheme(env.theme.resolved)
                .frame(minWidth: 1040, minHeight: 700)
                .task { env.boot(); NSApp.activate(ignoringOtherApps: true) }
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1320, height: 860)
        .windowResizability(.contentMinSize)
    }
}

enum SelfTest {
    static func run() {
        Task { @MainActor in
            let client = MaestroClient()
            let sup = SidecarSupervisor(client: client)
            sup.start()
            var connected = false
            for _ in 0..<400 {   // up to ~20s — cold dev boot transpiles the whole brain
                if sup.engineState.isReady { connected = true; break }
                if case .down(let m) = sup.engineState { print("SELFTEST FAIL: sidecar \(m)"); exit(1) }
                try? await Task.sleep(for: .milliseconds(50))
            }
            guard connected else { print("SELFTEST FAIL: engine not ready (\(sup.engineState))"); exit(1) }
            do {
                let projects = try await client.call("listProjects", as: [Project].self)
                let health = try await client.callRaw("health", [:])
                print("SELFTEST OK: health=\(String(data: health, encoding: .utf8) ?? "?")")
                print("SELFTEST OK: listProjects count=\(projects.count); first=\(projects.first?.name ?? "—") kind=\(projects.first?.kind ?? "—")")
                // Exercise the chat read path (Session/Job/TranscriptItem decoders) against real data.
                if let p = projects.first(where: { $0.kind != "design" }) ?? projects.first {
                    let sessions = try await client.call("listSessions", ["projectId": p.id], as: [ChatSession].self)
                    print("SELFTEST OK: listSessions(\(p.name)) count=\(sessions.count); first=\(sessions.first?.displayTitle ?? "—") archived=\(sessions.first?.isArchived ?? false)")
                    if let sid = sessions.first?.id {
                        let jobs = try await client.call("listJobs", ["projectId": p.id, "sessionId": sid], as: [Job].self)
                        let blocks = jobs.first?.transcript?.count ?? 0
                        print("SELFTEST OK: listJobs count=\(jobs.count); first status=\(jobs.first?.status ?? "—") transcriptBlocks=\(blocks)")
                    }
                    // P1d project-settings read paths.
                    let skills = try await client.call("listProjectSkills", ["id": p.id], as: InstalledSkillsResult.self)
                    let caps = try await client.call("listSkills", as: [Capability].self)
                    let meta = try await client.call("skillRegistryMeta", as: RegistryMeta.self)
                    let search = try await client.call("searchSkills", ["q": "pdf", "limit": 5], as: SkillSearchResult.self)
                    print("SELFTEST OK: projectSkills=\(skills.skills.count) caps=\(caps.count)(mcp \(caps.filter { $0.kind == "mcp" }.count)) registry=\(meta.count ?? 0) search(pdf)=\(search.results.count)")
                    print("SELFTEST OK: project.instructions present=\(p.instructions?.isEmpty == false)")
                }
                // Design surface: comments decoder + the live-preview HTTP route.
                if let d = projects.first(where: { $0.kind == "design" }) {
                    let cs = try await client.call("listDesignComments", ["id": d.id], as: DesignCommentsResult.self)
                    print("SELFTEST OK: design '\(d.name)' comments=\(cs.comments.count)")
                    if let base = sup.httpBase, let url = URL(string: "\(base)/design/\(d.id)/design/index.html") {
                        let (data, resp) = try await URLSession.shared.data(from: url)
                        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                        let html = String(data: data, encoding: .utf8) ?? ""
                        print("SELFTEST OK: design route \(code) bytes=\(data.count) harness=\(html.contains("__maestroComments"))")
                    }
                }
                // WhatsApp surface.
                let wa = try await client.call("whatsappStatus", as: WhatsAppStatus.self)
                print("SELFTEST OK: whatsappStatus connected=\(wa.connected ?? false) name=\(wa.name ?? "—")")
                if wa.connected == true {
                    let chats = try await client.call("waListChats", as: [WaChat].self)
                    print("SELFTEST OK: waListChats=\(chats.count); first=\(chats.first?.name ?? "—") unread=\(chats.first?.unreadCount ?? 0)")
                    if let cid = chats.first?.chatId {
                        let msgs = try await client.call("waGetMessages", ["chatId": cid, "limit": 20], as: [WaMessage].self)
                        print("SELFTEST OK: waGetMessages=\(msgs.count); last fromMe=\(msgs.last?.fromMe ?? false) media=\(msgs.last?.media != nil)")
                    }
                }
                // Comms gateway decoders.
                let cs = try await client.call("commsStatus", as: CommsStatus.self)
                let binds = try await client.call("listChatBindings", as: [ChatBinding].self)
                let pend = try await client.call("listPendingChats", as: [PendingChat].self)
                let evs = try await client.call("listCommEvents", as: [CommEvent].self)
                print("SELFTEST OK: commsStatus tg.connected=\(cs.telegram.connected ?? false) wa.connected=\(cs.whatsapp.connected ?? false) wa.tracked=\(cs.whatsapp.tracked ?? 0); bindings=\(binds.count) pending=\(pend.count) events=\(evs.count)")
                // Settings decoders (all six sections).
                let est = try await client.call("engineStatus", as: [String: EngineStatus].self)
                let ens = try await client.call("enginesStatus", as: [String: EngineState].self)
                let provs = try await client.call("listProviders", as: [ProviderConn].self)
                let mcps = try await client.call("listMcpServers", as: [McpServer].self)
                let ext = try await client.call("extensionStatus", as: ExtensionStatus.self)
                let pair = try await client.call("getPairing", as: PairingResult.self)
                print("SELFTEST OK: engines claude.ready=\(est["claude"]?.available ?? false) codex.ready=\(est["codex"]?.available ?? false); installed=\(ens.values.filter { $0.installed == true }.count)")
                print("SELFTEST OK: providers=\(provs.map { $0.provider }.joined(separator: ",")); mcpServers=\(mcps.count); ext.running=\(ext.running ?? false); remotes=\(pair.devices?.count ?? 0)")
                sup.stop()
                exit(0)
            } catch {
                print("SELFTEST FAIL: \(error)")
                exit(1)
            }
        }
        RunLoop.main.run() // pump the main run loop so the @MainActor Task + URLSession callbacks fire
    }
}
