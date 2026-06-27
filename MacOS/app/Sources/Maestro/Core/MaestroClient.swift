import Foundation
import Observation

struct SidecarEndpoint: Sendable { let port: Int; let token: String }

enum RPCError: Error, LocalizedError {
    case notConnected
    case server(String, Int)
    case decode(String)
    var errorDescription: String? {
        switch self {
        case .notConnected: return "Not connected to the Maestro engine."
        case .server(let m, let s): return "\(m) (\(s))"
        case .decode(let m): return "Decode failed: \(m)"
        }
    }
}

/// The entire bridge between SwiftUI and the headless Node brain. Mirrors `window.maestro`:
/// `call(method, params)` request/response over a token-gated loopback WebSocket, plus an
/// event stream that fans `maestro:event` pushes out to subscribers. Wire protocol:
///   →  {"t":"call","id":N,"method":"…","params":{…}}
///   ←  {"t":"res","id":N,"ok":true,"data":…}  /  {"ok":false,"error":"…","status":N}
///   ←  {"t":"event","name":"…","data":…}
@Observable
@MainActor
final class MaestroClient {
    enum State: Equatable { case idle, connecting, connected, failed(String) }
    private(set) var state: State = .idle

    private var task: URLSessionWebSocketTask?
    private var nextId = 1
    private var pending: [Int: CheckedContinuation<Data, Error>] = [:]
    private var eventHandlers: [Int: (MaestroEvent) -> Void] = [:]
    private var nextHandlerId = 1
    private let session = URLSession(configuration: .ephemeral)

    /// Subscribe to server-pushed events. Returns a token; pass it to `removeHandler` to stop
    /// (per-screen stores unsubscribe on disappear so handlers don't accumulate).
    @discardableResult
    func onEvent(_ handler: @escaping (MaestroEvent) -> Void) -> Int {
        let id = nextHandlerId; nextHandlerId += 1
        eventHandlers[id] = handler
        return id
    }
    func removeHandler(_ id: Int) { eventHandlers.removeValue(forKey: id) }

    func connect(_ ep: SidecarEndpoint) {
        disconnect()
        state = .connecting
        var req = URLRequest(url: URL(string: "ws://127.0.0.1:\(ep.port)")!)
        req.setValue(ep.token, forHTTPHeaderField: "x-maestro-token")
        let t = session.webSocketTask(with: req)
        task = t
        t.resume()
        state = .connected
        receiveLoop()
    }

    func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        for (_, c) in pending { c.resume(throwing: RPCError.notConnected) }
        pending.removeAll()
    }

    /// Decoded request/response. Throws `RPCError` on failure.
    func call<T: Decodable>(_ method: String, _ params: [String: Any] = [:], as: T.Type = T.self) async throws -> T {
        let data = try await callRaw(method, params)
        do { return try JSONDecoder().decode(T.self, from: data) }
        catch { throw RPCError.decode("\(method): \(error)") }
    }

    /// Fire-and-decode where the caller just needs success.
    @discardableResult
    func callVoid(_ method: String, _ params: [String: Any] = [:]) async throws -> Bool {
        _ = try await callRaw(method, params); return true
    }

    func callRaw(_ method: String, _ params: [String: Any]) async throws -> Data {
        // The first screen can issue calls before the sidecar WS has finished connecting — give it
        // a short grace period rather than failing instantly (fixes "empty on first load").
        if task == nil {
            for _ in 0..<200 {
                try? await Task.sleep(for: .milliseconds(50))
                if task != nil { break }
            }
        }
        guard let task else { throw RPCError.notConnected }
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

    private func receiveLoop() {
        task?.receive { [weak self] result in
            Task { @MainActor in
                guard let self else { return }
                switch result {
                case .failure(let err):
                    self.state = .failed(err.localizedDescription)
                    for (_, c) in self.pending { c.resume(throwing: err) }
                    self.pending.removeAll()
                case .success(let msg):
                    self.handle(msg)
                    self.receiveLoop()
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
