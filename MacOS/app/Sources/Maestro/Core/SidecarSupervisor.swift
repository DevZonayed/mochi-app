import Foundation
import Observation

/// Launches + supervises the headless Node "brain" (`maestro-sidecar`) and owns the single
/// `EngineState` the whole app observes. Together with `MaestroClient` it forms one connection
/// unit whose contract is: a startup race or a crash is invisible and self-healing, never a dead
/// "Not connected". It does this by:
///   - parsing the sidecar's stdout handshake with a cross-chunk line buffer (no lost ready frame),
///   - flipping to `.ready` only after the client confirms a live round-trip,
///   - parking every RPC on `whenReady()` until `.ready` (or failing with a real reason on `.down`),
///   - recovering a dropped socket (WS reconnect → process restart) without surfacing an error,
///   - surfacing the sidecar's stderr so a genuine failure shows *why*, not a generic message.
///
/// Binary resolution order:
///   1. `MAESTRO_SIDECAR` env override (dev),
///   2. `<.app>/Contents/Resources/maestro-sidecar` (packaged SEA binary),
///   3. packaged esbuild bundle run by an embedded/system node,
///   4. `MacOS/sidecar/src/headless-main.ts` via `node --import register.mjs` (dev).
@Observable
@MainActor
final class SidecarSupervisor {
    private(set) var engineState: EngineLink = .starting
    private(set) var endpoint: SidecarEndpoint?

    /// Base URL for the sidecar's plain-HTTP routes (design live-preview). nil until running.
    var httpBase: String? { endpoint.map { "http://127.0.0.1:\($0.port)" } }

    private let client: MaestroClient
    private var process: Process?
    /// True only while an intentional `stop()` is in flight, so recovery paths can tell a
    /// deliberate teardown from a crash that should auto-restart.
    private var stopping = false

    private var restartAttempts = 0      // process-level restarts since the last `.ready`
    private var reconnectAttempts = 0    // WS-level reconnects since the last `.ready`
    private var restartTask: Task<Void, Never>?

    private var readyWaiters: [CheckedContinuation<Void, Error>] = []
    private var stderrTail: [String] = []   // rolling last-N stderr lines, for the `.down` reason
    private var stdoutBuf = Data()          // cross-callback line buffer for the handshake

    private let maxRestarts = 5
    private let maxReconnects = 2

    init(client: MaestroClient) {
        self.client = client
        // Wire the two halves of the connection unit together.
        client.awaitReady = { [weak self] in try await self?.whenReady() }
        client.onSocketDown = { [weak self] in self?.handleSocketDown() }
        client.onReadyConfirmed = { [weak self] in self?.handleReadyConfirmed() }
    }

    // MARK: readiness gate

    /// Suspends until `.ready`; throws `.engineDown(reason)` once `.down`. This is what makes a
    /// pre-ready RPC *wait* instead of failing — the core of "no occurrence like this".
    func whenReady() async throws {
        switch engineState {
        case .ready: return
        case .down(let r): throw RPCError.engineDown(r)
        case .starting, .connecting, .recovering:
            try await withCheckedThrowingContinuation { readyWaiters.append($0) }
        }
    }

    private func setState(_ s: EngineLink) {
        engineState = s
        switch s {
        case .ready:
            let w = readyWaiters; readyWaiters = []
            for c in w { c.resume() }
        case .down(let r):
            let w = readyWaiters; readyWaiters = []
            for c in w { c.resume(throwing: RPCError.engineDown(r)) }
        default:
            break
        }
    }

    // MARK: lifecycle

