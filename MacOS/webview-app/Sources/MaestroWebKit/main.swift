import AppKit
import Foundation
import Security
import WebKit

/// Release-channel identity, read from the SIGNED Info.plist (written by
/// package-app.sh via resolve-channel.sh). Keeps production / preview /
/// development fully isolated — distinct display name, userData dir, MCP port,
/// runtime dir, and debug log. Every value comes from Info.plist, so a plain
/// Finder launch (no shell env) works. Falls back to production when unset.
enum Channel {
    static let name: String =
        (Bundle.main.object(forInfoDictionaryKey: "MaestroChannel") as? String) ?? "production"

    /// `@maestro/<subdir>` — MUST match sidecar/src/electron-shim.ts channelSubdir.
    static let userDataDirName: String =
        (Bundle.main.object(forInfoDictionaryKey: "MaestroUserDataDir") as? String) ?? "desktop"

    /// Preferred External MCP port for this channel, string form for the env.
    static let mcpPort: String? = {
        if let s = Bundle.main.object(forInfoDictionaryKey: "MaestroMcpPort") as? String, !s.isEmpty { return s }
        if let n = Bundle.main.object(forInfoDictionaryKey: "MaestroMcpPort") as? Int { return String(n) }
        return nil
    }()

    /// The channel's isolated userData directory (~/Library/Application Support/@maestro/<subdir>).
    static let userDataURL: URL =
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/@maestro/\(userDataDirName)", isDirectory: true)

    /// Visible product name (Mochlet / Mochlet Preview / Mochlet Development).
    static let displayName: String =
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
        ?? (Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String)
        ?? "Mochlet"

    /// Debug-log path suffix so channels never clobber each other's log.
    static let logSuffix: String = name == "production" ? "" : "-\(name)"
}

/// The channel-scoped 32-byte master key that backs the sidecar's authenticated
/// `safeStorage` (AES-256-GCM envelope). Provisioned in the macOS login Keychain
/// as a generic-password item keyed to THIS channel's bundle id, so production /
/// preview / development never share a key. Accessible only AfterFirstUnlock on
/// THIS device (never syncs to iCloud, never leaves the Mac). The base64 key is
/// handed to the spawned sidecar ONLY via an environment variable — never argv,
/// never logged, never written to the store/renderer/health. If the Keychain is
/// unavailable the app runs without it and `safeStorage.isEncryptionAvailable()`
/// becomes false (the brain then surfaces "reconnect" rather than persisting a
/// reversible plaintext credential).
enum SafeStorageKey {
    private static let service: String =
        (Bundle.main.bundleIdentifier ?? "cloud.nexalance.maestro.webkit") + ".safeStorage"
    private static let account = "master-key"
    private static let keyLength = 32

    /// Base64 of the existing or freshly-created master key, or nil on failure.
    static func provisionBase64() -> String? {
        if let existing = load(), existing.count == keyLength {
            return existing.base64EncodedString()
        }
        guard let fresh = randomKey() else { return nil }
        switch store(fresh) {
        case .stored:
            return fresh.base64EncodedString()
        case .duplicate:
            // The item already existed (our load() failed transiently, e.g. a
            // briefly-locked Keychain). SecItemAdd does NOT overwrite, so the
            // freshly-generated key was NOT persisted — we MUST return the
            // ALREADY-STORED key, never `fresh`, or keys encrypted this run would
            // be undecryptable after restart.
            if let existing = load(), existing.count == keyLength {
                return existing.base64EncodedString()
            }
            return nil
        case .failed:
            return nil
        }
    }

    private enum StoreOutcome { case stored, duplicate, failed }

    private static func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    private static func load() -> Data? {
        var q = baseQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data else { return nil }
        return data
    }

    private static func store(_ key: Data) -> StoreOutcome {
        var q = baseQuery()
        q[kSecValueData as String] = key
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        if status == errSecSuccess { return .stored }
        if status == errSecDuplicateItem { return .duplicate }
        return .failed
    }

    private static func randomKey() -> Data? {
        var bytes = [UInt8](repeating: 0, count: keyLength)
        let status = SecRandomCopyBytes(kSecRandomDefault, keyLength, &bytes)
        return status == errSecSuccess ? Data(bytes) : nil
    }
}

enum DebugLog {
    private static let url = URL(fileURLWithPath: "/tmp/maestro-webkit\(Channel.logSuffix).log")
    private static let lock = NSLock()

    static func reset() {
        lock.lock()
        defer { lock.unlock() }
        try? FileManager.default.removeItem(at: url)
    }

