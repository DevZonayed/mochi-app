import SwiftUI
import AppKit

/// The VS Code-style right panel: "All files" (lazy file tree), "Edited" (files this chat wrote),
/// "Checks" (reviewer verdicts), and a collapsible Setup/Run/Terminal command dock. Mirrors
/// `RightSidebar.tsx`. Mounts only when the active project has a folder on disk.
struct WorkspaceRightSidebar: View {
    @Environment(AppEnv.self) private var env
    @Bindable var store: WorkspaceStore

    enum Tab { case files, edited, checks }
    @State private var tab: Tab = .files
    @State private var query = ""
    @State private var searching = false
    @State private var root: [DirEntry]? = nil
    @State private var rootError: String?
    @State private var refreshKey = 0
    @AppStorage("maestro.rightsidebar.collapsed") private var collapsed = false

    @State private var edited: [(name: String, path: String)] = []
    @State private var checks: [CheckItem] = []

    struct CheckItem: Identifiable { let id: String; let title: String; let verdict: String; let text: String }

    private var project: Project? { store.activeProjectId.flatMap { store.project($0) } }
    private var projectId: String? { project?.id }
    private var sessionRoot: String? {
        guard let pid = projectId, let sid = store.activeTab?.sessionId else { return project?.path }
        return store.sessionsByProject[pid]?.first { $0.id == sid }?.worktreePath ?? project?.path
    }

    var body: some View {
        Group {
            if collapsed { collapsedRail } else { expanded }
        }
        .background(Tok.bgGrouped)
        .overlay(alignment: .leading) { Tok.separator.frame(width: Tok.hairline) }
    }

    // MARK: collapsed
    private var collapsedRail: some View {
        VStack(spacing: 10) {
            Button { collapsed = false } label: { Icon(name: "sidebar", size: 15).foregroundStyle(Tok.inkSecondary).frame(width: 30, height: 30) }.buttonStyle(.plain)
            if !edited.isEmpty {
                Text("\(edited.count)").font(.system(size: 9, weight: .heavy, design: .monospaced))
                    .foregroundStyle(Tok.green).padding(.horizontal, 5).padding(.vertical, 2)
                    .background(Tok.green.opacity(0.16)).clipShape(Capsule())
            }
            Spacer()
        }
        .frame(width: 38).padding(.vertical, 8)
    }

    // MARK: expanded
    private var expanded: some View {
        VStack(spacing: 0) {
            tabStrip
            Divider().overlay(Tok.separator)
            content
            CommandDock(projectId: projectId ?? "", root: sessionRoot, client: env.client)
        }
        .frame(width: 300)
    }

    private var tabStrip: some View {
        HStack(spacing: 2) {
            tabButton("All files", .files, count: nil)
            tabButton("Edited", .edited, count: edited.count)
            tabButton("Checks", .checks, count: checks.count, warn: checks.contains { $0.verdict == "needs-work" })
            Spacer(minLength: 0)
            if tab == .files {
                Button { searching.toggle() } label: { Icon(name: "search", size: 14).foregroundStyle(searching ? Tok.ink : Tok.inkTertiary).frame(width: 26, height: 26) }.buttonStyle(.plain)
                Button { refreshKey += 1; Task { await loadRoot() } } label: { Icon(name: "refresh", size: 13).foregroundStyle(Tok.inkTertiary).frame(width: 26, height: 26) }.buttonStyle(.plain)
            }
            Button { collapsed = true } label: { Icon(name: "sidebar", size: 15).foregroundStyle(Tok.inkTertiary).frame(width: 26, height: 26) }.buttonStyle(.plain)
        }
        .padding(.horizontal, 8).frame(height: 42)
    }

    private func tabButton(_ label: String, _ t: Tab, count: Int?, warn: Bool = false) -> some View {
        let on = tab == t
        return Button { tab = t } label: {
            HStack(spacing: 5) {
                Text(label).font(TokFont.text(TokFont.footnote, on ? .semibold : .medium))
                if let count, count > 0 {
                    Text("\(count)").font(TokFont.mono(TokFont.caption))
                        .foregroundStyle(warn ? Tok.orange : Tok.inkTertiary)
                }
            }
            .foregroundStyle(on ? Tok.ink : Tok.inkTertiary)
            .padding(.horizontal, 9).frame(height: 28)
            .background(on ? Tok.fillSecondary : .clear).clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }.buttonStyle(.plain)
    }

    @ViewBuilder private var content: some View {
        switch tab {
        case .files: filesTab
        case .edited: editedTab
        case .checks: checksTab
        }
    }

