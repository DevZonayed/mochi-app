import SwiftUI
import AppKit

/// The agent-native Design workspace: a rail of design projects, a multi-session chat (the SAME
/// ChatThread used by coding projects, design-mode via project.kind), a live WKWebView preview
/// served by the sidecar, the Mochi-style visual comment harness, and hand-off-to-code.
struct DesignWorkspace: View {
    @Environment(AppEnv.self) private var env

    @State private var designs: [Project] = []
    @State private var activeId: String?
    @State private var sessionId: String?
    @State private var sessions: SessionsStore?
    @State private var device: Device = .desktop
    @State private var nonce = 0
    @State private var creating = false
    @State private var newName = ""
    @State private var loaded = false
    @State private var jobToken: Int?

    // comments
    @State private var comments: [DesignComment] = []
    @State private var commentMode = false
    @State private var showComments = false
    @State private var picked: (selector: String, label: String)?
    @State private var noteText = ""
    @State private var command: DesignCommand?
    @State private var cmdSeq = 0

    // hand-off
    @State private var handoffOpen = false
    @State private var handoffName = ""

    // layout
    @State private var chatWidth: CGFloat = 460
    @State private var dragBase: CGFloat?
    @State private var snapshotToast: String?

    enum Device: CaseIterable { case desktop, tablet, phone
        var width: CGFloat { self == .desktop ? 0 : (self == .tablet ? 834 : 390) }
        var icon: String { self == .phone ? "smartphone" : (self == .tablet ? "smartphone" : "cpu") }
        var label: String { self == .desktop ? "Desktop" : (self == .tablet ? "Tablet" : "Phone") }
    }

    private var active: Project? { designs.first { $0.id == activeId } }
    private var openCount: Int { comments.filter { !$0.isResolved }.count }

