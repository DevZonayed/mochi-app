import Foundation
import Observation

/// Launches + supervises the headless Node "brain" (`maestro-sidecar`). Reads the JSON
/// handshake the sidecar prints on stdout (`{"ready":true,"port":N,"token":"…"}`), hands the
/// endpoint to `MaestroClient`, restarts on crash, and tears down on app quit.
///
/// Binary resolution order:
///   1. `MAESTRO_SIDECAR` env override (dev),
///   2. `<.app>/Contents/Resources/maestro-sidecar` (packaged SEA binary),
///   3. `MacOS/sidecar/src/headless-main.ts` run via `node --import register.mjs` (dev — runs
///      the brain's TypeScript directly through Node's native type-stripping; no build step).
@Observable
@MainActor
final class SidecarSupervisor {
    enum Status: Equatable { case stopped, starting, running(SidecarEndpoint), failed(String)
        static func == (l: Status, r: Status) -> Bool {
            switch (l, r) {
            case (.stopped, .stopped), (.starting, .starting): return true
            case let (.running(a), .running(b)): return a.port == b.port
            case let (.failed(a), .failed(b)): return a == b
            default: return false
            }
        }
    }
    private(set) var status: Status = .stopped
    private(set) var endpoint: SidecarEndpoint?

    /// Base URL for the sidecar's plain-HTTP routes (design live-preview). nil until running.
    var httpBase: String? { endpoint.map { "http://127.0.0.1:\($0.port)" } }

    private var process: Process?
    private let client: MaestroClient
    /// True only while an intentional `stop()` is in flight, so `onExit` can tell a
    /// deliberate teardown (app quit) from a crash that should auto-restart.
    private var stopping = false
    private var restartAttempts = 0
    private var restartTask: Task<Void, Never>?
    init(client: MaestroClient) { self.client = client }

    func start() {
        guard process == nil else { return }
        stopping = false
        restartTask?.cancel(); restartTask = nil
        status = .starting
        guard let launch = resolveLaunch() else {
            status = .failed("sidecar binary not found — run `pnpm --dir MacOS/sidecar build` first")
            return
        }
        let p = Process()
        p.executableURL = launch.exec
        p.arguments = launch.args
        var env = ProcessInfo.processInfo.environment
        env["MAESTRO_HEADLESS"] = "1"
        p.environment = env

        let out = Pipe()
        p.standardOutput = out
        p.standardError = Pipe()
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            guard !chunk.isEmpty, let s = String(data: chunk, encoding: .utf8) else { return }
            for line in s.split(separator: "\n") {
                guard let d = line.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                      obj["ready"] as? Bool == true,
                      let port = obj["port"] as? Int, let token = obj["token"] as? String
                else { continue }
                Task { @MainActor [weak self] in self?.onReady(SidecarEndpoint(port: port, token: token)) }
            }
        }
        p.terminationHandler = { [weak self] _ in
            Task { @MainActor [weak self] in self?.onExit() }
        }
        do { try p.run(); process = p }
        catch { status = .failed("spawn failed: \(error.localizedDescription)") }
    }

    func stop() {
        stopping = true
        restartTask?.cancel(); restartTask = nil
        process?.terminate()
        process = nil
        status = .stopped
    }

    private func onReady(_ ep: SidecarEndpoint) {
        endpoint = ep
        status = .running(ep)
        restartAttempts = 0   // a healthy connect resets the backoff for the next crash
        client.connect(ep)
    }

    /// The sidecar process ended. If it was an intentional `stop()`, stay stopped.
    /// Otherwise the engine crashed/was killed — auto-restart with capped backoff so
    /// the app self-heals instead of being stranded at "Not connected" forever.
    private func onExit() {
        client.disconnect()
        process = nil
        endpoint = nil
        if stopping { return }
        let attempt = restartAttempts
        restartAttempts += 1
        let delayMs = min(5000, 250 << min(attempt, 5))  // 250ms,500,1s,2s,4s,5s…
        status = .failed("engine stopped — reconnecting…")
        restartTask?.cancel()
        restartTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(delayMs))
            guard let self, !self.stopping, self.process == nil else { return }
            self.start()
        }
    }

    private struct Launch { let exec: URL; let args: [String] }

    private func resolveLaunch() -> Launch? {
        let fm = FileManager.default
        if let override = ProcessInfo.processInfo.environment["MAESTRO_SIDECAR"], fm.isExecutableFile(atPath: override) {
            return Launch(exec: URL(fileURLWithPath: override), args: [])
        }
        if let res = Bundle.main.resourceURL?.appendingPathComponent("maestro-sidecar"),
           fm.isExecutableFile(atPath: res.path) {
            return Launch(exec: res, args: [])  // SEA single binary
        }
        // Packaged: an embedded esbuild bundle run by an embedded (or system) node.
        if let res = Bundle.main.resourceURL?.appendingPathComponent("sidecar") {
            let bundle = res.appendingPathComponent("maestro-sidecar.mjs")
            if fm.fileExists(atPath: bundle.path) {
                let embeddedNode = res.appendingPathComponent("bin/node")
                // Only trust an embedded node that's a real runtime (a stub/wrapper is useless);
                // else use a downloaded/system node.
                let isReal = fm.isExecutableFile(atPath: embeddedNode.path)
                    && ((try? embeddedNode.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0) > 5_000_000
                if let node = isReal ? embeddedNode : which("node") {
                    return Launch(exec: node, args: [bundle.path])
                }
            }
        }
        // Dev fallback: run the brain's TypeScript entry directly via Node's type-stripping.
        if let root = repoRoot(), let node = which("node") {
            let entry = root.appendingPathComponent("MacOS/sidecar/src/headless-main.ts")
            let register = root.appendingPathComponent("MacOS/sidecar/src/register.mjs")
            if fm.fileExists(atPath: entry.path) {
                return Launch(exec: node, args: ["--import", register.path, entry.path])
            }
        }
        return nil
    }

    /// Walk up from the executable to find the repo root (contains `MacOS/`). Dev-only.
    private func repoRoot() -> URL? {
        var dir = Bundle.main.bundleURL
        for _ in 0..<8 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("MacOS").path) { return dir }
            dir.deleteLastPathComponent()
        }
        return nil
    }

    private func which(_ tool: String) -> URL? {
        let fm = FileManager.default
        var dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        if let path = ProcessInfo.processInfo.environment["PATH"] { dirs += path.split(separator: ":").map(String.init) }
        for d in dirs {
            let c = d + "/" + tool
            if fm.isExecutableFile(atPath: c) { return URL(fileURLWithPath: c) }
        }
        return nil
    }
}
