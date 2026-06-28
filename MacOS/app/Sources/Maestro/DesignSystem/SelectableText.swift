import SwiftUI
import AppKit

// AppKit-backed selectable text for the chat transcript. SwiftUI's `Text(...).textSelection(.enabled)`
// keeps a separate (bright, never-cleared) selection per Text and won't deselect on an outside click.
// An NSTextView gives native macOS selection: drag-select, ⌘C, greys when unfocused, and clears when
// it resigns first responder (we clear it explicitly) — so clicking empty space deselects.

// MARK: - NSColor tokens (mirror Tok for the AppKit text)

enum TokNS {
    static let ink          = NSColor.dyn(NSColor(hex: "#000000"), NSColor(hex: "#FFFFFF"))
    static let inkSecondary = NSColor.dyn(.rgba(60, 60, 67, 0.60), .rgba(235, 235, 245, 0.60))
    static let inkTertiary  = NSColor.dyn(.rgba(60, 60, 67, 0.30), .rgba(235, 235, 245, 0.30))
    static let blue         = NSColor(hex: "#007AFF")
    static let fillTertiary = NSColor.dyn(.rgba(118, 118, 128, 0.08), .rgba(120, 120, 128, 0.16))
}

extension NSColor {
    static func dyn(_ light: NSColor, _ dark: NSColor) -> NSColor {
        NSColor(name: nil) { $0.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light }
    }
}

// MARK: - NSTextView wrapper

/// An NSTextView that clears its selection when it loses focus — so clicking another message or the
/// transcript background deselects (the behavior the SwiftUI selection lacked).
final class SelectableNSTextView: NSTextView {
    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { setSelectedRange(NSRange(location: 0, length: 0)) }
        return ok
    }
}

/// Renders a pre-built `NSAttributedString` as selectable text. `wraps: true` (prose) sizes its
/// height to the proposed width; `wraps: false` (code) keeps its natural width for a host scroll view.
struct SelectableText: NSViewRepresentable {
    let attributed: NSAttributedString
    var wraps: Bool = true
    var onOpenFile: (String) -> Void = { FilePreviewWindowController.shared.open(path: $0) }

    func makeCoordinator() -> Coord { Coord(onOpenFile: onOpenFile) }

    func makeNSView(context: Context) -> SelectableNSTextView {
        let tv = SelectableNSTextView()
        tv.isEditable = false
        tv.isSelectable = true
        tv.drawsBackground = false
        tv.textContainerInset = .zero
        tv.textContainer?.lineFragmentPadding = 0
        tv.isAutomaticLinkDetectionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.delegate = context.coordinator
        tv.linkTextAttributes = [:]          // keep our own link styling
        tv.isVerticallyResizable = false
        if wraps {
            tv.textContainer?.widthTracksTextView = true
            tv.isHorizontallyResizable = false
        } else {
            tv.textContainer?.widthTracksTextView = false
            tv.textContainer?.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
            tv.isHorizontallyResizable = true
        }
        return tv
    }

