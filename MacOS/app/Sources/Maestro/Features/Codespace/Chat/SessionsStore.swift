import SwiftUI
import Observation

/// A project's chat sessions: list + lifecycle (create/rename/archive/delete/pin), kept live via
/// the `session` event stream. Mirrors the ChatPane rail's data ownership.
@Observable
@MainActor
final class SessionsStore {
    var sessions: [ChatSession] = []
    var loading = true
    let projectId: String

    private let client: MaestroClient
    private var token: Int?

    init(projectId: String, client: MaestroClient) {
        self.projectId = projectId
        self.client = client
    }

    var active: [ChatSession] { sessions.filter { !$0.isArchived }.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) } }
    var archived: [ChatSession] { sessions.filter { $0.isArchived } }

    func start() async {
        if token == nil {
            token = client.onEvent { [weak self] ev in
                guard ev.name == "session" else { return }
                Task { @MainActor in self?.applySessionEvent(ev.data) }
            }
        }
        await load()
    }
    func stop() { if let t = token { client.removeHandler(t); token = nil } }

    func load() async {
        do { sessions = try await client.call("listSessions", ["projectId": projectId], as: [ChatSession].self) }
        catch { /* keep last */ }
        loading = false
    }

    private func applySessionEvent(_ data: Any?) {
        guard let s = decodeJSON(data, as: ChatSession.self), s.projectId == projectId else { return }
        if asDict(data)?["deleted"] as? Bool == true {
            sessions.removeAll { $0.id == s.id }
        } else if let i = sessions.firstIndex(where: { $0.id == s.id }) {
            sessions[i] = s
        } else {
            sessions.append(s)
        }
    }

    @discardableResult
    func create() async -> ChatSession? {
        guard let s = try? await client.call("createSession", ["projectId": projectId], as: ChatSession.self) else { return nil }
        if !sessions.contains(where: { $0.id == s.id }) { sessions.append(s) }
        return s
    }

    func rename(_ session: ChatSession, _ title: String) async {
        if let i = sessions.firstIndex(of: session) { sessions[i].title = title }
        try? await client.callVoid("renameSession", ["id": session.id, "title": title])
    }

    func setArchived(_ session: ChatSession, _ archived: Bool) async {
        if let i = sessions.firstIndex(of: session) {
            sessions[i].archived = archived ? Date().timeIntervalSince1970 * 1000 : nil
        }
        try? await client.callVoid("archiveSession", ["id": session.id, "archived": archived])
    }

    func delete(_ session: ChatSession) async {
        sessions.removeAll { $0.id == session.id }
        try? await client.callVoid("deleteSession", ["id": session.id])
    }

    func upsert(_ session: ChatSession) {
        if let i = sessions.firstIndex(where: { $0.id == session.id }) { sessions[i] = session }
        else { sessions.append(session) }
    }
}