    static func write(_ message: String) {
        let line = "[\(Date())] \(message)\n"
        guard let data = line.data(using: .utf8) else { return }
        FileHandle.standardError.write(data)

        lock.lock()
        defer { lock.unlock() }
        if !FileManager.default.fileExists(atPath: url.path) {
            FileManager.default.createFile(atPath: url.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {
            // stderr already has the message; avoid recursive logging on file I/O failure.
        }
    }
}

struct SidecarEndpoint {
    let port: Int
    let token: String
}

final class SidecarProcess {
    private var process: Process?
    private var stdoutBuffer = Data()
    private let onReady: (SidecarEndpoint) -> Void
    private let onFailure: (String) -> Void

    init(onReady: @escaping (SidecarEndpoint) -> Void, onFailure: @escaping (String) -> Void) {
        self.onReady = onReady
        self.onFailure = onFailure
    }

    func start() {
        guard process == nil else { return }
        guard let launch = resolveLaunch() else {
            onFailure("Sidecar binary not found. Build the app bundle again.")
            return
        }

        let proc = Process()
        proc.executableURL = launch.exec
        proc.arguments = launch.args
        proc.currentDirectoryURL = launch.cwd
        var env = ProcessInfo.processInfo.environment
        env["MAESTRO_HEADLESS"] = "1"
        env["MAESTRO_NATIVE_WEBKIT"] = "1"
        // Propagate the packaged app's version (CFBundleShortVersionString) so the
        // sidecar's electron shim reports the REAL version in health/feedback
        // instead of a stale hardcoded fallback. Authoritative source of truth.
        if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
           !version.isEmpty {
            env["MAESTRO_VERSION"] = version
        }
        // Channel isolation: hand the sidecar its channel identity, isolated
        // userData dir, and preferred External MCP port — all from the signed
        // Info.plist, so no channel can read/mutate another's store or port.
        env["MAESTRO_CHANNEL"] = Channel.name
        env["MAESTRO_USER_DATA_DIR"] = Channel.userDataURL.path
        if let mcpPort = Channel.mcpPort {
            env["MAESTRO_MCP_PORT"] = mcpPort
        }
        if let webRoot = resolveWebRoot() {
            env["MAESTRO_WEB_ROOT"] = webRoot.path
        }
        // Provision (or reuse) THIS channel's Keychain master key and hand ONLY
        // its base64 form to the sidecar via the environment — never argv, never
        // logged. If provisioning fails we omit it, and the sidecar's
        // safeStorage.isEncryptionAvailable() reports false (app stays usable).
        if let safeStorageKeyB64 = SafeStorageKey.provisionBase64() {
            env["MAESTRO_SAFE_STORAGE_KEY"] = safeStorageKeyB64
        }
        proc.environment = env
        // NB: log exec/args/cwd only — NEVER the environment (it now carries the
        // safeStorage master key).
        DebugLog.write("[native] launching sidecar exec=\(launch.exec.path) args=\(launch.args.joined(separator: " ")) cwd=\(launch.cwd.path)")

        let out = Pipe()
        proc.standardOutput = out
        out.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            DispatchQueue.main.async { self?.consumeStdout(chunk) }
        }

        let err = Pipe()
        proc.standardError = err
        err.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty, let text = String(data: chunk, encoding: .utf8) else { return }
            DebugLog.write("[sidecar stderr] \(text.trimmingCharacters(in: .newlines))")
        }

        proc.terminationHandler = { [weak self] exited in
            DispatchQueue.main.async {
                guard let self, self.process === exited else { return }
                self.process = nil
                self.onFailure("The Mochlet sidecar stopped.")
            }
        }

        do {
            try proc.run()
            process = proc
        } catch {
            DebugLog.write("[native] sidecar failed to start: \(error.localizedDescription)")
            onFailure("Sidecar failed to start: \(error.localizedDescription)")
        }
    }

    func stop() {
        process?.terminate()
        process = nil
    }

    private func consumeStdout(_ chunk: Data) {
        stdoutBuffer.append(chunk)
        while let newline = stdoutBuffer.firstIndex(of: 0x0A) {
            let line = Data(stdoutBuffer[stdoutBuffer.startIndex..<newline])
            stdoutBuffer = Data(stdoutBuffer[stdoutBuffer.index(after: newline)...])
            handleStdoutLine(line)
        }
        if stdoutBuffer.count > 64_000 {
            stdoutBuffer.removeAll(keepingCapacity: false)
        }
    }

    private func handleStdoutLine(_ data: Data) {
        if let line = String(data: data, encoding: .utf8) {
            DebugLog.write("[sidecar stdout] \(line)")
        }
        guard
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return }

        if object["ready"] as? Bool == true,
           let port = object["port"] as? Int,
           let token = object["token"] as? String {
            onReady(SidecarEndpoint(port: port, token: token))
            return
        }

