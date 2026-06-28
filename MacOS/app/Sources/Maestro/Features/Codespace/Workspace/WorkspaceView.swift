import SwiftUI
import AppKit

/// CodeSpace — the VS-Code-style workspace: project→chat tree (sidebar) + open-chat tabs + the
/// active chat/hub in the main pane. Replaces the old gallery → detail-page model.
struct WorkspaceView: View {
    @Environment(AppEnv.self) private var env
    @State private var creating = false
    @AppStorage("maestro.workspace.sidebar.w") private var sidebarWidth: Double = 244
    @State private var dragBase: Double?

    var body: some View {
        Group {
            if let store = env.workspace {
                HStack(spacing: 0) {
                    WorkspaceSidebar(store: store, width: CGFloat(sidebarWidth), onAddProject: { creating = true })
                    splitter
                    VStack(spacing: 0) {
                        tabBar(store)
                        main(store)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    // VS Code-style right panel — file tree + Edited/Checks + command dock.
                    if let pid = store.activeProjectId, let p = store.project(pid)?.path, !p.isEmpty {
                        WorkspaceRightSidebar(store: store)
                    }
                }
            } else {
                Spinner(size: 20).tint(Tok.inkTertiary).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .sheet(isPresented: $creating) {
            CreateProjectSheet { id in
                Task {
                    await env.workspace?.loadProjects()
                    env.workspace?.switchToProject(id); env.workspace?.expanded.insert(id); env.workspace?.newChat(id)
                }
            }.environment(env)
        }
    }

    private var splitter: some View {
        Rectangle().fill(Color.clear).frame(width: 5)
            .overlay(Tok.separator.frame(width: Tok.hairline))
            .contentShape(Rectangle())
            .onHover { inside in if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() } }
            .gesture(
                DragGesture()
                    .onChanged { v in
                        let base = dragBase ?? sidebarWidth
                        if dragBase == nil { dragBase = sidebarWidth }
                        sidebarWidth = min(440, max(200, base + Double(v.translation.width)))
                    }
                    .onEnded { _ in dragBase = nil }
            )
    }

    // MARK: tab bar
    private func tabBar(_ store: WorkspaceStore) -> some View {
        HStack(spacing: 0) {
            if store.visibleTabs.isEmpty {
                Text(store.activeProjectId != nil
                     ? "No tabs open in \(store.project(store.activeProjectId!)?.name ?? "this project") — click a chat in the sidebar."
                     : "Pick a project on the left.")
                    .font(TokFont.text(TokFont.caption, .medium)).foregroundStyle(Tok.inkTertiary)
                    .padding(.horizontal, 14).frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 0) { ForEach(store.visibleTabs) { tabPill($0, store) } }
                }
            }
            Button { store.newChat(store.activeProjectId ?? store.projects.first?.id ?? "") } label: {
                Icon(name: "plus", size: 15, weight: .bold).foregroundStyle(Tok.inkSecondary)
                    .frame(width: 34, height: 34).hoverFill(Tok.fillSecondary, radius: 0)
                    .overlay(alignment: .leading) { Tok.separator.frame(width: Tok.hairline) }
            }.pressable().disabled(store.projects.isEmpty)
        }
        .frame(height: 34)
        .background(Tok.bgGrouped)
        .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }
    }

    private func tabPill(_ tab: WorkTab, _ store: WorkspaceStore) -> some View {
        let on = store.activeKey == tab.id
        let tint = ProjectColor.template(store.project(tab.projectId)?.kind)
        return HStack(spacing: 6) {
            if tab.kind == .file {
                Image(systemName: ToolViz.fileSymbol(tab.title))
                    .font(.system(size: 11.5, weight: .medium))
                    .foregroundStyle(ToolViz.extColor(tab.title))
                    .frame(width: 12, height: 12)
            } else {
                Icon(name: tab.kind == .project ? "folder" : "chat", size: 12).foregroundStyle(tint)
            }
            Text(tab.title).font(TokFont.text(TokFont.caption, on ? .semibold : .medium))
                .foregroundStyle(on ? Tok.ink : Tok.inkSecondary).lineLimit(1)
            // Un-sent new chat off a non-default branch shows its base, e.g. "New chat · feature-x".
            if tab.sessionId == nil, let base = tab.base, !base.isEmpty {
                Text("· \(base)").font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1)
            }
            Button { store.closeTab(tab.id) } label: { Icon(name: "x", size: 10, weight: .bold).foregroundStyle(Tok.inkTertiary).frame(width: 16, height: 16).hoverFill(Tok.fillSecondary, radius: 5) }.pressable()
        }
        .padding(.leading, 11).padding(.trailing, 6)
        .frame(maxWidth: 200).frame(height: 34)
        .background(on ? Tok.bgElevated : .clear)
        .hoverFill(on ? .clear : Tok.fillTertiary, radius: 0)
        .overlay(alignment: .top) { if on { tint.frame(height: 2) } }
        .overlay(alignment: .trailing) { Tok.separator.frame(width: Tok.hairline) }
        .contentShape(Rectangle())
        .onTapGesture { store.activeKey = tab.id }
    }

    // MARK: main — chat tabs kept mounted (continuity), project hub, empty state
    private func main(_ store: WorkspaceStore) -> some View {
        ZStack {
            Tok.bgElevated
            ForEach(store.tabs.filter { $0.kind == .chat && $0.projectId == store.activeProjectId }) { tab in
                ChatThread(projectId: tab.projectId, projectName: store.project(tab.projectId)?.name ?? "",
                           sessionId: sessionBinding(store, tab), base: tab.base, flush: true, active: store.activeKey == tab.id,
                           onSessionCreated: { store.bindCreatedSession(tabKey: tab.id, session: $0) },
                           onOpenFile: { store.openFile($0, projectId: tab.projectId) })
                    .opacity(store.activeKey == tab.id ? 1 : 0)
                    .allowsHitTesting(store.activeKey == tab.id)
            }
            if let t = store.activeTab, t.kind == .project, let p = store.project(t.projectId) {
                ProjectPanel(project: p, section: sectionBinding(store, t), onClose: { store.closeTab(t.id) })
                    .background(Tok.bg)
                    .transition(.opacity)
            }
            if let t = store.activeTab, t.kind == .file, let p = t.filePath {
                FileViewer(projectId: t.projectId, path: p)
                    .transition(.opacity)
            }
            if store.activeTab == nil { emptyState(store).transition(.opacity) }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.smooth(duration: 0.2), value: store.activeKey)
    }

    private func emptyState(_ store: WorkspaceStore) -> some View {
        VStack(spacing: 14) {
            Icon(name: "terminal", size: 26).foregroundStyle(.white).frame(width: 56, height: 56)
                .background(LinearGradient(colors: [Tok.blue, Tok.purple], startPoint: .topLeading, endPoint: .bottomTrailing))
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            Text("Open a chat to start coding").font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
            Text("Pick a project on the left and start a chat — keep several open as tabs and jump between them.")
                .font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary).multilineTextAlignment(.center).frame(maxWidth: 420)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func sessionBinding(_ store: WorkspaceStore, _ tab: WorkTab) -> Binding<String?> {
        Binding(get: { store.tabs.first { $0.id == tab.id }?.sessionId },
                set: { v in if let i = store.tabs.firstIndex(where: { $0.id == tab.id }) { store.tabs[i].sessionId = v } })
    }
    private func sectionBinding(_ store: WorkspaceStore, _ tab: WorkTab) -> Binding<ProjectSection> {
        Binding(get: { store.tabs.first { $0.id == tab.id }?.section ?? .settings },
                set: { v in if let i = store.tabs.firstIndex(where: { $0.id == tab.id }) { store.tabs[i].section = v } })
    }
}