    func start() {
        guard process == nil else { return }
        stopping = false
        restartTask?.cancel(); restartTask = nil
        setState(.starting)
        guard let launch = resolveLaunch() else {
            fail("Sidecar binary not found — run `pnpm --dir MacOS/sidecar build` first.")
            return
        }
        let p = Process()
        p.executableURL = launch.exec
        p.arguments = launch.args
        var env = ProcessInfo.processInfo.environment
        env["MAESTRO_HEADLESS"] = "1"
        p.environment = env

        let out = Pipe(); p.standardOutput = out
        let errPipe = Pipe(); p.standardError = errPipe
        stdoutBuf = Data()
        out.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            guard !chunk.isEmpty else { return }
            Task { @MainActor [weak self] in self?.onStdout(chunk) }
        }
        // The sidecar's diagnostics live here. Previously this pipe had no reader, so every real
        // error vanished — which is exactly why the failure looked like a single mystery symptom.
        errPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            guard !chunk.isEmpty, let s = String(data: chunk, encoding: .utf8) else { return }
            Task { @MainActor [weak self] in self?.onStderr(s) }
        }
        p.terminationHandler = { [weak self] _ in
            Task { @MainActor [weak self] in self?.onExit() }
        }
        do { try p.run(); process = p }
        catch { fail("spawn failed: \(error.localizedDescription)") }
    }

    func stop() {
        stopping = true
        restartTask?.cancel(); restartTask = nil
        client.disconnect()
        process?.terminate()
        process = nil
        endpoint = nil
        setState(.down("stopped"))
    }

    /// Operator-driven retry from the EngineGate when the engine is terminally `.down`: wipe the
    /// attempt counters and boot fresh.
    func retry() {
        restartAttempts = 0
        reconnectAttempts = 0
        stopping = true
        restartTask?.cancel(); restartTask = nil
        client.disconnect()
        process?.terminate(); process = nil
        endpoint = nil
        stopping = false
        start()
    }

    // MARK: stdout handshake (buffered across chunks)

    private func onStdout(_ chunk: Data) {
        stdoutBuf.append(chunk)
        while let nl = stdoutBuf.firstIndex(of: 0x0A) {
            let line = Data(stdoutBuf[stdoutBuf.startIndex..<nl])
            stdoutBuf = Data(stdoutBuf[stdoutBuf.index(after: nl)...])
            handleStdoutLine(line)
        }
        if stdoutBuf.count > 64_000 { stdoutBuf.removeAll(keepingCapacity: false) }  // junk guard
    }

    private func handleStdoutLine(_ data: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if obj["ready"] as? Bool == true, let port = obj["port"] as? Int, let token = obj["token"] as? String {
            onReady(SidecarEndpoint(port: port, token: token))
        } else if let reason = obj["fatal"] as? String {
            fail("Engine failed to start: \(reason)")
        }
        // {"phase":"starting"} is informational — we are already `.starting`.
    }

    private func onStderr(_ s: String) {
        for line in s.split(separator: "\n", omittingEmptySubsequences: true) {
            stderrTail.append(String(line))
        }
        if stderrTail.count > 50 { stderrTail.removeFirst(stderrTail.count - 50) }
    }

    private func onReady(_ ep: SidecarEndpoint) {
        endpoint = ep
        setState(.connecting)
        client.connect(ep)   // confirms a ping round-trip, then calls handleReadyConfirmed
    }

    private func handleReadyConfirmed() {
        restartAttempts = 0
        reconnectAttempts = 0
        setState(.ready)
    }

    // MARK: recovery — socket dropped, process maybe alive

    /// The client lost its socket (receive error or missed heartbeat). Try a quick WS reconnect to
    /// the same endpoint a couple of times (the process is often still alive); if that keeps
    /// failing, bounce the process. Entirely callback-driven: each failed `connect()` calls back
    /// here, each success lands in `handleReadyConfirmed`.
    private func handleSocketDown() {
        guard !stopping else { return }
        setState(.recovering("connection lost"))
        // A process restart is already in flight (e.g. the socket died because the process
        // crashed) — let that drive us back to `.ready`; don't also hammer the dead endpoint.
        if restartTask != nil { return }
        if let ep = endpoint, reconnectAttempts < maxReconnects {
            reconnectAttempts += 1
            client.connect(ep)
            return
        }
        reconnectAttempts = 0
        restartProcess()
    }

    private func restartProcess() {
        endpoint = nil
        client.disconnect()
        // terminationHandler → onExit drives the backoff restart. If no process is alive, restart now.
        if let p = process { p.terminate() } else { scheduleRestart() }
    }

    /// The sidecar process ended (crash, or our own `restartProcess`/terminate). Recover unless we
    /// deliberately stopped.
    private func onExit() {
        if stopping { return }
        client.disconnect()
        process = nil
        endpoint = nil
        scheduleRestart()
    }

    private func scheduleRestart() {
        guard !stopping, restartTask == nil else { return }
        if restartAttempts >= maxRestarts {
            fail(stderrTail.suffix(8).joined(separator: "\n"))
            return
        }
        let attempt = restartAttempts
        restartAttempts += 1
        let delayMs = min(5000, 250 << min(attempt, 5))  // 250ms,500,1s,2s,4s,5s…
        setState(.recovering("engine stopped — restarting…"))
        restartTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(delayMs))
            guard let self, !self.stopping, self.process == nil else { return }
            self.restartTask = nil
            self.start()
        }
    }

    private func fail(_ reason: String) {
        let r = reason.isEmpty ? "The Maestro engine is unavailable." : reason
        setState(.down(r))
    }

    // MARK: launch resolution (unchanged)

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
