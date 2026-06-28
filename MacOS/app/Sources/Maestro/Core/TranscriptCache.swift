import Foundation
import Observation

/// A small process-wide LRU cache of session transcripts (jobs). It makes opening a chat feel
/// instant: the sidebar prefetches a session's jobs on hover, and `ChatThreadStore.bind` renders
/// the cached turns immediately (no spinner) while it refreshes in the background.
@MainActor
final class TranscriptCache {
    static let shared = TranscriptCache()

    private var store: [String: [Job]] = [:]
    private var order: [String] = []        // LRU — most-recently-touched at the end
    private var inflight: Set<String> = []
    private let limit = 12                   // transcripts can be large; cap memory

    /// Cached turns for a session, or nil.
    func cached(_ sid: String) -> [Job]? { store[sid] }

    /// Store (and bump LRU) the turns for a session.
    func put(_ sid: String, _ jobs: [Job]) {
        store[sid] = jobs
        touch(sid)
        evictIfNeeded()
    }

    /// Fetch + cache a session's jobs ahead of time (e.g. on sidebar hover). No-op if already
    /// cached or a fetch is in flight.
    func prefetch(_ sid: String, projectId: String, client: MaestroClient) {
        guard store[sid] == nil, !inflight.contains(sid) else { return }
        inflight.insert(sid)
        Task { @MainActor in
            defer { inflight.remove(sid) }
            if let jobs = try? await client.call("listJobs", ["projectId": projectId, "sessionId": sid], as: [Job].self) {
                put(sid, jobs.sorted { $0.createdAt < $1.createdAt })
            }
        }
    }

    func invalidate(_ sid: String) { store[sid] = nil; order.removeAll { $0 == sid } }

    private func touch(_ sid: String) {
        order.removeAll { $0 == sid }
        order.append(sid)
    }
    private func evictIfNeeded() {
        while order.count > limit, let oldest = order.first {
            order.removeFirst()
            store[oldest] = nil
        }
    }
}