        if let fatal = object["fatal"] as? String {
            onFailure("Engine failed to start: \(fatal)")
        }
    }

    private struct Launch {
        let exec: URL
        let args: [String]
        let cwd: URL
    }

    private func resolveLaunch() -> Launch? {
        let fm = FileManager.default

        if let override = ProcessInfo.processInfo.environment["MAESTRO_SIDECAR"],
           fm.isExecutableFile(atPath: override) {
            let url = URL(fileURLWithPath: override)
            return Launch(exec: url, args: [], cwd: url.deletingLastPathComponent())
        }

        if let bundledResources = Bundle.main.resourceURL?.appendingPathComponent("sidecar") {
            let resources = materializedRuntimeDirectory(from: bundledResources, name: "sidecar") ?? bundledResources
            let bundle = resources.appendingPathComponent("maestro-sidecar.mjs")
            if fm.fileExists(atPath: bundle.path) {
                let embeddedNode = bundledResources.appendingPathComponent("bin/node")
                if fm.isExecutableFile(atPath: embeddedNode.path) {
                    return Launch(exec: embeddedNode, args: [bundle.path], cwd: resources)
                }
                if let node = which("node") {
                    return Launch(exec: node, args: [bundle.path], cwd: resources)
                }
            }
        }

        if let root = repoRoot(), let node = which("node") {
            let entry = root.appendingPathComponent("MacOS/sidecar/src/headless-main.ts")
            let register = root.appendingPathComponent("MacOS/sidecar/src/register.mjs")
            if fm.fileExists(atPath: entry.path) {
                return Launch(exec: node, args: ["--import", register.path, entry.path], cwd: root)
            }
        }

        return nil
    }

    private func resolveWebRoot() -> URL? {
        let fm = FileManager.default
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("web"),
           fm.fileExists(atPath: bundled.appendingPathComponent("index.html").path) {
            return materializedRuntimeDirectory(from: bundled, name: "web") ?? bundled
        }
        if let root = repoRoot() {
            let dev = root.appendingPathComponent("MacOS/webview-app/build/web")
            if fm.fileExists(atPath: dev.appendingPathComponent("index.html").path) {
                return dev
            }
        }
        return nil
    }

    private func runtimeRoot() -> URL {
        // Channel-specific runtime materialization dir (colocated with the
        // channel's userData) so preview/development never share the production
        // runtime cache.
        Channel.userDataURL.appendingPathComponent("runtime", isDirectory: true)
    }

    private func materializedRuntimeDirectory(from bundled: URL, name: String) -> URL? {
        let fm = FileManager.default
        let destination = runtimeRoot().appendingPathComponent(name, isDirectory: true)
        let marker = destination.appendingPathComponent(".maestro-source")
        let sourceId = runtimeSourceIdentifier(for: bundled, name: name)

        if fm.fileExists(atPath: destination.path),
           (try? String(contentsOf: marker, encoding: .utf8)) == sourceId {
            return destination
        }

        let temp = runtimeRoot().appendingPathComponent(".\(name)-\(UUID().uuidString)", isDirectory: true)
        do {
            try fm.createDirectory(at: runtimeRoot(), withIntermediateDirectories: true)
            try? fm.removeItem(at: temp)
            try fm.copyItem(at: bundled, to: temp)
            try? fm.removeItem(at: destination)
            try fm.moveItem(at: temp, to: destination)
            try sourceId.write(to: marker, atomically: true, encoding: .utf8)
            DebugLog.write("[native] materialized \(name) runtime to \(destination.path)")
            return destination
        } catch {
            try? fm.removeItem(at: temp)
            DebugLog.write("[native] failed to materialize \(name) runtime: \(error.localizedDescription)")
            return nil
        }
    }

    private func runtimeSourceIdentifier(for bundled: URL, name: String) -> String {
        let sentinelName = name == "sidecar" ? "maestro-sidecar.mjs" : "index.html"
        let sentinel = bundled.appendingPathComponent(sentinelName)
        let values = try? sentinel.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey])
        let modified = values?.contentModificationDate?.timeIntervalSince1970 ?? 0
        let size = values?.fileSize ?? 0
        return "\(sentinel.path)|\(modified)|\(size)"
    }

    private func repoRoot() -> URL? {
        var dir = Bundle.main.bundleURL
        for _ in 0..<10 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("MacOS").path) {
                return dir
            }
            dir.deleteLastPathComponent()
        }
        return nil
    }

    private func which(_ tool: String) -> URL? {
        let fm = FileManager.default
        var dirs = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            dirs += path.split(separator: ":").map(String.init)
        }
        for dir in dirs {
            let path = "\(dir)/\(tool)"
            if fm.isExecutableFile(atPath: path) {
                return URL(fileURLWithPath: path)
            }
        }
        return nil
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKNavigationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var webView: WKWebView?
    private var loadingWebView: WKWebView?
    private var sidecar: SidecarProcess?
    private var windowObservers: [NSObjectProtocol] = []
    // Phase 3D1 view-only screen capture. Stored type-erased because the concrete
    // ScreenCaptureController is @available(macOS 14). Frames are forwarded to the
    // renderer (`window.__maestroScreenFrame`), which relays them to the brain host
    // coordinator; NO input path exists in the reverse direction.
    private var screenCaptureObj: AnyObject?
    private let titleBarHeight: CGFloat = 40

    func applicationDidFinishLaunching(_ notification: Notification) {
        DebugLog.reset()
        DebugLog.write("[native] application starting")
        NSApp.setActivationPolicy(.regular)
        installMainMenu()
        makeWindow()
        showLoading("Starting \(Channel.displayName)...")

        let sidecar = SidecarProcess(
            onReady: { [weak self] endpoint in self?.loadWebApp(endpoint) },
            onFailure: { [weak self] message in self?.showLoading(message) }
        )
        self.sidecar = sidecar
        sidecar.start()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationWillTerminate(_ notification: Notification) {
        sidecar?.stop()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// Builds the application menu. The window hides its own title bar, but on
    /// macOS the standard editing shortcuts (⌘C/⌘V/⌘X/⌘A/⌘Z) are ONLY delivered
    /// to the focused field when an Edit menu wires them to the first-responder
    /// selectors (`paste:`, `copy:`, …). Without this menu, ⌘V silently does
    /// nothing inside the WKWebView — which is exactly the paste bug. The items
    /// keep `target == nil` so each action travels the responder chain into the
    /// web content, where WKWebView turns `paste:` into a real DOM paste event.
    private func installMainMenu() {
        let appName = Channel.displayName
        let mainMenu = NSMenu()

        // ── App menu ───────────────────────────────────────────────────────
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About \(appName)",
                        action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
        let prefs = appMenu.addItem(withTitle: "Settings…",
                                    action: #selector(openPreferences),
                                    keyEquivalent: ",")
        prefs.target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide \(appName)",
                        action: #selector(NSApplication.hide(_:)),
                        keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others",
                                         action: #selector(NSApplication.hideOtherApplications(_:)),
                                         keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All",
                        action: #selector(NSApplication.unhideAllApplications(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit \(appName)",
                        action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q")
        appItem.submenu = appMenu

        // ── Edit menu (the part that makes ⌘V work) ─────────────────────────
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        let pasteMatch = editMenu.addItem(withTitle: "Paste and Match Style",
                                          action: #selector(NSTextView.pasteAsPlainText(_:)),
                                          keyEquivalent: "v")
        pasteMatch.keyEquivalentModifierMask = [.command, .option, .shift]
        editMenu.addItem(withTitle: "Delete", action: #selector(NSText.delete(_:)), keyEquivalent: "")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editMenu.addItem(.separator())

        // Find submenu — WKWebView responds to `performTextFinderAction:`, so the
        // standard ⌘F / ⌘G / ⇧⌘G / ⌘E chord set drives the native find bar over
        // the web content (items keep target == nil to ride the responder chain).
        let findItem = editMenu.addItem(withTitle: "Find", action: nil, keyEquivalent: "")
        let findMenu = NSMenu(title: "Find")
        let finderSel = Selector(("performTextFinderAction:"))
        let find = findMenu.addItem(withTitle: "Find…", action: finderSel, keyEquivalent: "f")
        find.tag = NSTextFinder.Action.showFindInterface.rawValue
        let findNext = findMenu.addItem(withTitle: "Find Next", action: finderSel, keyEquivalent: "g")
        findNext.tag = NSTextFinder.Action.nextMatch.rawValue
        let findPrev = findMenu.addItem(withTitle: "Find Previous", action: finderSel, keyEquivalent: "g")
        findPrev.tag = NSTextFinder.Action.previousMatch.rawValue
        findPrev.keyEquivalentModifierMask = [.command, .shift]
        let useSel = findMenu.addItem(withTitle: "Use Selection for Find", action: finderSel, keyEquivalent: "e")
        useSel.tag = NSTextFinder.Action.setSearchString.rawValue
        findItem.submenu = findMenu
        editItem.submenu = editMenu

        // ── View menu ───────────────────────────────────────────────────────
        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        let reload = viewMenu.addItem(withTitle: "Reload", action: #selector(reloadPage), keyEquivalent: "r")
        reload.target = self
        let forceReload = viewMenu.addItem(withTitle: "Reload Ignoring Cache",
                                           action: #selector(forceReloadPage), keyEquivalent: "r")
        forceReload.keyEquivalentModifierMask = [.command, .shift]
        forceReload.target = self
        viewMenu.addItem(.separator())
        let actualSize = viewMenu.addItem(withTitle: "Actual Size", action: #selector(zoomActual), keyEquivalent: "0")
        actualSize.target = self
        // Bind the physical "=" key (so ⌘= zooms in without needing Shift; the
        // menu displays ⌘= which is what most users actually press).
        let zoomIn = viewMenu.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "=")
        zoomIn.target = self
        let zoomOut = viewMenu.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        zoomOut.target = self
        viewMenu.addItem(.separator())
        let fullScreen = viewMenu.addItem(withTitle: "Enter Full Screen",
                                          action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = viewMenu

        // ── Window menu ─────────────────────────────────────────────────────
        let windowItem = NSMenuItem()
        mainMenu.addItem(windowItem)
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front",
                           action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu

        NSApp.mainMenu = mainMenu
        NSApp.windowsMenu = windowMenu
    }

    // MARK: - View / window menu actions (operate on the WKWebView)

    @objc private func reloadPage() { webView?.reload() }
    @objc private func forceReloadPage() { webView?.reloadFromOrigin() }

    @objc private func zoomActual() {
        if #available(macOS 11.0, *) { webView?.pageZoom = 1.0 }
    }
    @objc private func zoomIn() {
        if #available(macOS 11.0, *), let v = webView {
            v.pageZoom = min(v.pageZoom + 0.1, 3.0)
        }
    }
    @objc private func zoomOut() {
        if #available(macOS 11.0, *), let v = webView {
            v.pageZoom = max(v.pageZoom - 0.1, 0.5)
        }
    }

    /// ⌘, — best-effort: ask the React UI to open its Settings screen. The web
    /// app can listen for the `maestro:open-settings` window event; if it isn't
    /// wired yet this is a harmless no-op (the in-app Settings nav still works).
    @objc private func openPreferences() {
        webView?.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('maestro:open-settings'));",
            completionHandler: nil
        )
    }

    private func makeWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1440, height: 940)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.center()
        window.title = Channel.displayName
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.minSize = NSSize(width: 980, height: 680)
        window.collectionBehavior = [.fullScreenPrimary]
        window.delegate = self
        installTrafficLightObservers()
        window.makeKeyAndOrderFront(nil)
        scheduleTrafficLightAlignment()
    }

    /// The exact animated Mochlet loader mark (breathing squircle + orbiting dot +
    /// tracing smile). Rendered in a WKWebView because the mark relies on CSS
    /// keyframes, which only a browser engine animates. Kept byte-for-byte with the
    /// design source so the splash matches the brand asset precisely.
    private static let loaderSVG = """
    <svg width="512" height="512" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg">
      <style>
        :root {
          color-scheme: dark;
        }

        .stage {
          fill: #1b1b1f;
        }

        .mark {
          transform-origin: 256px 256px;
          animation: breathe 1800ms cubic-bezier(.4, 0, .2, 1) infinite;
        }

        .rim {
          transform-origin: 256px 256px;
          stroke-dasharray: 760 280;
          animation:
            rim-spin 1800ms linear infinite,
            rim-pulse 1800ms cubic-bezier(.4, 0, .2, 1) infinite;
        }

        .smile {
          stroke-dasharray: 132;
          stroke-dashoffset: 132;
          animation: smile-ready 1800ms cubic-bezier(.2, .8, .2, 1) infinite;
        }

        .dot {
          transform-origin: 256px 256px;
          animation: dot-orbit 1800ms cubic-bezier(.4, 0, .2, 1) infinite;
        }

        @keyframes breathe {
          0%, 100% { transform: scale(.965); }
          42%, 62% { transform: scale(1); }
        }

        @keyframes rim-spin {
          to { transform: rotate(360deg); }
        }

        @keyframes rim-pulse {
          0%, 100% { opacity: .35; stroke-width: 5; }
          50% { opacity: .95; stroke-width: 7; }
        }

        @keyframes smile-ready {
          0% { stroke-dashoffset: 132; opacity: .35; }
          38%, 70% { stroke-dashoffset: 0; opacity: 1; }
          100% { stroke-dashoffset: -132; opacity: .35; }
        }

        @keyframes dot-orbit {
          0% { transform: rotate(-28deg) translateY(-150px) scale(.82); opacity: .2; }
          42% { transform: rotate(28deg) translateY(-150px) scale(1); opacity: 1; }
          100% { transform: rotate(332deg) translateY(-150px) scale(.82); opacity: .2; }
        }
      </style>

      <defs>
        <linearGradient id="mochletFill" x1="142" y1="126" x2="382" y2="398" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#2388FF"/>
          <stop offset=".42" stop-color="#5E8BFF"/>
          <stop offset=".7" stop-color="#7C5CFF"/>
          <stop offset="1" stop-color="#A24BE0"/>
        </linearGradient>
        <linearGradient id="mochletRim" x1="102" y1="112" x2="414" y2="410" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="#2388FF"/>
          <stop offset=".32" stop-color="#7C5CFF"/>
          <stop offset=".68" stop-color="#A24BE0"/>
          <stop offset="1" stop-color="#25E6C8"/>
        </linearGradient>
        <filter id="softGlow" x="70" y="70" width="372" height="372" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
          <feGaussianBlur stdDeviation="18" result="blur"/>
          <feColorMatrix in="blur" type="matrix" values="0 0 0 0 0.141 0 0 0 0 0.533 0 0 0 0 1 0 0 0 .32 0"/>
        </filter>
      </defs>

      <rect class="stage" width="512" height="512" rx="48"/>
      <rect x="133" y="119" width="246" height="246" rx="78" fill="#2388FF" opacity=".22" filter="url(#softGlow)"/>
      <g class="mark">
        <rect x="132" y="118" width="248" height="248" rx="80" fill="url(#mochletFill)"/>
        <rect class="rim" x="126" y="112" width="260" height="260" rx="86" stroke="url(#mochletRim)" stroke-linecap="round"/>
        <circle class="dot" cx="256" cy="256" r="7" fill="#25E6C8"/>
        <path class="smile" d="M218 257C229 281 243 288 256 288C269 288 283 281 294 257" stroke="white" stroke-width="20" stroke-linecap="round"/>
      </g>
    </svg>
    """

    private func loadingHTML(_ message: String) -> String {
        let escaped = message
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
        return """
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <style>
            :root { color-scheme: dark; }
            html, body { margin: 0; height: 100%; background: #1b1b1f; overflow: hidden; }
            .wrap {
              position: fixed; inset: 0;
              display: flex; flex-direction: column;
              align-items: center; justify-content: center;
              gap: 30px;
              -webkit-user-select: none; user-select: none;
            }
            .mark-box { width: 148px; height: 148px; }
            .mark-box svg { width: 100%; height: 100%; display: block; }
            .status {
              font: 500 14px -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Segoe UI", sans-serif;
              color: rgba(235, 235, 245, 0.6);
              text-align: center;
              max-width: 78vw;
              line-height: 1.45;
              letter-spacing: 0.2px;
            }
          </style>
        </head>
        <body>
          <div class="wrap">
            <div class="mark-box">\(AppDelegate.loaderSVG)</div>
            <div class="status">\(escaped)</div>
          </div>
        </body>
        </html>
        """
    }

    private func showLoading(_ message: String) {
        // If the loader webview is already up, just swap the status text so the
        // animation doesn't restart when a failure message replaces "Starting…".
        if let existing = loadingWebView {
            let js = "var s=document.querySelector('.status'); if(s){s.textContent=\(jsStringLiteral(message));}"
            existing.evaluateJavaScript(js, completionHandler: nil)
            return
        }

        let config = WKWebViewConfiguration()
        let view = WKWebView(frame: window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 1440, height: 940),
                             configuration: config)
        view.autoresizingMask = [.width, .height]
        view.setValue(false, forKey: "drawsBackground")  // let the #1b1b1f page paint edge-to-edge
        view.loadHTMLString(loadingHTML(message), baseURL: nil)

        window.contentView = view
        loadingWebView = view
        scheduleTrafficLightAlignment()
    }

    /// Safely encode an arbitrary Swift string as a JS string literal for injection.
    private func jsStringLiteral(_ s: String) -> String {
        let escaped = s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "")
        return "\"\(escaped)\""
    }

    private func loadWebApp(_ endpoint: SidecarEndpoint) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        // The Design workspace's "Full screen" preview button calls
        // element.requestFullscreen(); WKWebView keeps the Fullscreen API OFF
        // unless this is opted in, which left that button silently dead.
        if #available(macOS 12.3, *) {
            config.preferences.isElementFullscreenEnabled = true
        }
        let controller = WKUserContentController()
        controller.add(self, name: "maestroNative")
        controller.add(self, name: "maestroLog")
        controller.addUserScript(WKUserScript(
            source: consoleBridgeScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        controller.addUserScript(WKUserScript(
            source: windowDragBridgeScript(),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        controller.addUserScript(WKUserScript(
            source: bridgeScript(endpoint, sessionToken: persistedSessionToken()),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        config.userContentController = controller

        let frame = window.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 1440, height: 940)
        let view = WKWebView(frame: frame, configuration: config)
        view.autoresizingMask = [.width, .height]
        view.navigationDelegate = self
        view.allowsBackForwardNavigationGestures = false
        if #available(macOS 13.3, *) {
            view.isInspectable = true
        }

        window.contentView = view
        webView = view
        loadingWebView = nil  // splash handed off to the real app view
        scheduleTrafficLightAlignment()

        guard let url = URL(string: "http://127.0.0.1:\(endpoint.port)/app/index.html") else {
            showLoading("Could not form the local WebKit app URL.")
            return
        }
        DebugLog.write("[native] loading \(url.absoluteString)")
        view.load(URLRequest(url: url))
    }

    func windowDidResize(_ notification: Notification) {
        alignTrafficLights()
    }

    private func installTrafficLightObservers() {
        let names: [Notification.Name] = [
            NSWindow.didResizeNotification,
            NSWindow.didBecomeKeyNotification,
            NSWindow.didEnterFullScreenNotification,
            NSWindow.didExitFullScreenNotification,
        ]
        for name in names {
            windowObservers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                self?.scheduleTrafficLightAlignment()
            })
        }
    }

    private func scheduleTrafficLightAlignment() {
        DispatchQueue.main.async { [weak self] in self?.alignTrafficLights() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08) { [weak self] in self?.alignTrafficLights() }
    }

    private func alignTrafficLights() {
        guard let window else { return }
        let buttons = [
            NSWindow.ButtonType.closeButton,
            .miniaturizeButton,
            .zoomButton,
        ].compactMap { window.standardWindowButton($0) }
        guard let first = buttons.first, let frame = first.superview else { return }
        let y = frame.bounds.height - titleBarHeight + (titleBarHeight - first.frame.height) / 2
        for button in buttons {
            button.setFrameOrigin(NSPoint(x: button.frame.origin.x, y: y))
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        DebugLog.write("[native] navigation started: \(webView.url?.absoluteString ?? "nil")")
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        DebugLog.write("[native] navigation finished: \(webView.url?.absoluteString ?? "nil")")
        logDOMState(webView, label: "dom-immediate")
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak webView] in
            guard let webView else { return }
            self.logDOMState(webView, label: "dom-delayed")
        }
    }

    private func logDOMState(_ webView: WKWebView, label: String) {
        webView.evaluateJavaScript("""
        JSON.stringify({
          href: location.href,
          hash: location.hash,
          readyState: document.readyState,
          root: !!document.getElementById('root'),
          bodyChildren: document.body ? document.body.children.length : -1,
          scripts: document.scripts.length,
          maestro: !!window.maestro,
          localSession: !!localStorage.getItem('maestro.session'),
          onboarded: localStorage.getItem('maestro.onboarded'),
          purpose: localStorage.getItem('maestro.purpose'),
          text: document.body ? document.body.innerText.slice(0, 500) : '',
          rootHtml: (document.getElementById('root') ? document.getElementById('root').innerHTML : '').slice(0, 500),
          resources: performance.getEntriesByType('resource').slice(-20).map(e => ({
            name: e.name,
            type: e.initiatorType,
            duration: Math.round(e.duration),
            transferSize: e.transferSize || 0
          }))
        })
        """) { value, error in
            if let error {
                DebugLog.write("[native] \(label) check failed: \(error.localizedDescription)")
                return
            }
            DebugLog.write("[native] \(label) \(String(describing: value))")
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        DebugLog.write("[native] navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        DebugLog.write("[native] provisional navigation failed: \(error.localizedDescription)")
    }

    private func webRootURL() -> URL? {
        let fm = FileManager.default
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("web"),
           fm.fileExists(atPath: bundled.appendingPathComponent("index.html").path) {
            return bundled
        }
        if let root = repoRoot() {
            let dev = root.appendingPathComponent("MacOS/webview-app/build/web")
            if fm.fileExists(atPath: dev.appendingPathComponent("index.html").path) {
                return dev
            }
        }
        return nil
    }

    private func repoRoot() -> URL? {
        var dir = Bundle.main.bundleURL
        for _ in 0..<10 {
            if FileManager.default.fileExists(atPath: dir.appendingPathComponent("MacOS").path) {
                return dir
            }
            dir.deleteLastPathComponent()
        }
        return nil
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "maestroLog", let text = message.body as? String {
            DebugLog.write("[web] \(text)")
            return
        }

        guard
            message.name == "maestroNative",
            let payload = message.body as? [String: Any],
            let method = payload["method"] as? String
        else { return }

        if method == "windowDrag" {
            beginWindowDrag()
            return
        }

        guard let id = payload["id"] as? Int else { return }

        switch method {
        case "pickFolder":
            pickFolder { [weak self] result in self?.resolveNativeRequest(id, result: result) }
        case "importAsset":
            importAsset { [weak self] result in self?.resolveNativeRequest(id, result: result) }
        case "nativeCopy":
            nativeCopy(payload["params"] as? [String: Any]) { [weak self] result in self?.resolveNativeRequest(id, result: result) }
        case "nativeReveal":
            nativeReveal(payload["params"] as? [String: Any]) { [weak self] result in self?.resolveNativeRequest(id, result: result) }
        case "nativeOpen":
            nativeOpen(payload["params"] as? [String: Any]) { [weak self] result in self?.resolveNativeRequest(id, result: result) }
        case "screenCapturePreflight":
            resolveNativeRequest(id, result: ["ok": true, "permission": screenCapturePermissionState().rawValue])
        case "screenCaptureListSources":
            handleScreenCaptureListSources(id)
        case "screenCaptureStart":
            handleScreenCaptureStart(payload["params"] as? [String: Any], id)
        case "screenCaptureStop":
            handleScreenCaptureStop(id)
        default:
            resolveNativeRequest(id, result: ["ok": false, "error": "unknown native method"])
        }
    }

    // MARK: - Phase 3D1 screen capture bridge (view-only)

    private func handleScreenCaptureListSources(_ id: Int) {
        guard #available(macOS 14.0, *) else {
            resolveNativeRequest(id, result: ["ok": false, "error": "unsupported"]); return
        }
        let controller = currentScreenController()
        Task {
            do {
                let sources = try await controller.listSources()
                let mapped = sources.map { ["id": $0.id, "label": $0.label, "width": $0.width, "height": $0.height] as [String: Any] }
                await MainActor.run { self.resolveNativeRequest(id, result: ["ok": true, "sources": mapped]) }
            } catch {
                await MainActor.run { self.resolveNativeRequest(id, result: ["ok": false, "error": "list failed"]) }
            }
        }
    }

    @available(macOS 14.0, *)
    private func currentScreenController() -> ScreenCaptureController {
        if let existing = screenCaptureObj as? ScreenCaptureController { return existing }
        let controller = ScreenCaptureController()
        controller.onFrame = { [weak self] data, ts in
            let b64 = data.base64EncodedString()
            DispatchQueue.main.async {
                self?.webView?.evaluateJavaScript(
                    "window.__maestroScreenFrame && window.__maestroScreenFrame('\(b64)', \(ts));",
                    completionHandler: nil
                )
            }
        }
        controller.onError = { [weak self] reason in
            DispatchQueue.main.async {
                self?.webView?.evaluateJavaScript(
                    "window.__maestroScreenError && window.__maestroScreenError('\(reason)');",
                    completionHandler: nil
                )
            }
        }
        screenCaptureObj = controller
        return controller
    }

    private func handleScreenCaptureStart(_ params: [String: Any]?, _ id: Int) {
        guard #available(macOS 14.0, *) else {
            resolveNativeRequest(id, result: ["ok": false, "error": "unsupported"]); return
        }
        guard screenCapturePermissionState() == .granted else {
            resolveNativeRequest(id, result: ["ok": false, "error": "permission", "permission": screenCapturePermissionState().rawValue]); return
        }
        // B2-R1: the canonical bridge field is `sourceId`. Reject a missing/empty id
        // BEFORE touching ScreenCaptureKit — this is a not-configured state, distinct from
        // a stale source (which surfaces below as source-lost / .sourceUnavailable). No
        // silent empty-id fallback.
        guard let sourceID = params?["sourceId"] as? String, !sourceID.isEmpty else {
            resolveNativeRequest(id, result: ["ok": false, "error": "source-required"]); return
        }
        let maxDim = (params?["maxDimension"] as? Int) ?? 1280
        let fps = (params?["fps"] as? Int) ?? 8
        let showsCursor = (params?["showsCursor"] as? Bool) ?? false
        let quality = CGFloat((params?["quality"] as? Double) ?? 0.6)
        let controller = currentScreenController()
        let config = ScreenCaptureStartConfig(sourceID: sourceID, maxDimension: maxDim, fps: fps, showsCursor: showsCursor, jpegQuality: quality)
        Task {
            do {
                let size = try await controller.start(config)
                await MainActor.run { self.resolveNativeRequest(id, result: ["ok": true, "width": size.width, "height": size.height]) }
            } catch ScreenCaptureStartError.permission {
                await MainActor.run { self.resolveNativeRequest(id, result: ["ok": false, "error": "permission"]) }
            } catch ScreenCaptureStartError.sourceUnavailable {
                await MainActor.run { self.resolveNativeRequest(id, result: ["ok": false, "error": "source-lost"]) }
            } catch {
                await MainActor.run { self.resolveNativeRequest(id, result: ["ok": false, "error": "start failed"]) }
            }
        }
    }

    private func handleScreenCaptureStop(_ id: Int) {
        guard #available(macOS 14.0, *), let controller = screenCaptureObj as? ScreenCaptureController else {
            resolveNativeRequest(id, result: ["ok": true]); return
        }
        Task {
            await controller.stop()
            await MainActor.run { self.resolveNativeRequest(id, result: ["ok": true]) }
        }
    }

    private func beginWindowDrag() {
        guard let window else { return }
        guard let event = NSApp.currentEvent, event.type == .leftMouseDown else {
            DebugLog.write("[native] window drag ignored: no active leftMouseDown event")
            return
        }
        window.performDrag(with: event)
    }

    private func pickFolder(_ done: @escaping ([String: Any]) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "Open project folder"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.beginSheetModal(for: window) { response in
            if response == .OK, let url = panel.url {
                done(["ok": true, "data": ["path": url.path]])
            } else {
                done(["ok": true, "data": NSNull()])
            }
        }
    }

    private func importAsset(_ done: @escaping ([String: Any]) -> Void) {
        let panel = NSOpenPanel()
        panel.title = "Import media"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [
            .png, .jpeg, .gif, .webP, .mpeg4Movie, .quickTimeMovie, .mp3, .wav, .mpeg4Audio
        ]
        panel.beginSheetModal(for: window) { response in
            if response == .OK, let url = panel.url {
                done(["ok": true, "data": ["path": url.path]])
            } else {
                done(["ok": true, "data": NSNull()])
            }
        }
    }

    /// Write text to the system pasteboard. WebKit rejects the web
    /// `navigator.clipboard.writeText`, so the renderer routes tab-transcript
    /// copies through this native handler.
    private func nativeCopy(_ params: [String: Any]?, _ done: @escaping ([String: Any]) -> Void) {
        guard let text = params?["text"] as? String else {
            done(["ok": false, "error": "text must be a string", "status": 400])
            return
        }
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        let wrote = pasteboard.setString(text, forType: .string)
        if wrote {
            done(["ok": true])
        } else {
            done(["ok": false, "error": "pasteboard write failed"])
        }
    }

    private func nativeReveal(_ params: [String: Any]?, _ done: @escaping ([String: Any]) -> Void) {
        let path = (params?["path"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !path.isEmpty, FileManager.default.fileExists(atPath: path) else {
            done(["ok": false, "error": "path not found", "status": 404])
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
        done(["ok": true])
    }

    private func nativeOpen(_ params: [String: Any]?, _ done: @escaping ([String: Any]) -> Void) {
        let path = (params?["path"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !path.isEmpty, FileManager.default.fileExists(atPath: path) else {
            done(["ok": false, "error": "path not found", "status": 404])
            return
        }
        NSWorkspace.shared.open(URL(fileURLWithPath: path))
        done(["ok": true])
    }

    private func resolveNativeRequest(_ id: Int, result: [String: Any]) {
        guard
            let jsonData = try? JSONSerialization.data(withJSONObject: result),
            let json = String(data: jsonData, encoding: .utf8)
        else { return }
        webView?.evaluateJavaScript("window.__maestroNativeResolve && window.__maestroNativeResolve(\(id), \(json));")
    }

    private func consoleBridgeScript() -> String {
        """
        (() => {
          const send = (level, args) => {
            try {
              const text = [level, ...Array.from(args).map(value => {
                try { return typeof value === 'string' ? value : JSON.stringify(value); }
                catch { return String(value); }
              })].join(' ');
              const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.maestroLog;
              if (handler) handler.postMessage(text);
            } catch {}
          };
          for (const level of ['log', 'warn', 'error']) {
            const original = console[level] ? console[level].bind(console) : () => {};
            console[level] = (...args) => { send(level, args); original(...args); };
          }
          window.addEventListener('error', event => {
            send('error', [event.message, event.filename, event.lineno, event.colno]);
          });
          window.addEventListener('unhandledrejection', event => {
            send('unhandledrejection', [event.reason && event.reason.message ? event.reason.message : event.reason]);
          });
        })();
        """
    }

    private func windowDragBridgeScript() -> String {
        """
        (() => {
          if (window.__maestroWindowDragInstalled) return;
          window.__maestroWindowDragInstalled = true;

          const noDragSelector = [
            '.win-no-drag',
            'button',
            'input',
            'textarea',
            'select',
            'option',
            'a',
            '[role="button"]',
            '[contenteditable="true"]',
            '[data-no-window-drag="true"]'
          ].join(',');

          const dragSelector = '.win-drag,[data-window-drag="true"]';

          document.addEventListener('mousedown', event => {
            if (event.button !== 0 || event.defaultPrevented) return;
            const target = event.target instanceof Element ? event.target : null;
            if (!target) return;
            if (target.closest(noDragSelector)) return;

            const dragRegion = target.closest(dragSelector);
            if (!dragRegion) return;

            const tag = dragRegion.tagName ? dragRegion.tagName.toLowerCase() : '';
            const isTopBand = event.clientY <= 48;
            const isHeader = tag === 'header';
            const isExplicitFullRegion = dragRegion.getAttribute('data-window-drag') === 'full';
            if (!isTopBand && !isHeader && !isExplicitFullRegion) return;

            try {
              window.webkit?.messageHandlers?.maestroNative?.postMessage({ method: 'windowDrag' });
            } catch (_) {
              // Native bridge unavailable; keep the web event untouched.
            }
          }, true);
        })();
        """
    }

    private func persistedSessionToken() -> String {
        // Read THIS channel's account session — never the production store from a
        // preview/development launch.
        let url = Channel.userDataURL.appendingPathComponent("account-session.json")
        guard
            let data = try? Data(contentsOf: url),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let token = object["token"] as? String
        else { return "" }
        return token.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func bridgeScript(_ endpoint: SidecarEndpoint, sessionToken: String) -> String {
        let token = jsString(endpoint.token)
        let accountToken = jsString(sessionToken)
        return """
        (() => {
          if (window.maestro) return;

          const endpoint = { port: \(endpoint.port), token: \(token) };
          const accountToken = \(accountToken);
          let socket = null;
          let connectPromise = null;
          let nextId = 1;
          const pending = new Map();
          const listeners = new Set();
          const nativePending = new Map();

          function envelope(ok, data, error, status) {
            return ok ? { ok: true, data } : { ok: false, error: error || 'failed', status: status || 500 };
          }

          try {
            if (accountToken && !localStorage.getItem('maestro.session')) {
              localStorage.setItem('maestro.session', accountToken);
            }
            if (!localStorage.getItem('maestro.onboarded')) {
              localStorage.setItem('maestro.onboarded', '1');
            }
          } catch {}

          function connect() {
            if (socket && socket.readyState === WebSocket.OPEN) return Promise.resolve(socket);
            if (connectPromise) return connectPromise;
            connectPromise = new Promise((resolve, reject) => {
              const ws = new WebSocket(`ws://127.0.0.1:${endpoint.port}?token=${encodeURIComponent(endpoint.token)}`);
              socket = ws;
              const timer = setTimeout(() => reject(new Error('sidecar connection timed out')), 10000);
              ws.onopen = () => { clearTimeout(timer); connectPromise = null; resolve(ws); };
              ws.onerror = () => { clearTimeout(timer); connectPromise = null; reject(new Error('sidecar connection failed')); };
              ws.onclose = () => {
                connectPromise = null;
                if (socket === ws) socket = null;
                for (const [id, item] of pending) item.resolve(envelope(false, null, 'sidecar disconnected', 503));
                pending.clear();
              };
              ws.onmessage = event => {
                let msg;
                try { msg = JSON.parse(event.data); } catch { return; }
                if (msg && msg.t === 'res' && pending.has(msg.id)) {
                  const item = pending.get(msg.id);
                  pending.delete(msg.id);
                  item.resolve(msg.ok ? envelope(true, msg.data) : envelope(false, null, msg.error, msg.status));
                  return;
                }
                if (msg && msg.t === 'event') {
                  const eventPayload = { name: msg.name, data: msg.data };
                  for (const cb of Array.from(listeners)) {
                    try { cb(eventPayload); } catch {}
                  }
                }
              };
            });
            return connectPromise;
          }

          async function call(method, params = {}) {
            const localParams = method === 'submitFeedback' ? { ...params, source: 'desktop' } : params;
            try {
              const ws = await connect();
              const id = nextId++;
              const payload = JSON.stringify({ t: 'call', id, method, params: localParams || {} });
              return await new Promise(resolve => {
                const timeout = setTimeout(() => {
                  pending.delete(id);
                  resolve(envelope(false, null, `${method} timed out`, 504));
                }, 120000);
                pending.set(id, { resolve: result => { clearTimeout(timeout); resolve(result); } });
                try { ws.send(payload); } catch (error) {
                  clearTimeout(timeout);
                  pending.delete(id);
                  resolve(envelope(false, null, error && error.message ? error.message : 'send failed', 500));
                }
              });
            } catch (error) {
              return envelope(false, null, error && error.message ? error.message : 'sidecar unavailable', 503);
            }
          }

          window.__maestroNativeResolve = (id, result) => {
            const item = nativePending.get(id);
            if (!item) return;
            nativePending.delete(id);
            item.resolve(result);
          };

          function nativeRequest(method, params = {}) {
            const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.maestroNative;
            if (!handler) return Promise.resolve(envelope(false, null, 'native bridge unavailable', 501));
            const id = nextId++;
            return new Promise(resolve => {
              nativePending.set(id, { resolve });
              handler.postMessage({ id, method, params });
            });
          }

          async function pickFolder() {
            const picked = await nativeRequest('pickFolder');
            if (!picked.ok || !picked.data || !picked.data.path) return picked;
            return call('inspectFolder', { path: picked.data.path });
          }

          async function importAsset(projectId) {
            const picked = await nativeRequest('importAsset');
            if (!picked.ok || !picked.data || !picked.data.path) return picked;
            return call('importAsset', { path: picked.data.path, projectId: projectId || null });
          }

          window.maestro = {
            platform: 'darwin',
            localEngine: true,
            nativeWebKit: true,
            call,
            onEvent(cb) { listeners.add(cb); connect().catch(() => {}); return () => listeners.delete(cb); },
            getPathForFile(file) { return file && typeof file.path === 'string' ? file.path : ''; },
            pickFolder,
            copyText(text) { return nativeRequest('nativeCopy', { text: String(text == null ? '' : text) }); },
            // Trusted native reveal/open for APP-OWNED paths (project folders,
            // generated assets, exports). Callers pass app-owned paths only.
            reveal(path) { return nativeRequest('nativeReveal', { path }); },
            revealPath(path) { return nativeRequest('nativeReveal', { path }); },
            openPath(path) { return nativeRequest('nativeOpen', { path }); },
            // Phase 3D1 (B2): view-only ScreenCaptureKit bridge. The renderer screen
            // bridge (screenBridge.ts) drives these + relays native frames to the brain.
            // View-only: there is NO input method exposed here.
            screenCapturePreflight() { return nativeRequest('screenCapturePreflight'); },
            screenCaptureListSources() { return nativeRequest('screenCaptureListSources'); },
            screenCaptureStart(p) { return nativeRequest('screenCaptureStart', p || {}); },
            screenCaptureStop() { return nativeRequest('screenCaptureStop'); },
            // FILE-ARTIFACT reveal/open are CONFINED: the brain resolves the path
            // against the project/session roots (or a trusted asset path) FIRST, and
            // the native OS action only ever runs on that canonical, confined path —
            // never a raw transcript path.
            async revealFile(projectId, path, sessionId) {
              const g = await call('resolveFilePath', { projectId, path, sessionId });
              if (!g || !g.ok || !g.data || !g.data.path) return g || envelope(false, null, 'reveal failed', 500);
              return nativeRequest('nativeReveal', { path: g.data.path });
            },
            async openFile(projectId, path, sessionId) {
              const g = await call('resolveFilePath', { projectId, path, sessionId });
              if (!g || !g.ok || !g.data || !g.data.path) return g || envelope(false, null, 'open failed', 500);
              return nativeRequest('nativeOpen', { path: g.data.path });
            },
            fileStreamUrl(projectId, path, sessionId) {
              const enc = encodeURIComponent;
              let url = `http://127.0.0.1:${endpoint.port}/files/stream?token=${enc(endpoint.token)}&projectId=${enc(projectId == null ? '' : projectId)}&path=${enc(path == null ? '' : path)}`;
              if (sessionId) url += `&sessionId=${enc(sessionId)}`;
              return url;
            },
            importAsset,
            assetImage(assetId) { return call('assetImage', { assetId }); },
            readFile(projectId, path, sessionId) { return call('readFile', { projectId, path, sessionId }); },
            writeFile(projectId, path, text, sessionId) { return call('writeFile', { projectId, path, text, sessionId }); },
            listDir(projectId, path, sessionId) { return call('listDir', { projectId, path: path || '', sessionId }); },
            listProjectFiles(projectId) { return call('listProjectFiles', { projectId }); },
            runCommand(projectId, command) { return call('runCommand', { projectId, command }); },
            killCommand(runId) { return call('killCommand', { runId }); },
            onCmdOutput(cb) {
              const off = this.onEvent(event => { if (event.name === 'cmd-output') cb(event.data); });
              return off;
            },
            setSession(token) { void call('accountSetSession', { token: token || '' }); },
            sendP2P() {},
            onP2P() { return () => {}; },
            p2pIce() { return Promise.resolve([]); },
          };
        })();
        """
    }

    private func jsString(_ value: String) -> String {
        guard
            let data = try? JSONSerialization.data(withJSONObject: [value]),
            let encoded = String(data: data, encoding: .utf8)
        else { return "''" }
        return String(encoded.dropFirst().dropLast())
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
