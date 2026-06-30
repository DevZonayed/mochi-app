import AppKit
import Foundation
import WebKit

enum DebugLog {
    private static let url = URL(fileURLWithPath: "/tmp/maestro-webkit.log")
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
        if let webRoot = resolveWebRoot() {
            env["MAESTRO_WEB_ROOT"] = webRoot.path
        }
        proc.environment = env
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
                self.onFailure("The Maestro sidecar stopped.")
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
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Maestro WebKit/runtime", isDirectory: true)
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
    private var sidecar: SidecarProcess?
    private var windowObservers: [NSObjectProtocol] = []
    private let titleBarHeight: CGFloat = 40

    func applicationDidFinishLaunching(_ notification: Notification) {
        DebugLog.reset()
        DebugLog.write("[native] application starting")
        NSApp.setActivationPolicy(.regular)
        makeWindow()
        showLoading("Starting Maestro...")

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

    private func makeWindow() {
        let frame = NSRect(x: 0, y: 0, width: 1440, height: 940)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.center()
        window.title = "Maestro"
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

    private func showLoading(_ message: String) {
        let label = NSTextField(labelWithString: message)
        label.font = NSFont.systemFont(ofSize: 14, weight: .medium)
        label.textColor = .secondaryLabelColor
        label.alignment = .center

        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        view.addSubview(label)
        label.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
        window.contentView = view
        scheduleTrafficLightAlignment()
    }

    private func loadWebApp(_ endpoint: SidecarEndpoint) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
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
        default:
            resolveNativeRequest(id, result: ["ok": false, "error": "unknown native method"])
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
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/@maestro/desktop/account-session.json")
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
            revealPath(path) { return call('revealPath', { path }); },
            importAsset,
            assetImage(assetId) { return call('assetImage', { assetId }); },
            readFile(projectId, path) { return call('readFile', { projectId, path }); },
            writeFile(projectId, path, text) { return call('writeFile', { projectId, path, text }); },
            listDir(projectId, path) { return call('listDir', { projectId, path: path || '' }); },
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
