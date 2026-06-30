import Foundation
import Observation

struct SidecarEndpoint: Sendable { let port: Int; let token: String }

enum RPCError: Error, LocalizedError {
    /// The engine is terminally unavailable (recovery exhausted / fatal boot). Carries a real
    /// reason (e.g. the sidecar's stderr tail) — replaces the old generic `.notConnected`, which
    /// no longer exists because RPCs now *wait* for the engine instead of failing on startup.
    case engineDown(String)
    case server(String, Int)
    case decode(String)
    var errorDescription: String? {
        switch self {
        case .engineDown(let m): return m.isEmpty ? "The Maestro engine is unavailable." : m
        case .server(let m, let s): return "\(m) (\(s))"
        case .decode(let m): return "Decode failed: \(m)"
        }
    }
}

/// The bridge between SwiftUI and the headless Node brain. Mirrors `window.maestro`:
/// `call(method, params)` request/response over a token-gated loopback WebSocket, plus an event
/// stream that fans `maestro:event` pushes out to subscribers.
///
/// This client does NOT decide on its own when the engine is "connected" — it is half of a unit
/// with `SidecarSupervisor`. Three injected hooks bind them:
///   - `awaitReady`        — every public RPC suspends on this until the engine is `.ready`
///                           (parking through starting/connecting/recovering); throws on `.down`.
///   - `onSocketDown`      — a dead socket (receive error or missed heartbeat) reports up so the
///                           supervisor can reconnect/restart.
///   - `onReadyConfirmed`  — fires after a verified ping round-trip, so the supervisor flips the
///                           shared `engineState` to `.ready` only when the brain truly answers.
///
/// Wire protocol:
///   →  {"t":"call","id":N,"method":"…","params":{…}}
///   ←  {"t":"res","id":N,"ok":true,"data":…}  /  {"ok":false,"error":"…","status":N}
///   ←  {"t":"event","name":"…","data":…}
@Observable
@MainActor
final class MaestroClient {
    var awaitReady: (@MainActor () async throws -> Void)?
    var onSocketDown: (@MainActor () -> Void)?
    var onReadyConfirmed: (@MainActor () -> Void)?

    private var task: URLSessionWebSocketTask?
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var eventHandlers: [Int: (MaestroEvent) -> Void] = [:]
    private var nextHandlerId = 1
    private let session = URLSession(configuration: .ephemeral)
    private var heartbeat: Task<Void, Never>?
    /// Bumped on every connect/disconnect so a stale receive/heartbeat/confirm callback no-ops
    /// instead of acting on a torn-down socket.
    private var generation = 0

    /// Subscribe to server-pushed events. Returns a token; pass it to `removeHandler` to stop.
    @discardableResult
    func onEvent(_ handler: @escaping (MaestroEvent) -> Void) -> Int {
        let id = nextHandlerId; nextHandlerId += 1
        eventHandlers[id] = handler
        return id
    }
    func removeHandler(_ id: Int) { eventHandlers.removeValue(forKey: id) }

    /// Open (or re-open) the loopback WS to `ep`. Does NOT itself declare readiness — it sends an
    /// internal ping and only on the pong calls `onReadyConfirmed`, so the shared state flips to
    /// `.ready` only when the host genuinely answers (fixes the old premature-`.connected` race).
    func connect(_ ep: SidecarEndpoint) {
        disconnect()
        let gen = generation
        var req = URLRequest(url: URL(string: "ws://127.0.0.1:\(ep.port)")!)
        req.setValue(ep.token, forHTTPHeaderField: "x-maestro-token")
        let t = session.webSocketTask(with: req)
        task = t
        t.resume()
        receiveLoop(gen)
        startHeartbeat(gen)
        Task { @MainActor [weak self] in
            guard let self else { return }
            let ok = await self.ping(t, timeout: 5)
            guard gen == self.generation else { return }
            if ok { self.onReadyConfirmed?() } else { self.socketDown() }
        }
    }

    func disconnect() {
        generation &+= 1
        heartbeat?.cancel(); heartbeat = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        let drained = pending; pending.removeAll()
        for (_, c) in drained { c.resume(throwing: RPCError.engineDown("")) }
    }

