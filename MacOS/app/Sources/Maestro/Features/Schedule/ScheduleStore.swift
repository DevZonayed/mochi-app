import SwiftUI
import Observation

/// Owns the schedule list and its mutations. Mirrors the WhatsAppStore/ProjectsStore lifecycle:
/// subscribe to `schedule` events and reload on any of them (the event arrives in three shapes —
/// full record / `{id,enabled}` / `{id,deleted}` — so a reload is simpler and always correct).
/// User-initiated mutations also update locally first for snappiness.
@Observable
@MainActor
final class ScheduleStore {
    var schedules: [Schedule] = []
    var loading = true
    var error: String?

    private let client: MaestroClient
    private var token: Int?

    init(client: MaestroClient) { self.client = client }

    /// Soonest-first; schedules without a next fire time (disabled/paused) sink to the bottom.
    var sorted: [Schedule] {
        schedules.sorted { a, b in
            let fa = a.nextFireAt ?? .greatestFiniteMagnitude
            let fb = b.nextFireAt ?? .greatestFiniteMagnitude
            return fa == fb ? a.createdAt < b.createdAt : fa < fb
        }
    }

    // MARK: Lifecycle

    func start() async {
        if token == nil {
            token = client.onEvent { [weak self] ev in
                guard ev.name == "schedule" else { return }
                Task { @MainActor in await self?.reload() }
            }
        }
        await reload()
    }

    func stop() { if let t = token { client.removeHandler(t); token = nil } }

    func reload() async {
        do {
            schedules = try await client.call("listSchedules", as: [Schedule].self)
            error = nil
        } catch {
            self.error = message(error)
        }
        loading = false
    }

    // MARK: Mutations

    /// One-shot queued message (composer "Once"). Returns false (and sets `error`) on failure —
    /// e.g. the brain's 30s-floor rejection.
    @discardableResult
    func scheduleMessage(fireAt: Double, prompt: String, sessionId: String?, projectId: String?,
                         effort: String? = nil, plan: Bool = false, goal: Bool = false,
                         browser: Bool = false) async -> Bool {
        var p: [String: Any] = ["fireAt": fireAt, "prompt": prompt, "plan": plan, "goal": goal, "browser": browser]
        if let sessionId { p["sessionId"] = sessionId }
        if let projectId { p["projectId"] = projectId }
        if let effort { p["effort"] = effort }
        do { upsert(try await client.call("scheduleMessage", p, as: Schedule.self)); return true }
        catch { self.error = message(error); return false }
    }

    /// Recurring task (composer "Repeat" or the ScheduleSheet).
    @discardableResult
    func createRecurring(title: String, prompt: String, projectId: String?, sessionId: String?,
                         opts: RepeatOpts, effort: String? = nil) async -> Bool {
        var p: [String: Any] = ["title": title, "prompt": prompt, "catchUp": opts.catchUp]
        if let projectId { p["projectId"] = projectId }
        if let sessionId { p["sessionId"] = sessionId }
        if let m = opts.everyMinutes { p["everyMinutes"] = m }
        if let t = opts.time { p["time"] = t }
        if let c = opts.cadence { p["cadence"] = c }
        if let effort { p["effort"] = effort }
        do { upsert(try await client.call("createSchedule", p, as: Schedule.self)); return true }
        catch { self.error = message(error); return false }
    }

    @discardableResult
    func update(_ id: String, patch: [String: Any]) async -> Bool {
        var p = patch; p["id"] = id
        do { upsert(try await client.call("updateSchedule", p, as: Schedule.self)); return true }
        catch { self.error = message(error); return false }
    }

    func setEnabled(_ schedule: Schedule, _ enabled: Bool) async {
        if let i = schedules.firstIndex(where: { $0.id == schedule.id }) { schedules[i].enabled = enabled }
        try? await client.callVoid("toggleSchedule", ["id": schedule.id, "enabled": enabled])
    }

    func delete(_ id: String) async {
        schedules.removeAll { $0.id == id }
        try? await client.callVoid("deleteSchedule", ["id": id])
    }

    // MARK: Derived

    /// The per-chat one-shot messages the inline composer queue renders.
    func pending(forSession sessionId: String?) -> [Schedule] {
        guard let sessionId else { return [] }
        return sorted.filter { $0.sessionId == sessionId && $0.isQueuedMessage }
    }

    /// Grouped by project for the list view; the "No project" group is last, others keep
    /// soonest-first order of first appearance.
    var byProject: [(projectId: String?, items: [Schedule])] {
        var order: [String?] = []
        var map: [String?: [Schedule]] = [:]
        for s in sorted {
            if map[s.projectId] == nil { order.append(s.projectId) }
            map[s.projectId, default: []].append(s)
        }
        let named = order.filter { $0 != nil }
        let finalOrder = named + (order.contains(where: { $0 == nil }) ? [nil] : [])
        return finalOrder.map { ($0, map[$0] ?? []) }
    }

    private func upsert(_ s: Schedule) {
        if let i = schedules.firstIndex(where: { $0.id == s.id }) { schedules[i] = s } else { schedules.append(s) }
    }
    private func message(_ e: Error) -> String { (e as? RPCError)?.errorDescription ?? e.localizedDescription }
}