    // MARK: All files
    private var filesTab: some View {
        VStack(spacing: 0) {
            if searching {
                HStack(spacing: 7) {
                    Icon(name: "search", size: 13).foregroundStyle(Tok.inkTertiary)
                    TextField("Filter top-level files…", text: $query).textFieldStyle(.plain).font(TokFont.text(TokFont.caption))
                }
                .padding(.horizontal, 9).frame(height: 28).background(Tok.fillSecondary)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous)).padding(8)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let rootError {
                        Text(rootError).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).padding(12)
                    } else if root == nil {
                        Text("Loading…").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).padding(12)
                    } else {
                        let filtered = query.isEmpty ? (root ?? []) : (root ?? []).filter { $0.name.localizedCaseInsensitiveContains(query) }
                        if filtered.isEmpty {
                            Text(query.isEmpty ? "Empty folder." : "No matches.").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).padding(12)
                        } else {
                            ForEach(filtered) { e in
                                DirNode(projectId: projectId ?? "", entry: e, depth: 0, client: env.client,
                                        onOpenFile: { store.openFile($0, projectId: projectId) })
                            }
                        }
                    }
                }
                .padding(.vertical, 4)
            }
            .frame(maxHeight: .infinity)
        }
        .task(id: "\(projectId ?? "")-\(refreshKey)") { await loadRoot() }
    }

    private func loadRoot() async {
        guard let pid = projectId else { root = []; return }
        rootError = nil
        do { root = try await env.client.listDir(pid, "").entries }
        catch let e { rootError = "Couldn't load files. \(e)"; root = [] }
    }

    // MARK: Edited
    private var editedTab: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if edited.isEmpty {
                    Text("No files edited in this chat yet.").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).padding(12)
                } else {
                    ForEach(edited, id: \.path) { f in
                        Button { store.openFile(f.path, projectId: projectId) } label: {
                            HStack(spacing: 8) {
                                Circle().fill(Tok.green).frame(width: 5, height: 5)
                                Text(f.name).font(TokFont.text(TokFont.caption, .medium)).foregroundStyle(Tok.inkSecondary).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 10).padding(.vertical, 5).contentShape(Rectangle())
                        }.buttonStyle(.plain).hoverFill(Tok.fillTertiary, radius: 0)
                    }
                }
            }.padding(.vertical, 4)
        }
        .task(id: store.activeTab?.sessionId ?? "") { await loadEditedAndChecks() }
    }

    // MARK: Checks
    private var checksTab: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if checks.isEmpty {
                    Text("No review results yet.").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).padding(12)
                } else {
                    ForEach(checks) { c in
                        let ok = c.verdict == "approved"
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 6) {
                                Icon(name: ok ? "checkCircle" : "alert", size: 13).foregroundStyle(ok ? Tok.green : Tok.orange)
                                Text(c.title).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.ink).lineLimit(1)
                            }
                            if !c.text.isEmpty { Text(c.text).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary).lineLimit(4) }
                        }
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background((ok ? Tok.green : Tok.orange).opacity(0.10))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                }
            }.padding(8)
        }
        .task(id: store.activeTab?.sessionId ?? "") { await loadEditedAndChecks() }
    }

    /// Derive "Edited" (chat-written files) + "Checks" (reviewer verdicts) from the active session's jobs.
    private func loadEditedAndChecks() async {
        guard let pid = projectId, let sid = store.activeTab?.sessionId else { edited = []; checks = []; return }
        let jobs = (try? await env.client.call("listJobs", ["projectId": pid, "sessionId": sid], as: [Job].self)) ?? []
        var seen = Set<String>(); var files: [(String, String)] = []; var cks: [CheckItem] = []
        for job in jobs {
            for item in job.transcript ?? [] {
                if item.kind == "tool", ToolViz.isWriteFileTool(item.name) {
                    let rel = ToolViz.scrubInternalMcp(item.text).trimmed
                    guard !rel.isEmpty, ToolViz.looksLikePath(rel), let abs = ToolViz.absolutePath(rel, root: sessionRoot), !seen.contains(abs) else { continue }
                    seen.insert(abs); files.append((ToolViz.baseName(rel), abs))
                }
                if item.kind == "review" {
                    cks.append(CheckItem(id: "\(item.ts)", title: item.verdict == "approved" ? "Approved" : "Needs work",
                                         verdict: item.verdict ?? "needs-work", text: item.text))
                }
            }
        }
        edited = files.reversed()   // newest first
        checks = cks
    }
}

/// One lazy file-tree row: a dir toggles + lazy-loads its children; a file opens a tab. Draggable
/// (the absolute path) so it can be dropped into the composer as a reference.
private struct DirNode: View {
    let projectId: String
    let entry: DirEntry
    let depth: Int
    let client: MaestroClient
    let onOpenFile: (String) -> Void
    @State private var open = false
    @State private var children: [DirEntry]?
    @State private var loading = false
    @State private var hovering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            row
            if open {
                if let children {
                    ForEach(children) { DirNode(projectId: projectId, entry: $0, depth: depth + 1, client: client, onOpenFile: onOpenFile) }
                } else if loading {
                    Text("…").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                        .padding(.leading, CGFloat(10 + (depth + 1) * 12)).padding(.vertical, 4)
                }
            }
        }
    }

    private var row: some View {
        Button {
            if entry.isDir { toggle() } else { onOpenFile(entry.path) }
        } label: {
            HStack(spacing: 6) {
                if entry.isDir {
                    Icon(name: "chevronRight", size: 12).foregroundStyle(Tok.inkTertiary)
                        .rotationEffect(.degrees(open ? 90 : 0)).frame(width: 14)
                } else {
                    FileTreeIcon(name: entry.name, size: 14)
                }
                Text(entry.name).font(TokFont.text(TokFont.caption, .medium)).foregroundStyle(Tok.inkSecondary).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.leading, CGFloat(10 + depth * 12)).padding(.trailing, 8).padding(.vertical, 4)
            .background(hovering ? Tok.fillTertiary : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).onHover { hovering = $0 }
        .draggable(entry.path)   // drag a file into the composer as a reference
    }

    private func toggle() {
        open.toggle()
        if open, children == nil, !loading {
            loading = true
            Task {
                children = (try? await client.listDir(projectId, entry.path).entries) ?? []
                loading = false
            }
        }
    }
}