    /// Decoded request/response. Throws `RPCError` on failure.
    func call<T: Decodable>(_ method: String, _ params: [String: Any] = [:], as: T.Type = T.self) async throws -> T {
        let data = try await callRaw(method, params)
        do {
            return try await Task.detached(priority: .userInitiated) {
                try JSONDecoder().decode(T.self, from: data)
            }.value
        }
        catch { throw RPCError.decode("\(method): \(error)") }
    }

    /// Fire-and-decode where the caller just needs success.
    @discardableResult
    func callVoid(_ method: String, _ params: [String: Any] = [:]) async throws -> Bool {
        _ = try await callRaw(method, params); return true
    }

    /// Public RPC: waits for the engine to be `.ready` (parking through starting/connecting/
    /// recovering), then sends. Only throws `.engineDown` when the engine is terminally down —
    /// never the old 10-second-grace `.notConnected`.
    func callRaw(_ method: String, _ params: [String: Any]) async throws -> Data {
        try await awaitReady?()
        return try await sendRaw(method, params)
    }

    /// Raw send with no readiness gate — used by `callRaw` (after the gate has passed).
    private func sendRaw(_ method: String, _ params: [String: Any]) async throws -> Data {
        guard let task else { throw RPCError.engineDown("") }
        let id = nextId; nextId += 1
        let payload: [String: Any] = ["t": "call", "id": id, "method": method, "params": params]
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try await withCheckedThrowingContinuation { cont in
            pending[id] = cont
            task.send(.data(body)) { [weak self] err in
                if let err { Task { @MainActor in self?.fail(id, err) } }
            }
        }
    }

    private func fail(_ id: Int, _ err: Error) {
        if let c = pending.removeValue(forKey: id) { c.resume(throwing: err) }
    }

    /// A dead socket (receive error or missed heartbeat). Tear down and tell the supervisor so it
    /// can reconnect/restart. `disconnect()` bumps the generation, so any other in-flight callback
    /// for this socket no-ops.
    private func socketDown() {
        disconnect()
        onSocketDown?()
    }

    /// One WS ping with a timeout. Confirms the socket is live AND the host responds (the Node
    /// ws-host pongs at the protocol level), without depending on the brain dispatch.
    private func ping(_ t: URLSessionWebSocketTask, timeout: Double) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
                    t.sendPing { err in c.resume(returning: err == nil) }
                }
            }
            group.addTask {
                try? await Task.sleep(for: .seconds(timeout)); return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
    }

    private func startHeartbeat(_ gen: Int) {
        heartbeat = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(12))
                guard let self, gen == self.generation, let task = self.task else { return }
                let ok = await self.ping(task, timeout: 6)
                guard gen == self.generation else { return }
                if !ok { self.socketDown(); return }
            }
        }
    }

    private func receiveLoop(_ gen: Int) {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self, gen == self.generation else { return }
                switch result {
                case .failure:
                    self.socketDown()
                case .success(let msg):
                    self.handle(msg)
                    self.receiveLoop(gen)
                }
            }
        }
    }

    private func handle(_ msg: URLSessionWebSocketTask.Message) {
        let data: Data
        switch msg {
        case .data(let d): data = d
        case .string(let s): data = Data(s.utf8)
        @unknown default: return
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let t = obj["t"] as? String else { return }
        switch t {
        case "res":
            guard let id = obj["id"] as? Int, let c = pending.removeValue(forKey: id) else { return }
            if (obj["ok"] as? Bool) == true {
                let inner = obj["data"]
                let d = (try? JSONSerialization.data(withJSONObject: inner ?? NSNull())) ?? Data("null".utf8)
                c.resume(returning: d)
            } else {
                let m = (obj["error"] as? String) ?? "request failed"
                let s = (obj["status"] as? Int) ?? 500
                c.resume(throwing: RPCError.server(m, s))
            }
        case "event":
            let name = (obj["name"] as? String) ?? ""
            let ev = MaestroEvent(name: name, data: obj["data"])
            for h in eventHandlers.values { h(ev) }
        default: break
        }
    }
}
