import SwiftUI
import Observation

private struct SendChatResult: Decodable { let session: ChatSession; let job: Job }

/// The conversation for ONE {project, session}: its turns (jobs), live streaming via the `job`
/// event stream, send (lazy-creates a session on first send), and cancel.
@Observable
@MainActor
final class ChatThreadStore {
    var turns: [Job] = []
    var sessionId: String?
    var loading = false
    var sendError: String?

    let projectId: String
    private let client: MaestroClient
    private var token: Int?

    init(projectId: String, client: MaestroClient) {
        self.projectId = projectId
        self.client = client
    }

    var streaming: Bool { turns.contains { $0.isRunning } }

    func start() {
        if token == nil {
            token = client.onEvent { [weak self] ev in
                guard ev.name == "job", let job = decodeJSON(ev.data, as: Job.self) else { return }
                Task { @MainActor in self?.onJob(job) }
            }
        }
    }
    func stop() { if let t = token { client.removeHandler(t); token = nil } }

    /// Switch the thread to a session (nil = a fresh, not-yet-created chat). Renders cached turns
    /// instantly (preloaded on hover) and refreshes in the background — so opening a chat feels instant.
    func bind(_ sessionId: String?) async {
        self.sessionId = sessionId
        guard let sid = sessionId else { turns = []; loading = false; return }
        if let cached = TranscriptCache.shared.cached(sid) { turns = cached; loading = false }
        else { turns = []; loading = true }
        do {
            let fresh = try await client.call("listJobs", ["projectId": projectId, "sessionId": sid], as: [Job].self).sorted { $0.createdAt < $1.createdAt }
            if self.sessionId == sid {           // ignore a stale fetch if we've since rebound
                turns = fresh
                TranscriptCache.shared.put(sid, fresh)
            }
        } catch { /* keep cached/empty */ }
        loading = false
    }

    private func onJob(_ job: Job) {
        guard job.sessionId == sessionId, sessionId != nil else { return }
        upsert(job)
    }

    private func upsert(_ job: Job) {
        if let i = turns.firstIndex(where: { $0.id == job.id }) { turns[i] = job }
        else { turns.append(job) }
        turns.sort { $0.createdAt < $1.createdAt }
        if let sid = sessionId { TranscriptCache.shared.put(sid, turns) }   // keep the cache warm for re-open
    }

    /// Send a message. Lazily creates the session on the first send and reports it back so the
    /// rail can add + select it.
    func send(_ text: String, effort: String = "balanced", plan: Bool = false, goal: Bool = false,
              modelKey: String = "auto", base: String? = nil, onSessionCreated: @escaping (ChatSession) -> Void) async {
        sendError = nil
        var params: [String: Any] = ["projectId": projectId, "text": text, "effort": effort, "plan": plan, "goal": goal]
        if modelKey != "auto" { params["modelKey"] = modelKey }
        if let sid = sessionId { params["sessionId"] = sid }
        // Fork the new worktree from a non-default base only on the first send (session creation).
        else if let base, !base.isEmpty { params["base"] = base }
        do {
            let r = try await client.call("sendChat", params, as: SendChatResult.self)
            if sessionId == nil { sessionId = r.session.id; onSessionCreated(r.session) }
            upsert(r.job)
        } catch {
            sendError = (error as? RPCError)?.errorDescription ?? error.localizedDescription
        }
    }

    func cancel(_ job: Job) async {
        try? await client.callVoid("cancelJob", ["id": job.id])
    }

    /// Per-session run modes (need a session to exist).
    func setAutopilot(_ on: Bool) async { guard let sid = sessionId else { return }; try? await client.callVoid("setSessionAutopilot", ["id": sid, "enabled": on]) }
    func setReviewer(_ on: Bool) async { guard let sid = sessionId else { return }; try? await client.callVoid("setSessionReviewer", ["id": sid, "enabled": on]) }

    /// Answer the pending AskUserQuestion for this session (resumes the run).
    func answer(_ text: String) async {
        guard let sid = sessionId, !text.trimmed.isEmpty else { return }
        try? await client.callVoid("answerQuestion", ["sessionId": sid, "answer": text])
    }
}
