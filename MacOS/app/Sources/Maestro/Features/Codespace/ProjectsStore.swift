import SwiftUI
import Observation

@Observable
@MainActor
final class ProjectsStore {
    var projects: [Project] = []
    var loading = true
    var error: String?
    var showHidden = false

    private let client: MaestroClient
    private var subscribed = false

    init(client: MaestroClient) { self.client = client }

    var visible: [Project] { showHidden ? projects : projects.filter { $0.hidden != true } }
    var hiddenCount: Int { projects.filter { $0.hidden == true }.count }

    func load() async {
        if !subscribed {
            subscribed = true
            client.onEvent { [weak self] ev in
                if ev.name == "project" || ev.name == "clone" { Task { @MainActor in await self?.reload() } }
            }
        }
        await reload()
    }

    func reload() async {
        do {
            projects = try await client.call("listProjects", as: [Project].self)
            error = nil
        } catch {
            self.error = (error as? RPCError)?.errorDescription ?? error.localizedDescription
        }
        loading = false
    }

    // MARK: mutations (optimistic + persisted)

    func setHidden(_ project: Project, _ hidden: Bool) async {
        if let i = projects.firstIndex(of: project) { projects[i].hidden = hidden }
        // updateProject patch fields are top-level params; `id` identifies the project.
        try? await client.callVoid("updateProject", ["id": project.id, "hidden": hidden])
    }

    func delete(_ project: Project) async {
        projects.removeAll { $0.id == project.id }
        try? await client.callVoid("deleteProject", ["id": project.id])
    }
}

/// Deterministic project tint (mirrors `project-color.ts` palette).
enum ProjectColor {
    static func color(_ name: String?) -> Color {
        switch name {
        case "blue": return Tok.blue
        case "green": return Tok.green
        case "purple": return Tok.purple
        case "orange": return Tok.orange
        case "teal": return Tok.teal
        case "indigo": return Tok.indigo
        case "red": return Tok.red
        default: return Tok.blue
        }
    }
    /// Template → tint (code=blue, design=teal, content=purple, research=indigo).
    static func template(_ kind: String?) -> Color {
        switch kind {
        case "design": return Tok.teal
        case "content": return Tok.purple
        case "research": return Tok.indigo
        default: return Tok.blue
        }
    }
}