    var body: some View {
        HStack(spacing: 0) {
            rail
            if active != nil { workspace } else { emptyState }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .sheet(isPresented: $handoffOpen) { handoffSheet }
        .task {
            if !loaded { await load(); loaded = true }
            if jobToken == nil {
                jobToken = env.client.onEvent { ev in
                    guard ev.name == "job", let j = decodeJSON(ev.data, as: Job.self), j.projectId == activeId else { return }
                    Task { @MainActor in nonce += 1 }
                }
            }
        }
        .onDisappear { if let t = jobToken { env.client.removeHandler(t); jobToken = nil } }
    }

    // MARK: rail
    private var rail: some View {
        VStack(spacing: 0) {
            Text("DESIGNS").font(TokFont.text(TokFont.caption, .bold)).tracking(0.5).foregroundStyle(Tok.inkTertiary)
                .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.top, 12).padding(.bottom, 8)
            ScrollView {
                VStack(spacing: 1) {
                    ForEach(designs) { d in
                        Button { select(d) } label: {
                            HStack(spacing: 8) {
                                Icon(name: "brush", size: 15).foregroundStyle(activeId == d.id ? .white : Tok.purple)
                                Text(d.name).font(TokFont.text(TokFont.footnote, activeId == d.id ? .semibold : .medium))
                                    .foregroundStyle(activeId == d.id ? .white : Tok.ink).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 10).padding(.vertical, 8)
                            .background(activeId == d.id ? Tok.blue : .clear)
                            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                        }.buttonStyle(.plain)
                    }
                }.padding(.horizontal, 8)
            }
            Divider().overlay(Tok.separator)
            if creating {
                HStack(spacing: 6) {
                    TextField("Design name…", text: $newName).textFieldStyle(.plain).font(TokFont.text(TokFont.footnote))
                        .padding(.horizontal, 9).frame(height: 30).background(Tok.bgElevated)
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tok.blue, lineWidth: 1))
                        .onSubmit { Task { await createDesign(newName) } }
                    Button("Add") { Task { await createDesign(newName) } }.buttonStyle(.plain)
                        .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 10).frame(height: 30).background(Tok.blue).clipShape(RoundedRectangle(cornerRadius: 8))
                }.padding(10)
            } else {
                Button { creating = true } label: {
                    HStack(spacing: 6) { Icon(name: "plus", size: 14); Text("New design").font(TokFont.text(TokFont.footnote, .semibold)) }
                        .foregroundStyle(Tok.inkSecondary).frame(maxWidth: .infinity).frame(height: 34)
                        .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Tok.separatorStrong, style: StrokeStyle(lineWidth: 1, dash: [4])))
                }.buttonStyle(.plain).padding(10)
            }
        }
        .frame(width: 200).background(Tok.bgGrouped)
        .overlay(alignment: .trailing) { Tok.separator.frame(width: Tok.hairline) }
    }

    // MARK: empty
    private var emptyState: some View {
        VStack(spacing: 16) {
            Icon(name: "brush", size: 26).foregroundStyle(.white).frame(width: 52, height: 52)
                .background(LinearGradient(colors: [Tok.blue, Tok.purple], startPoint: .topLeading, endPoint: .bottomTrailing))
                .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
            Text("Design with an agent").font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
            Text("Describe what you want — a landing page, dashboard, poster, deck — and the agent builds a live, self-contained design you can refine and hand off to code.")
                .font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary).multilineTextAlignment(.center).frame(maxWidth: 380)
            PillButton(title: "Start a design") { Task { await createDesign("Design \(designs.count + 1)") } }
            HStack {
                ForEach(["Landing page", "Dashboard", "Poster", "Pricing page"], id: \.self) { preset in
                    Button { Task { await createDesign(preset) } } label: {
                        Text(preset).font(TokFont.text(TokFont.footnote, .medium)).foregroundStyle(Tok.ink)
                            .padding(.horizontal, 13).frame(height: 32).overlay(Capsule().strokeBorder(Tok.separator, lineWidth: Tok.hairline))
                    }.buttonStyle(.plain)
                }
            }.padding(.top, 6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: workspace
    private var workspace: some View {
        HStack(spacing: 0) {
            chatPanel.frame(width: chatWidth)
            splitter
            previewPanel
        }
    }

    private var splitter: some View {
        Rectangle().fill(Color.clear).frame(width: 6)
            .overlay(Tok.separator.frame(width: Tok.hairline))
            .contentShape(Rectangle())
            .onHover { inside in if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() } }
            .gesture(
                DragGesture()
                    .onChanged { v in
                        let base = dragBase ?? chatWidth
                        if dragBase == nil { dragBase = chatWidth }
                        chatWidth = min(900, max(320, base + v.translation.width))
                    }
                    .onEnded { _ in dragBase = nil }
            )
    }

    private var chatPanel: some View {
        VStack(spacing: 0) {
            if let sessions {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        sessionPill(title: "New", id: nil)
                        ForEach(sessions.active) { s in sessionPill(title: s.displayTitle, id: s.id) }
                    }.padding(.horizontal, 10).padding(.vertical, 8)
                }
                .background(Tok.bgGrouped)
                .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }
                ChatThread(projectId: active!.id, projectName: active!.name, sessionId: $sessionId) { created in
                    sessions.upsert(created)
                }.padding(10)
            }
        }
    }

    private func sessionPill(title: String, id: String?) -> some View {
        let on = sessionId == id
        return Button { sessionId = id } label: {
            HStack(spacing: 5) {
                if id == nil { Icon(name: "plus", size: 12) }
                Text(title).font(TokFont.text(TokFont.caption, .semibold)).lineLimit(1)
            }
            .foregroundStyle(on ? .white : Tok.inkSecondary)
            .padding(.horizontal, 11).frame(height: 28)
            .background(on ? Tok.blue : Tok.fillTertiary).clipShape(Capsule())
        }.buttonStyle(.plain)
    }

    private var previewPanel: some View {
        VStack(spacing: 0) {
            toolbar
            ZStack(alignment: .bottom) {
                previewBody
                if let picked { noteComposer(picked) }
            }
            .overlay(alignment: .topTrailing) { if showComments { commentsDrawer } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity).background(Tok.bgElevated)
    }

    private var toolbar: some View {
        HStack(spacing: 8) {
            SegmentedControl(options: Device.allCases.map { ($0, $0.label, $0.icon) },
                             value: Binding(get: { device }, set: { device = $0 }))
            if commentMode {
                HStack(spacing: 5) { Icon(name: "target", size: 13); Text("Click an element to comment").font(TokFont.text(TokFont.caption, .medium)) }
                    .foregroundStyle(Tok.orange)
            } else if let toast = snapshotToast {
                Text(toast).font(TokFont.mono(TokFont.caption)).foregroundStyle(toast.contains("failed") ? Tok.red : Tok.green)
            }
            Spacer()
            IconButton(icon: "chat", size: 32, tint: commentMode ? .white : Tok.inkSecondary) { toggleCommentMode(!commentMode) }
                .background(commentMode ? Tok.orange : .clear).clipShape(RoundedRectangle(cornerRadius: 8))
            ZStack(alignment: .topTrailing) {
                IconButton(icon: "layers", size: 32) { showComments.toggle() }
                if !comments.isEmpty {
                    Text("\(openCount > 0 ? openCount : comments.count)").font(TokFont.text(9, .bold)).foregroundStyle(.white)
                        .frame(minWidth: 15, minHeight: 15).background(openCount > 0 ? Tok.orange : Tok.green).clipShape(Circle()).offset(x: 2, y: -2)
                }
            }
            IconButton(icon: "refresh", size: 32) { nonce += 1 }
            IconButton(icon: "bookmark", size: 32) { Task { await snapshot() } }
            PillButton(title: "Hand off to code", icon: "terminal", kind: .plain) { handoffName = "\(active?.name ?? "Design") (code)"; handoffOpen = true }
        }
        .padding(.horizontal, 12).frame(height: 46)
        .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }
    }

    @ViewBuilder private var previewBody: some View {
        if let base = env.supervisor.httpBase, let id = activeId,
           let url = URL(string: "\(base)/design/\(id)/design/index.html?t=\(nonce)") {
            ZStack {
                Tok.fillTertiary
                DesignPreview(url: url, reloadToken: nonce, command: command,
                              onPick: { sel, label in picked = (sel, label); noteText = "" },
                              onCancelPick: { picked = nil; commentMode = false })
                    .frame(maxWidth: device.width == 0 ? .infinity : device.width)
                    .frame(maxHeight: device.width == 0 ? .infinity : nil)
                    .clipShape(RoundedRectangle(cornerRadius: device.width == 0 ? 0 : 12, style: .continuous))
                    .overlay(device.width == 0 ? nil : RoundedRectangle(cornerRadius: 12).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
                    .padding(device.width == 0 ? 0 : 20)
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Spinner(size: 20).tint(Tok.inkTertiary).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func noteComposer(_ pick: (selector: String, label: String)) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(pick.label).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkSecondary).lineLimit(1)
                Spacer()
                IconButton(icon: "x", size: 24, iconSize: 14) { picked = nil }
            }
            TextField("What should change here?", text: $noteText, axis: .vertical)
                .textFieldStyle(.plain).font(TokFont.text(TokFont.footnote)).lineLimit(2...5)
                .padding(8).background(Tok.bgElevated)
                .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
            HStack {
                Spacer()
                PillButton(title: "Cancel", kind: .plain) { picked = nil }
                PillButton(title: "Add comment", kind: .primary, disabled: noteText.trimmed.isEmpty) { Task { await savePick(pick) } }
            }
        }
        .padding(12).frame(width: 420)
        .background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        .shadow(color: .black.opacity(0.3), radius: 20, y: 8).padding(.bottom, 18)
    }

    private var commentsDrawer: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Comments").font(TokFont.text(TokFont.footnote, .bold)).foregroundStyle(Tok.ink)
                    Text("\(openCount) open · \(comments.count - openCount) resolved").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                }
                Spacer()
                IconButton(icon: "x", size: 26, iconSize: 14) { showComments = false }
            }.padding(.horizontal, 12).padding(.vertical, 10).overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }
            ScrollView {
                VStack(spacing: 4) {
                    if comments.isEmpty {
                        VStack(spacing: 8) {
                            Icon(name: "chat", size: 20).foregroundStyle(Tok.inkTertiary)
                            Text("No comments yet. Hit Comment, then click any element.").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).multilineTextAlignment(.center)
                        }.padding(.vertical, 30)
                    } else {
                        ForEach(Array(comments.enumerated()), id: \.element.id) { i, c in commentCard(i + 1, c) }
                    }
                }.padding(10)
            }
            if openCount > 0 {
                PillButton(title: "Address \(openCount) comment\(openCount == 1 ? "" : "s") with the agent", icon: "spark") { Task { await addressComments() } }
                    .padding(10)
            }
        }
        .frame(width: 300).frame(maxHeight: .infinity)
        .background(Tok.bgGrouped)
        .overlay(alignment: .leading) { Tok.separator.frame(width: Tok.hairline) }
    }

    private func commentCard(_ n: Int, _ c: DesignComment) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Button { flash(c.selector) } label: {
                Text("\(n)").font(TokFont.text(11, .bold)).foregroundStyle(.white)
                    .frame(width: 20, height: 20).background(c.isResolved ? Tok.green : Tok.orange).clipShape(Circle())
            }.buttonStyle(.plain)
            VStack(alignment: .leading, spacing: 3) {
                Text(c.label).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1)
                Text(c.note).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.ink).strikethrough(c.isResolved)
                HStack(spacing: 10) {
                    Button(c.isResolved ? "Reopen" : "Resolve") { Task { await toggleResolved(c) } }
                        .buttonStyle(.plain).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.blue)
                    Button("Delete") { Task { await deleteComment(c) } }
                        .buttonStyle(.plain).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.inkTertiary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(9).background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        .opacity(c.isResolved ? 0.6 : 1)
    }

    private var handoffSheet: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(spacing: 12) {
                Icon(name: "terminal", size: 16).foregroundStyle(.white).frame(width: 30, height: 30).background(Tok.ink).clipShape(RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Turn this design into code").font(TokFont.display(TokFont.headline, .bold)).foregroundStyle(Tok.ink)
                    Text("Copies the design into a new coding project in CodeSpace.").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
                }
            }
            TextField("Project name", text: $handoffName).textFieldStyle(.plain).inputBox()
            HStack {
                Spacer()
                PillButton(title: "Cancel", kind: .plain) { handoffOpen = false }
                PillButton(title: "Create coding project") { Task { await handoff() } }
            }
        }
        .padding(20).frame(width: 460).background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    // MARK: data
    private func load() async {
        let all = (try? await env.client.call("listProjects", as: [Project].self)) ?? []
        designs = all.filter { $0.kind == "design" }
        if activeId == nil, let first = designs.first { select(first) }
    }

    private func select(_ d: Project) {
        guard activeId != d.id else { return }
        sessions?.stop()
        activeId = d.id; sessionId = nil; nonce += 1
        commentMode = false; showComments = false; picked = nil
        let s = SessionsStore(projectId: d.id, client: env.client)
        sessions = s
        Task { await s.start(); sessionId = s.active.first?.id; await loadComments() }
    }

    private func createDesign(_ name: String) async {
        creating = false; newName = ""
        let title = name.trimmed.isEmpty ? "Design \(designs.count + 1)" : name.trimmed
        guard let proj = try? await env.client.call("createProject",
            ["name": title, "kind": "design", "template": "design", "color": "purple"], as: Project.self) else { return }
        designs.append(proj); select(proj)
    }

    private func loadComments() async {
        guard let id = activeId else { return }
        comments = (try? await env.client.call("listDesignComments", ["id": id], as: DesignCommentsResult.self))?.comments ?? []
    }

    // MARK: comments
    private func pushJS(_ js: String) { cmdSeq += 1; command = DesignCommand(seq: cmdSeq, js: js) }

    private func markersJSON() -> String {
        struct M: Encodable { let selector: String; let status: String; let n: Int }
        let arr = comments.enumerated().map { M(selector: $0.element.selector, status: $0.element.status, n: $0.offset + 1) }
        return (try? String(data: JSONEncoder().encode(arr), encoding: .utf8) ?? "[]") ?? "[]"
    }

    private func toggleCommentMode(_ on: Bool) {
        commentMode = on
        if on { showComments = true; pushJS(DesignCommand.commentModeJS(true) + ";" + DesignCommand.markersJS(markersJSON())) }
        else { picked = nil; pushJS(DesignCommand.commentModeJS(false)) }
    }

    private func savePick(_ pick: (selector: String, label: String)) async {
        guard let id = activeId else { return }
        let r = try? await env.client.call("addDesignComment",
            ["id": id, "selector": pick.selector, "label": pick.label, "note": noteText.trimmed], as: AddCommentResult.self)
        if let c = r?.comment { comments.append(c) }
        picked = nil; noteText = ""
        pushJS(DesignCommand.markersJS(markersJSON()))
    }

    private func toggleResolved(_ c: DesignComment) async {
        guard let id = activeId else { return }
        let next = c.isResolved ? "open" : "resolved"
        if let i = comments.firstIndex(of: c) { comments[i].status = next }
        try? await env.client.callVoid("setDesignCommentStatus", ["id": id, "commentId": c.id, "status": next])
        pushJS(DesignCommand.markersJS(markersJSON()))
    }

    private func deleteComment(_ c: DesignComment) async {
        guard let id = activeId else { return }
        comments.removeAll { $0.id == c.id }
        try? await env.client.callVoid("deleteDesignComment", ["id": id, "commentId": c.id])
        pushJS(DesignCommand.markersJS(markersJSON()))
    }

    private func flash(_ selector: String) { pushJS(DesignCommand.flashJS(selector)) }

    private func snapshot() async {
        guard let id = activeId else { return }
        snapshotToast = "Saving snapshot…"
        if (try? await env.client.callVoid("snapshotProject", ["id": id, "message": "Design snapshot"])) != nil {
            snapshotToast = "Snapshot saved ✓"
        } else { snapshotToast = "snapshot failed" }
        try? await Task.sleep(for: .seconds(4)); snapshotToast = nil
    }

    private func addressComments() async {
        let open = comments.filter { !$0.isResolved }
        guard !open.isEmpty, let id = activeId, let sessions else { return }
        let body = open.enumerated().map { "\($0.offset + 1). [\($0.element.label)] \($0.element.note)" }.joined(separator: "\n")
        let text = "Address these design comments:\n\(body)"
        let store = ChatThreadStore(projectId: id, client: env.client); store.start()
        await store.bind(sessionId)
        await store.send(text) { created in sessions.upsert(created); sessionId = created.id }
        commentMode = false; pushJS(DesignCommand.commentModeJS(false))
    }

    // MARK: hand-off
    private func handoff() async {
        guard let id = activeId else { return }
        handoffOpen = false
        if let proj = try? await env.client.call("copyDesignToCode", ["id": id, "name": handoffName.trimmed], as: Project.self) {
            _ = proj
            env.route = .codespace   // the new coding project appears in the gallery
        }
    }
}