/// Collapsible Setup / Run / Terminal dock — runs a command in the project worktree and streams its
/// output over the `cmd-output` event bus. Setup/Run scripts persist per project.
private struct CommandDock: View {
    let projectId: String
    let root: String?
    let client: MaestroClient

    enum Mode: String { case setup, run, terminal }
    @State private var collapsed = true
    @State private var mode: Mode = .run
    @State private var terminal = ""
    @State private var output = ""
    @State private var runId: String?
    @State private var token: Int?
    @AppStorage private var setupScript: String
    @AppStorage private var runScript: String

    init(projectId: String, root: String?, client: MaestroClient) {
        self.projectId = projectId; self.root = root; self.client = client
        _setupScript = AppStorage(wrappedValue: "", "maestro.setup.\(projectId)")
        _runScript = AppStorage(wrappedValue: "", "maestro.run.\(projectId)")
    }

    private var running: Bool { runId != nil }

    var body: some View {
        VStack(spacing: 0) {
            Divider().overlay(Tok.separator)
            header
            if !collapsed {
                inputRow
                ScrollViewReader { proxy in
                    ScrollView {
                        Text(output.isEmpty ? "" : output)
                            .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Tok.ink)
                            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 10).padding(.vertical, 6).id("out")
                    }
                    .frame(height: 150).onChange(of: output) { proxy.scrollTo("out", anchor: .bottom) }
                }
            }
        }
        .frame(height: collapsed ? 38 : 230)
        .background(Tok.bgElevated)
        .onDisappear { if let t = token { client.removeHandler(t) } }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Button { collapsed.toggle() } label: {
                Icon(name: collapsed ? "chevronRight" : "chevronDown", size: 11).foregroundStyle(Tok.inkTertiary)
            }.buttonStyle(.plain)
            ForEach([Mode.setup, .run, .terminal], id: \.self) { m in
                Button { mode = m } label: {
                    Text(m.rawValue.capitalized).font(TokFont.text(TokFont.caption, mode == m ? .semibold : .medium))
                        .foregroundStyle(mode == m ? Tok.ink : Tok.inkTertiary)
                        .padding(.horizontal, 8).frame(height: 24)
                        .background(mode == m ? Tok.fillSecondary : .clear).clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                }.buttonStyle(.plain)
            }
            Spacer()
            if running {
                Button { stop() } label: { Icon(name: "square", size: 12).foregroundStyle(Tok.red) }.buttonStyle(.plain).help("Stop")
            }
        }
        .padding(.horizontal, 10).frame(height: 38)
    }

    private var inputRow: some View {
        HStack(spacing: 6) {
            Text("$").font(.system(size: 12, weight: .bold, design: .monospaced)).foregroundStyle(Tok.green)
            TextField(placeholder, text: binding).textFieldStyle(.plain).font(.system(size: 12, design: .monospaced))
                .onSubmit { runCurrent() }
            Button { runCurrent() } label: { Icon(name: "play", size: 12).foregroundStyle(Tok.blue) }.buttonStyle(.plain).disabled(running)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }
    }

    private var placeholder: String {
        switch mode { case .setup: "e.g. pnpm install"; case .run: "e.g. pnpm dev"; case .terminal: "type a command…" }
    }
    private var binding: Binding<String> {
        switch mode { case .setup: $setupScript; case .run: $runScript; case .terminal: $terminal }
    }

    private func runCurrent() {
        let cmd = binding.wrappedValue.trimmed
        guard !cmd.isEmpty, !projectId.isEmpty, !running else { return }
        output += (output.isEmpty ? "" : "\n") + "$ " + cmd + "\n"
        if token == nil {
            token = client.onEvent { ev in
                guard ev.name == "cmd-output", let o = decodeJSON(ev.data, as: CmdOutput.self), o.runId == runId else { return }
                Task { @MainActor in append(o) }
            }
        }
        Task {
            do { runId = try await client.runCommand(projectId, cmd) }
            catch let e { output += "Error: \(e)\n" }
        }
    }
    private func append(_ o: CmdOutput) {
        if o.stream == "exit" { output += "\n[process exited \(o.code ?? 0)]\n"; runId = nil }
        else if let c = o.chunk { output += c; if output.count > 60000 { output = String(output.suffix(60000)) } }
    }
    private func stop() { if let id = runId { Task { await client.killCommand(id) } }; runId = nil }
}
