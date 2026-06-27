import SwiftUI

/// Browser-extension control-channel status, install path, pairing token, connected Chrome profiles.
struct ExtensionPane: View {
    @Environment(AppEnv.self) private var env
    @State private var status: ExtensionStatus?
    @State private var path: String?
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            PaneHead(title: "Browser extension", sub: "A local control channel between the app and your Chrome.")
            GroupedList(header: "Connection",
                        footer: status?.running == true ? "Listening on 127.0.0.1:\(status?.port ?? 0) — localhost only." : "Start the app's extension bridge by opening a project.") {
                GLRow(last: true) {
                    Icon(name: "globe", size: 18).foregroundStyle(status?.running == true ? Tok.green : Tok.inkTertiary)
                        .frame(width: 36, height: 36).background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 9))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(status?.running == true ? "Control channel ready" : "Offline").font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                        Text("\(status?.peers?.count ?? 0) Chrome profile(s) connected").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                    }
                    Spacer()
                }
            }
            if let p = path {
                GroupedList(header: "Install in Chrome", footer: "Load this folder as an unpacked extension at chrome://extensions.") {
                    GLRow(last: true) {
                        Icon(name: "folder", size: 16).foregroundStyle(Tok.green)
                        Text(p).font(TokFont.mono(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).lineLimit(1)
                        Spacer()
                        PillButton(title: "Reveal", kind: .plain) { Task { try? await env.client.callVoid("extensionRevealFolder") } }
                    }
                }
            }
            if let token = status?.token, !token.isEmpty {
                GroupedList(header: "Pairing token") {
                    GLRow(last: true) {
                        Icon(name: "key", size: 16).foregroundStyle(Tok.blue)
                        Text(token).font(TokFont.mono(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).tracking(1).lineLimit(1)
                        Spacer()
                        PillButton(title: copied ? "Copied ✓" : "Copy", kind: .plain) {
                            NativeBridge.copy(token); copied = true
                            Task { try? await Task.sleep(for: .seconds(1.6)); copied = false }
                        }
                    }
                }
            }
            if let peers = status?.peers, !peers.isEmpty {
                GroupedList(header: "Chrome profiles") {
                    ForEach(Array(peers.enumerated()), id: \.element.id) { i, peer in
                        GLRow(last: i == peers.count - 1) {
                            Circle().fill(peer.active == true ? Tok.green : Tok.inkTertiary).frame(width: 8, height: 8)
                            Text(peer.name ?? "Chrome profile").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                            Spacer()
                            if peer.active == true { Text("Active").font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.green) }
                            else { Button("Make active") { Task { try? await env.client.callVoid("extensionSetActive", ["clientId": peer.clientId ?? ""]); await load() } }.buttonStyle(.plain).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.blue) }
                        }
                    }
                }
            }
        }
        .task { await load(); path = (try? await env.client.call("extensionPath", as: [String: String].self))?["path"] }
    }

    private func load() async { status = try? await env.client.call("extensionStatus", as: ExtensionStatus.self) }
}
