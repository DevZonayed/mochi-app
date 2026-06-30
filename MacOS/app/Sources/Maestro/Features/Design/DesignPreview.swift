import SwiftUI
import WebKit

/// A live design preview in a WKWebView, loading the sidecar's design route
/// (http://127.0.0.1:<port>/design/<projectId>/design/index.html). Reloads when `reloadToken`
/// changes. Comment harness (page↔Swift) is driven through `command` + the message handler.
struct DesignPreview: NSViewRepresentable {
    let url: URL
    var reloadToken: Int = 0
    /// One-shot command pushed to the page (comment-mode / markers / flash). Bumped via `seq`.
    var command: DesignCommand?
    /// Element picked in comment mode → (selector, label).
    var onPick: (String, String) -> Void = { _, _ in }
    var onCancelPick: () -> Void = {}

    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        let cc = WKUserContentController()
        cc.add(context.coordinator, name: "maestroDesign")
        cfg.userContentController = cc
        let web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = context.coordinator
        context.coordinator.web = web
        context.coordinator.lastURL = url
        context.coordinator.lastReload = reloadToken
        web.load(URLRequest(url: url))
        return web
    }

    func updateNSView(_ web: WKWebView, context: Context) {
        let c = context.coordinator
        if c.lastURL != url || c.lastReload != reloadToken {
            c.lastURL = url; c.lastReload = reloadToken
            web.load(URLRequest(url: url))
        }
        if let command, command.seq != c.lastCommandSeq {
            c.lastCommandSeq = command.seq
            web.evaluateJavaScript(command.js)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        let parent: DesignPreview
        weak var web: WKWebView?
        var lastURL: URL?
        var lastReload = -1
        var lastCommandSeq = -1
        init(_ p: DesignPreview) { parent = p }

        func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "maestroDesign", let d = message.body as? [String: Any], let type = d["type"] as? String else { return }
            switch type {
            case "comment-pick":
                parent.onPick(d["selector"] as? String ?? "", d["label"] as? String ?? "")
            case "comment-cancel":
                parent.onCancelPick()
            default: break
            }
        }
    }
}

/// A command pushed from Swift into the page (received by the harness's `message` listener).
/// Each command carries a seq so updateNSView applies it once. Compose with the JS builders.
struct DesignCommand: Equatable {
    let seq: Int
    let js: String

    static func commentModeJS(_ on: Bool) -> String {
        "window.dispatchEvent(new MessageEvent('message',{data:{__maestro:true,type:'comment-mode',on:\(on)}}))"
    }
    static func markersJS(_ json: String) -> String {
        "window.dispatchEvent(new MessageEvent('message',{data:{__maestro:true,type:'comment-markers',items:\(json)}}))"
    }
    static func flashJS(_ selector: String) -> String {
        let esc = selector.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
        return "window.dispatchEvent(new MessageEvent('message',{data:{__maestro:true,type:'flash',selector:'\(esc)'}}))"
    }
}
