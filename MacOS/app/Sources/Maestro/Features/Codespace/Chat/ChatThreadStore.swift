import SwiftUI
import Observation

private struct SendChatResult: Decodable { let session: ChatSession; let job: Job }
private struct SteerResult: Decodable { let steered: Bool }

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

    /// A turn is live. NOTE: a ScheduleWakeup pause keeps `status == "running"` (the SDK iterator
    /// stays open), so a paused turn IS still streaming — the composer queue must hold behind it.
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
            // Only the bind that still owns the session may write turns OR clear loading — a
            // superseded fetch resolving late must not flip a newer bind's loading flag off (that
            // flashed the empty "What should we build?" state on an existing, still-loading chat).
            if self.sessionId == sid {
                turns = fresh
                TranscriptCache.shared.put(sid, fresh)
                loading = false
            }
        } catch {
            if self.sessionId == sid { loading = false }   // failed fetch on the current session
        }
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
              modelKey: String = "auto", reviewerKey: String? = nil, base: String? = nil,
              attachments: [ComposerAttachment] = [],
              onSessionCreated: @escaping (ChatSession) -> Void) async {
        sendError = nil
        // Each chip already sits inline in `text` as its `«attach:<id>»` marker (the brain rewrites it
        // to an inline `@<absPath>` and strips it from the rail title). Append only any marker that's
        // somehow missing, so attachments are never lost but inline ones aren't duplicated.
        var finalText = text
        let missing = attachments.filter { !text.contains("«attach:\($0.id)»") }
        if !missing.isEmpty {
            let marks = missing.map { "«attach:\($0.id)»" }.joined(separator: " ")
            finalText = finalText.isEmpty ? marks : finalText + " " + marks
        }
        var params: [String: Any] = ["projectId": projectId, "text": finalText, "effort": effort, "plan": plan, "goal": goal]
        let images = attachments.filter { $0.kind == .image }
        let files = attachments.filter { $0.kind != .image }
        if !images.isEmpty {
            params["images"] = images.map { ["id": $0.id, "name": $0.name, "mime": $0.mime, "dataB64": $0.dataB64] }
        }
        if !files.isEmpty {
            params["files"] = files.map { a -> [String: Any] in
                a.kind == .text
                    ? ["id": a.id, "name": a.name, "kind": "text", "content": a.content]
                    : ["id": a.id, "name": a.name, "kind": "file", "mime": a.mime, "dataB64": a.dataB64]
            }
        }
        if modelKey != "auto" { params["modelKey"] = modelKey }
        if let reviewerKey, !reviewerKey.isEmpty { params["reviewerKey"] = reviewerKey }
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

    /// Steer a running turn: inject `text` into the LIVE Claude session (the brain
    /// interrupts the current turn and the agent picks the message up at the next
    /// boundary) instead of cancelling + reseeding — same session, full context kept.
    /// Returns false when the turn already settled or isn't steerable, so the caller
    /// falls back to a normal send.
    func steer(_ job: Job, text: String) async -> Bool {
        let t = text.trimmed
        guard !t.isEmpty else { return false }
        do { return try await client.call("steerJob", ["id": job.id, "text": t], as: SteerResult.self).steered }
        catch { return false }
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