    func updateNSView(_ tv: SelectableNSTextView, context: Context) {
        context.coordinator.onOpenFile = onOpenFile
        // Only re-set when the content actually changed, so scroll re-renders don't clobber an
        // in-progress selection.
        if !(context.coordinator.last?.isEqual(to: attributed) ?? false) {
            tv.textStorage?.setAttributedString(attributed)
            context.coordinator.last = attributed
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView tv: SelectableNSTextView, context: Context) -> CGSize? {
        guard let lm = tv.layoutManager, let tc = tv.textContainer else { return nil }
        let maxW = proposal.width ?? 600
        if wraps { tc.containerSize = NSSize(width: maxW, height: CGFloat.greatestFiniteMagnitude) }
        lm.ensureLayout(for: tc)
        let used = lm.usedRect(for: tc).size
        return CGSize(width: wraps ? maxW : ceil(used.width) + 2, height: ceil(used.height))
    }

    final class Coord: NSObject, NSTextViewDelegate {
        var onOpenFile: (String) -> Void
        init(onOpenFile: @escaping (String) -> Void) { self.onOpenFile = onOpenFile }
        var last: NSAttributedString?
        func textView(_ tv: NSTextView, clickedOnLink link: Any, at index: Int) -> Bool {
            let url: URL? = (link as? URL) ?? (link as? String).flatMap { URL(string: $0) }
            guard let url else { return false }
            if url.scheme == "maestrofile",
               let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
               let p = comps.queryItems?.first(where: { $0.name == "p" })?.value {
                onOpenFile(p); return true
            }
            NSWorkspace.shared.open(url); return true
        }
    }
}

// MARK: - NSAttributedString builders (mirror MarkdownText.inline / CodeCardView)

enum NSMarkdown {
    /// Inline prose → NSAttributedString: **bold** (semibold), `code` (mono pill / path link), and
    /// bare file paths as clickable links. Matches the SwiftUI `MarkdownText.inline` styling.
    static func inline(_ s: String, projectRoot: String?, size: CGFloat, color: NSColor) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let chars = Array(s); var i = 0; var plain = ""
        func flush() { if !plain.isEmpty { out.append(linkify(plain, projectRoot: projectRoot, size: size, color: color)); plain = "" } }
        while i < chars.count {
            if chars[i] == "`", let close = nextIndex(chars, "`", from: i + 1) {
                flush(); out.append(codeOrPath(String(chars[(i + 1)..<close]), projectRoot: projectRoot, size: size)); i = close + 1; continue
            }
            if chars[i] == "*", i + 1 < chars.count, chars[i + 1] == "*", let close = nextDouble(chars, from: i + 2) {
                flush()
                out.append(NSAttributedString(string: String(chars[(i + 2)..<close]),
                                              attributes: [.font: NSFont.systemFont(ofSize: size, weight: .semibold), .foregroundColor: color]))
                i = close + 2; continue
            }
            plain.append(chars[i]); i += 1
        }
        flush()
        let para = NSMutableParagraphStyle(); para.lineSpacing = size >= 14 ? 3.5 : 3
        out.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: out.length))
        return out
    }

    /// Fenced code body → mono NSAttributedString (no wrap; the card scrolls it).
    static func code(_ s: String) -> NSAttributedString {
        let para = NSMutableParagraphStyle(); para.lineSpacing = 3
        return NSAttributedString(string: s, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: 12.5, weight: .regular),
            .foregroundColor: TokNS.ink, .paragraphStyle: para,
        ])
    }

    /// White prose for the user bubble (no links — invisible on blue).
    static func white(_ s: String, size: CGFloat) -> NSAttributedString {
        let para = NSMutableParagraphStyle(); para.lineSpacing = 2.5
        let out = NSMutableAttributedString()
        // honor **bold**
        let chars = Array(s); var i = 0; var plain = ""
        func flush() { if !plain.isEmpty { out.append(NSAttributedString(string: plain, attributes: [.font: NSFont.systemFont(ofSize: size), .foregroundColor: NSColor.white])); plain = "" } }
        while i < chars.count {
            if chars[i] == "*", i + 1 < chars.count, chars[i + 1] == "*", let close = nextDouble(chars, from: i + 2) {
                flush(); out.append(NSAttributedString(string: String(chars[(i + 2)..<close]), attributes: [.font: NSFont.systemFont(ofSize: size, weight: .semibold), .foregroundColor: NSColor.white])); i = close + 2; continue
            }
            plain.append(chars[i]); i += 1
        }
        flush()
        out.addAttribute(.paragraphStyle, value: para, range: NSRange(location: 0, length: out.length))
        return out
    }

    // helpers
    private static func nextIndex(_ a: [Character], _ ch: Character, from: Int) -> Int? {
        var i = from; while i < a.count { if a[i] == ch { return i }; i += 1 }; return nil
    }
    private static func nextDouble(_ a: [Character], from: Int) -> Int? {
        var i = from; while i + 1 < a.count { if a[i] == "*" && a[i + 1] == "*" { return i }; i += 1 }; return nil
    }

    private static func codeOrPath(_ inner: String, projectRoot: String?, size: CGFloat) -> NSAttributedString {
        let codeSize = size * 0.92
        if ToolViz.looksLikePath(inner), let link = fileLink(inner, projectRoot) {
            return NSAttributedString(string: inner, attributes: [
                .font: NSFont.monospacedSystemFont(ofSize: codeSize, weight: .medium),
                .foregroundColor: TokNS.blue, .underlineStyle: NSUnderlineStyle.single.rawValue, .link: link,
            ])
        }
        return NSAttributedString(string: inner, attributes: [
            .font: NSFont.monospacedSystemFont(ofSize: codeSize, weight: .medium),
            .foregroundColor: TokNS.ink, .backgroundColor: TokNS.fillTertiary,
        ])
    }

    private static func linkify(_ s: String, projectRoot: String?, size: CGFloat, color: NSColor) -> NSAttributedString {
        let plainAttrs: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size), .foregroundColor: color]
        let pattern = #"(?:(?:~|\.\.?)?/)[^\s)\]}'"`,;]+|[A-Za-z0-9_.@\-]+(?:/[A-Za-z0-9_.@\-]+)+"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return NSAttributedString(string: s, attributes: plainAttrs) }
        let ns = s as NSString
        let out = NSMutableAttributedString(); var last = 0
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            if m.range.location > last { out.append(NSAttributedString(string: ns.substring(with: NSRange(location: last, length: m.range.location - last)), attributes: plainAttrs)) }
            let full = ns.substring(with: m.range)
            var tok = full; while let c = tok.last, ".,;:".contains(c) { tok.removeLast() }
            if !tok.isEmpty, let link = fileLink(tok, projectRoot) {
                out.append(NSAttributedString(string: tok, attributes: [.font: NSFont.systemFont(ofSize: size), .foregroundColor: TokNS.blue, .underlineStyle: NSUnderlineStyle.single.rawValue, .link: link]))
                if full.count > tok.count { out.append(NSAttributedString(string: String(full.dropFirst(tok.count)), attributes: plainAttrs)) }
            } else {
                out.append(NSAttributedString(string: full, attributes: plainAttrs))
            }
            last = m.range.location + m.range.length
        }
        if last < ns.length { out.append(NSAttributedString(string: ns.substring(from: last), attributes: plainAttrs)) }
        return out
    }

    private static func fileLink(_ p: String, _ root: String?) -> URL? {
        guard let abs = ToolViz.absolutePath(p, root: root),
              let enc = abs.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return nil }
        return URL(string: "maestrofile://open?p=\(enc)")
    }
}
