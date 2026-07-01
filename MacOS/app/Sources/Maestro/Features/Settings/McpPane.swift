import SwiftUI

/// Operator-managed custom MCP servers (STDIO / Streamable HTTP). The live, Mac-local surface.
struct McpPane: View {
    @Environment(AppEnv.self) private var env
    @State private var servers: [McpServer] = []
    @State private var loading = true
    @State private var adding = false

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            HStack(alignment: .top) {
                PaneHead(title: "MCP servers", sub: "Tools the agent can reach. Enabled servers merge into every run.")
                Spacer()
                PillButton(title: "Connect a custom MCP", icon: "plus") { adding = true }
            }
            if loading {
                Spinner(size: 18).tint(Tok.inkTertiary).frame(maxWidth: .infinity).padding(30)
            } else if servers.isEmpty {
                VStack(spacing: 10) {
                    Icon(name: "bolt", size: 24).foregroundStyle(Tok.inkTertiary)
                    Text("No custom MCP servers yet").font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                    Text("Connect one to give the agent extra tools.").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 36)
                .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Tok.separatorStrong, style: StrokeStyle(lineWidth: 1, dash: [5])))
            } else {
                GroupedList(footer: "Codex uses STDIO servers; Streamable HTTP servers run on Claude.") {
                    ForEach(Array(servers.enumerated()), id: \.element.id) { i, s in
                        GLRow(last: i == servers.count - 1) {
                            Icon(name: "terminal", size: 16).foregroundStyle(Tok.teal)
                                .frame(width: 36, height: 36).background(Tok.teal.opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: 9))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(s.name).font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                                Text("\(s.transport.uppercased()) · \(s.transport == "http" ? (s.url ?? "") : (s.command ?? ""))")
                                    .font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1)
                            }
                            Spacer()
                            Button { Task { await remove(s) } } label: { Icon(name: "trash", size: 14).foregroundStyle(Tok.inkTertiary) }.buttonStyle(.plain)
                            MSwitch(on: Binding(get: { s.enabled }, set: { v in Task { await setEnabled(s, v) } }))
                        }
                    }
                }
            }
        }
        .task { await load() }
        .sheet(isPresented: $adding) { McpForm { await load() } .environment(env) }
    }

    private func load() async {
        servers = (try? await env.client.call("listMcpServers", as: [McpServer].self)) ?? []
        loading = false
    }
    private func setEnabled(_ s: McpServer, _ v: Bool) async {
        if let i = servers.firstIndex(of: s) { servers[i].enabled = v }
        try? await env.client.callVoid("setMcpServerEnabled", ["id": s.id, "enabled": v])
    }
    private func remove(_ s: McpServer) async {
        servers.removeAll { $0.id == s.id }
        try? await env.client.callVoid("removeMcpServer", ["id": s.id])
    }
}

struct McpForm: View {
    @Environment(AppEnv.self) private var env
    @Environment(\.dismiss) private var dismiss
    let onSaved: () async -> Void

    @State private var name = ""
    @State private var transport = "stdio"
    @State private var command = ""
    @State private var url = ""
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Connect to a custom MCP").font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
            field("Name") { TextField("my-tools", text: $name).textFieldStyle(.plain).inputBox() }
            field("Transport") {
                SegmentedControl(options: [("stdio", "STDIO", nil), ("http", "Streamable HTTP", nil)],
                                 value: Binding(get: { transport }, set: { transport = $0 }))
            }
            if transport == "http" {
                field("URL") { TextField("https://…", text: $url).textFieldStyle(.plain).inputBox() }
            } else {
                field("Command") { TextField("npx -y @scope/mcp-server", text: $command).textFieldStyle(.plain).inputBox() }
            }
            HStack {
                Spacer()
                PillButton(title: "Cancel", kind: .plain) { dismiss() }
                PillButton(title: "Save", disabled: !canSave, busy: busy) { Task { await save() } }
            }
        }
        .padding(22).frame(width: 480).background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var canSave: Bool { !name.trimmed.isEmpty && !(transport == "http" ? url : command).trimmed.isEmpty }
    private func save() async {
        busy = true; defer { busy = false }
        var params: [String: Any] = ["name": name.trimmed, "transport": transport]
        if transport == "http" { params["url"] = url.trimmed } else { params["command"] = command.trimmed }
        try? await env.client.callRaw("addMcpServer", params)
        await onSaved()
        dismiss()
    }
    private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.inkSecondary)
            content()
        }
    }
}
