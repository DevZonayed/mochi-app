import SwiftUI
import Observation

/// One open tab in the CodeSpace workspace — a chat, or a project hub (settings/instructions/…).
struct WorkTab: Identifiable, Hashable {
    enum Kind: Hashable { case chat, project, file }
    let id: String                 // stable key
    var projectId: String
    var sessionId: String?         // chat tab: the session (nil = a fresh, not-yet-created chat)
    var title: String
    var kind: Kind
    var section: ProjectSection?   // project tab: which hub section
    var filePath: String?          // file tab: absolute path shown in the preview pane
}

enum ProjectSection: String, CaseIterable { case instructions = "Instructions", skills = "Skills & tools", settings = "Settings" }

enum KindFilter: String, CaseIterable {
    case all, code, design, content, research
    var label: String { self == .all ? "All" : rawValue.capitalized }
    var icon: String {
        switch self { case .all: "layers"; case .code: "terminal"; case .design: "brush"; case .content: "play"; case .research: "telescope" }
    }
    /// The Project.kind this filter matches.
    var projectKind: String? { self == .all ? nil : (self == .code ? "coding" : rawValue) }
}

/// The CodeSpace workspace state: the project→chat tree, the open-tab strip (project-scoped), and
/// the active tab. Mirrors Workspace.tsx — a VS-Code-style IDE, not a gallery → detail page.
@Observable
@MainActor
final class WorkspaceStore {
    var projects: [Project] = []
    var sessionsByProject: [String: [ChatSession]] = [:]
    var expanded: Set<String> = []
    var archivedOpen: Set<String> = []
    var tabs: [WorkTab] = []
    var activeKey: String?
    var activeProjectId: String?
    var query = ""
    var kind: KindFilter = .all
    var showHidden = false
    var loading = true

    private let client: MaestroClient
    private var tokens: [Int] = []

    init(client: MaestroClient) { self.client = client }

    // MARK: derived
    /// CodeSpace scope: coding projects only — design projects live in the Design workspace.
    var codeProjects: [Project] { projects.filter { $0.kind != "design" } }
    var visibleProjects: [Project] {
        codeProjects.filter { p in
            (showHidden || p.hidden != true)
            && (kind.projectKind == nil || (p.kind ?? "coding") == kind.projectKind)
            && (query.isEmpty || p.name.localizedCaseInsensitiveContains(query) || (sessionsByProject[p.id] ?? []).contains { ($0.title ?? "").localizedCaseInsensitiveContains(query) })
        }
    }
    var hiddenCount: Int { codeProjects.filter { $0.hidden == true }.count }
    var visibleTabs: [WorkTab] { tabs.filter { $0.projectId == activeProjectId } }
    var activeTab: WorkTab? { tabs.first { $0.id == activeKey } }
    func activeSessions(_ pid: String) -> [ChatSession] { (sessionsByProject[pid] ?? []).filter { !$0.isArchived } }
    func archivedSessions(_ pid: String) -> [ChatSession] { (sessionsByProject[pid] ?? []).filter { $0.isArchived } }
    func kindCount(_ k: KindFilter) -> Int { k == .all ? codeProjects.count : codeProjects.filter { ($0.kind ?? "coding") == k.projectKind }.count }

    // MARK: drag-reorder
    func moveProject(_ from: String, before to: String) {
        guard from != to,
              let fi = projects.firstIndex(where: { $0.id == from }),
              let ti = projects.firstIndex(where: { $0.id == to }) else { return }
        let moved = projects.remove(at: fi)
        let insertAt = projects.firstIndex(where: { $0.id == to }) ?? ti
        projects.insert(moved, at: insertAt)
        Task { try? await client.callVoid("reorderProjects", ["ids": projects.map(\.id)]) }
    }
    func project(_ id: String) -> Project? { projects.first { $0.id == id } }

    // MARK: lifecycle
    func start() async {
        if tokens.isEmpty {
            tokens.append(client.onEvent { [weak self] ev in
                guard let self else { return }
                switch ev.name {
                case "project", "clone": Task { @MainActor in await self.loadProjects() }
                case "session": Task { @MainActor in self.applySession(ev.data) }
                default: break
                }
            })
        }
        await loadProjects()
        if activeProjectId == nil { activeProjectId = visibleProjects.first?.id }
        if let pid = activeProjectId { expanded.insert(pid); await loadSessions(pid) }
    }
    func stop() { for t in tokens { client.removeHandler(t) }; tokens = [] }

    func loadProjects() async {
        projects = (try? await client.call("listProjects", as: [Project].self)) ?? projects
        loading = false
    }
    func loadSessions(_ pid: String) async {
        sessionsByProject[pid] = (try? await client.call("listSessions", ["projectId": pid], as: [ChatSession].self)) ?? []
    }
    private func applySession(_ data: Any?) {
        guard let s = decodeJSON(data, as: ChatSession.self), let pid = s.projectId else { return }
        var list = sessionsByProject[pid] ?? []
        if asDict(data)?["deleted"] as? Bool == true { list.removeAll { $0.id == s.id } }
        else if let i = list.firstIndex(where: { $0.id == s.id }) { list[i] = s } else { list.append(s) }
        sessionsByProject[pid] = list
        if let i = tabs.firstIndex(where: { $0.sessionId == s.id }) { tabs[i].title = s.displayTitle }   // keep tab title fresh
    }

    // MARK: tree
    func toggleExpand(_ pid: String) {
        if expanded.contains(pid) { expanded.remove(pid) }
        else { expanded.insert(pid); if sessionsByProject[pid] == nil { Task { await loadSessions(pid) } } }
    }
    func switchToProject(_ pid: String) {
        activeProjectId = pid
        if sessionsByProject[pid] == nil { Task { await loadSessions(pid) } }
        // restore this project's last tab if any
        activeKey = tabs.last { $0.projectId == pid }?.id
    }

    // MARK: tabs
    func openChat(_ s: ChatSession) {
        activeProjectId = s.projectId
        if let existing = tabs.first(where: { $0.sessionId == s.id }) { activeKey = existing.id; return }
        let tab = WorkTab(id: "chat:\(s.id)", projectId: s.projectId ?? "", sessionId: s.id, title: s.displayTitle, kind: .chat, section: nil, filePath: nil)
        tabs.append(tab); activeKey = tab.id
    }
    func newChat(_ pid: String) {
        guard !pid.isEmpty else { return }
        activeProjectId = pid
        let tab = WorkTab(id: "new:\(pid):\(tabs.count)", projectId: pid, sessionId: nil, title: "New chat", kind: .chat, section: nil, filePath: nil)
        tabs.append(tab); activeKey = tab.id
    }
    func openProjectPanel(_ pid: String, _ section: ProjectSection) {
        activeProjectId = pid
        let key = "project:\(pid)"
        if let i = tabs.firstIndex(where: { $0.id == key }) { tabs[i].section = section; activeKey = key; return }
        let tab = WorkTab(id: key, projectId: pid, sessionId: nil, title: project(pid)?.name ?? "Project", kind: .project, section: section, filePath: nil)
        tabs.append(tab); activeKey = key
    }
    func openFile(_ path: String, projectId pid: String? = nil) {
        let abs = path.hasPrefix("~") ? (path as NSString).expandingTildeInPath : path
        guard abs.hasPrefix("/") else { return }
        let key = "file:\(abs)"
        if let existing = tabs.first(where: { $0.id == key }) {
            activeProjectId = existing.projectId
            activeKey = key
            return
        }
        let owner = pid ?? activeProjectId ?? projects.first?.id ?? "files"
        activeProjectId = owner
        let tab = WorkTab(id: key, projectId: owner, sessionId: nil, title: URL(fileURLWithPath: abs).lastPathComponent, kind: .file, section: nil, filePath: abs)
        tabs.append(tab); activeKey = key
    }
    func closeTab(_ key: String) {
        guard let idx = tabs.firstIndex(where: { $0.id == key }) else { return }
        let wasActive = activeKey == key
        let pid = tabs[idx].projectId
        tabs.remove(at: idx)
        if wasActive { activeKey = tabs.last { $0.projectId == pid }?.id }
    }
    /// Called when a fresh chat tab's session is lazily created on first send.
    func bindCreatedSession(tabKey: String, session: ChatSession) {
        if let i = tabs.firstIndex(where: { $0.id == tabKey }) {
            tabs[i].sessionId = session.id
            tabs[i].title = session.displayTitle
        }
        if let pid = session.projectId {
            var list = sessionsByProject[pid] ?? []
            if !list.contains(where: { $0.id == session.id }) { list.insert(session, at: 0) }
            sessionsByProject[pid] = list
        }
    }

    // MARK: session ops (from the tree)
    func rename(_ s: ChatSession, _ title: String) async { try? await client.callVoid("renameSession", ["id": s.id, "title": title]) }
    func setArchived(_ s: ChatSession, _ archived: Bool) async { try? await client.callVoid("archiveSession", ["id": s.id, "archived": archived]) }
    func delete(_ s: ChatSession) async {
        tabs.removeAll { $0.sessionId == s.id }
        try? await client.callVoid("deleteSession", ["id": s.id])
    }
}
