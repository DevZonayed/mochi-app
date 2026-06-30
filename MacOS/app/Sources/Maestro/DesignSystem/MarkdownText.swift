import SwiftUI
import AppKit

/// A block-level Markdown renderer for chat messages, ported to match the Electron chat's bespoke
/// `renderChatBody`/`renderProse` (NOT a generic library): chat headings are 15/13.5px bold, body
/// prose is 14px/1.62 in `--ink`, inline code is a fill-tertiary highlight, bold is 600, file paths
/// (bare or `` `code` ``-wrapped) are clickable blue links, fenced code renders as a header-barred
/// card, and tables get grid lines + column alignment. The chat deliberately does NOT render
/// `*italic*` or `[md](links)` — only bold + code + paths — so literal `*` survive.
struct MarkdownText: View {
    let text: String
    /// Root that relative file-path links resolve against (for click-to-open). nil → only absolute/~ paths link.
    var projectRoot: String? = nil
    /// Base prose size (chat = 14, thinking/response = 13).
    var baseSize: CGFloat = 14
    /// Base body ink (chat = `--ink`; thinking body = inkSecondary).
    var bodyColor: Color = Tok.ink
    /// AppKit body color for the selectable text view (must match `bodyColor`).
    var nsBodyColor: NSColor = TokNS.ink
    var onOpenFile: (String) -> Void = { FilePreviewWindowController.shared.open(path: $0) }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            ForEach(Array(Self.grouped(Self.parse(text)).enumerated()), id: \.offset) { _, g in
                switch g {
                case .prose(let blocks):
                    // One text view per contiguous prose run → a single drag selects across all of
                    // its headings/paragraphs/lists (was one view per block = no multi-line select).
                    SelectableText(attributed: NSMarkdown.prose(blocks, projectRoot: projectRoot, size: baseSize, color: nsBodyColor), onOpenFile: onOpenFile)
                case .code(let code, let lang):
                    CodeCardView(code: code, lang: lang)
                case .table(let headers, let rows, let aligns):
                    tableView(headers: headers, rows: rows, aligns: aligns)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.openURL, OpenURLAction { url in
            guard url.scheme == "maestrofile" else { return .systemAction }
            if let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
               let p = comps.queryItems?.first(where: { $0.name == "p" })?.value {
                onOpenFile(p)
            }
            return .handled
        })
    }

    // MARK: blocks
    enum Block: Hashable {
        case heading(level: Int, text: String)
        case paragraph(String)
        case code(String, lang: String?)
        case bullets([String])
        case ordered(start: Int, items: [String])
        case table(headers: [String], rows: [[String]], aligns: [TextAlignment])
        case quote(String)
        case rule
    }

    /// A renderable group: a contiguous prose run (one selectable text view), a code card, or a table.
    enum Group { case prose([Block]); case code(String, String?); case table([String], [[String]], [TextAlignment]) }

    /// Fold consecutive prose blocks together; code/table break the run.
    static func grouped(_ blocks: [Block]) -> [Group] {
        var out: [Group] = []; var run: [Block] = []
        func flush() { if !run.isEmpty { out.append(.prose(run)); run = [] } }
        for b in blocks {
            switch b {
            case .code(let c, let l): flush(); out.append(.code(c, l))
            case .table(let h, let r, let a): flush(); out.append(.table(h, r, a))
            default: run.append(b)
            }
        }
        flush(); return out
    }

    // MARK: table
    private func align(_ a: TextAlignment) -> Alignment {
        switch a { case .leading: .leading; case .center: .center; case .trailing: .trailing }
    }
    private func tableView(headers: [String], rows: [[String]], aligns: [TextAlignment]) -> some View {
        let cols = headers.count
        let minTableWidth = max(CGFloat(cols) * 150, 420)
        func a(_ i: Int) -> TextAlignment { i < aligns.count ? aligns[i] : .leading }
        return ScrollView(.horizontal, showsIndicators: true) {
            VStack(spacing: 0) {
                Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                    GridRow {
                        ForEach(0..<cols, id: \.self) { c in
                            Text(inline(headers[c]))
                                .font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(Tok.ink)
                                .multilineTextAlignment(a(c))
                                .frame(minWidth: 120, maxWidth: .infinity, alignment: align(a(c)))
                                .padding(.horizontal, 12).padding(.vertical, 7)
                                .background(Tok.fillTertiary)
                                .overlay(alignment: .leading) { if c > 0 { Tok.separator.frame(width: Tok.hairline) } }
                        }
                    }
                    ForEach(Array(rows.enumerated()), id: \.offset) { ri, row in
                        GridRow {
                            ForEach(0..<cols, id: \.self) { c in
                                Text(inline(c < row.count ? row[c] : ""))
                                    .font(TokFont.text(13)).foregroundStyle(Tok.inkSecondary)
                                    .multilineTextAlignment(a(c))
                                    .lineSpacing(2)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(minWidth: 120, maxWidth: .infinity, alignment: align(a(c)))
                                    .padding(.horizontal, 12).padding(.vertical, 6)
                                    .background(ri.isMultiple(of: 2) ? Color.clear : Tok.fillTertiary.opacity(0.35))
                                    .overlay(alignment: .top) { Tok.separator.frame(height: Tok.hairline) }
                                    .overlay(alignment: .leading) { if c > 0 { Tok.separator.frame(width: Tok.hairline) } }
                            }
                        }
                    }
                }
            }
            .frame(minWidth: minTableWidth, alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        }
        .padding(.vertical, 2)
    }

    // MARK: parsing
    /// Parsed-block cache — chat transcripts re-render the same text on every scroll/stream tick;
    /// re-running the block parser each time is a real cost on long chats. Bounded, main-thread only.
    private static var parseCache: [String: [Block]] = [:]

    static func parse(_ src: String) -> [Block] {
        if let cached = parseCache[src] { return cached }
        let blocks = parseUncached(src)
        if parseCache.count > 240 { parseCache.removeAll(keepingCapacity: true) }
        parseCache[src] = blocks
        return blocks
    }

    private static func parseUncached(_ src: String) -> [Block] {
        var blocks: [Block] = []
        var para: [String] = []
        var bullets: [String] = []
        var ordered: [String] = []
        var orderedStart = 1
        func flushPara() { if !para.isEmpty { blocks.append(.paragraph(para.joined(separator: "\n"))); para = [] } }
        func flushLists() {
            if !bullets.isEmpty { blocks.append(.bullets(bullets)); bullets = [] }
            if !ordered.isEmpty { blocks.append(.ordered(start: orderedStart, items: ordered)); ordered = []; orderedStart = 1 }
        }
        func flushAll() { flushPara(); flushLists() }

        let lines = src.components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") {                                   // fenced code
                flushAll()
                let lang = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                var code: [String] = []; i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") { code.append(lines[i]); i += 1 }
                blocks.append(.code(code.joined(separator: "\n"), lang: lang.isEmpty ? nil : lang)); i += 1; continue
            }
            if i + 1 < lines.count, isTableRow(trimmed), isTableSeparator(lines[i + 1].trimmingCharacters(in: .whitespaces)) {
                flushAll()
                let headers = tableCells(trimmed)
                let aligns = tableAligns(lines[i + 1].trimmingCharacters(in: .whitespaces))
                i += 2
                var rows: [[String]] = []
                while i < lines.count, isTableRow(lines[i].trimmingCharacters(in: .whitespaces)) {
                    rows.append(tableCells(lines[i].trimmingCharacters(in: .whitespaces)))
                    i += 1
                }
                if !headers.isEmpty { blocks.append(.table(headers: headers, rows: rows, aligns: aligns)) }
                continue
            }
            if let m = headingMatch(trimmed) { flushAll(); blocks.append(.heading(level: m.0, text: m.1)); i += 1; continue }
            if trimmed == "---" || trimmed == "***" || trimmed == "___" { flushAll(); blocks.append(.rule); i += 1; continue }
            if trimmed.hasPrefix("> ") { flushPara(); flushLists(); blocks.append(.quote(String(trimmed.dropFirst(2)))); i += 1; continue }
            if let item = bulletMatch(trimmed) { flushPara(); if !ordered.isEmpty { flushLists() }; bullets.append(item); i += 1; continue }
            if let m = orderedMatch(trimmed) { flushPara(); if !bullets.isEmpty { flushLists() }; if ordered.isEmpty { orderedStart = m.0 }; ordered.append(m.1); i += 1; continue }
            if trimmed.isEmpty { flushAll(); i += 1; continue }
            flushLists(); para.append(line); i += 1
        }
        flushAll()
        return blocks
    }

    private static func headingMatch(_ s: String) -> (Int, String)? {
        var level = 0; var idx = s.startIndex
        while idx < s.endIndex, s[idx] == "#", level < 6 { level += 1; idx = s.index(after: idx) }
        guard level > 0, level <= 4, idx < s.endIndex, s[idx] == " " else { return nil }   // chat: h1–h4 only
        return (level, String(s[s.index(after: idx)...]))
    }
    private static func bulletMatch(_ s: String) -> String? {
        for p in ["- ", "* ", "+ "] where s.hasPrefix(p) { return String(s.dropFirst(2)) }
        return nil
    }
    private static func orderedMatch(_ s: String) -> (Int, String)? {
        guard let dot = s.firstIndex(where: { $0 == "." || $0 == ")" }) else { return nil }
        let numStr = s[s.startIndex..<dot]
        guard !numStr.isEmpty, numStr.allSatisfy(\.isNumber), let n = Int(numStr),
              s.index(after: dot) < s.endIndex, s[s.index(after: dot)] == " " else { return nil }
        return (n, String(s[s.index(dot, offsetBy: 2)...]))
    }
    private static func isTableRow(_ s: String) -> Bool { s.contains("|") && tableCells(s).count > 1 }
    private static func isTableSeparator(_ s: String) -> Bool {
        let cells = tableCells(s)
        return cells.count > 1 && cells.allSatisfy { cell in
            let stripped = cell.replacingOccurrences(of: ":", with: "")
            return stripped.count >= 3 && stripped.allSatisfy { $0 == "-" }
        }
    }
    private static func tableAligns(_ s: String) -> [TextAlignment] {
        tableCells(s).map { cell in
            let l = cell.hasPrefix(":"); let r = cell.hasSuffix(":")
            if l && r { return .center }; if r { return .trailing }; return .leading
        }
    }
    private static func tableCells(_ s: String) -> [String] {
        var body = s.trimmingCharacters(in: .whitespaces)
        if body.hasPrefix("|") { body.removeFirst() }
        if body.hasSuffix("|") { body.removeLast() }
        return body.split(separator: "|", omittingEmptySubsequences: false)
            .map { String($0).trimmingCharacters(in: .whitespaces) }
    }

    // MARK: inline (bold / code / clickable paths) — NOT italic/links (matches chat renderInline)
    func inline(_ s: String) -> AttributedString { Self.inline(s, projectRoot: projectRoot, baseSize: baseSize, bodyColor: bodyColor) }

    static func inline(_ s: String, projectRoot: String?, baseSize: CGFloat, bodyColor: Color) -> AttributedString {
        var out = AttributedString()
        let chars = Array(s)
        var i = 0
        var plain = ""
        func flush() { if !plain.isEmpty { out += linkify(plain, projectRoot: projectRoot, baseSize: baseSize, bodyColor: bodyColor); plain = "" } }
        while i < chars.count {
            // `code`
            if chars[i] == "`", let close = nextIndex(chars, of: "`", from: i + 1) {
                flush()
                out += codeOrPath(String(chars[(i + 1)..<close]), projectRoot: projectRoot, baseSize: baseSize)
                i = close + 1; continue
            }
            // **bold**
            if chars[i] == "*", i + 1 < chars.count, chars[i + 1] == "*", let close = nextDouble(chars, from: i + 2) {
                flush()
                var b = AttributedString(String(chars[(i + 2)..<close]))
                b.font = .system(size: baseSize, weight: .semibold); b.foregroundColor = bodyColor
                out += b
                i = close + 2; continue
            }
            plain.append(chars[i]); i += 1
        }
        flush()
        return out
    }

    private static func nextIndex(_ a: [Character], of ch: Character, from: Int) -> Int? {
        var i = from; while i < a.count { if a[i] == ch { return i }; i += 1 }; return nil
    }
    private static func nextDouble(_ a: [Character], from: Int) -> Int? {
        var i = from; while i + 1 < a.count { if a[i] == "*" && a[i + 1] == "*" { return i }; i += 1 }; return nil
    }

    /// A `` `code` `` span: a path link if it looks like a path, else a fill-tertiary code highlight.
    private static func codeOrPath(_ inner: String, projectRoot: String?, baseSize: CGFloat) -> AttributedString {
        let codeSize = baseSize * 0.92
        if ToolViz.looksLikePath(inner), let link = fileURL(inner, projectRoot) {
            var a = AttributedString(inner)
            a.font = .system(size: codeSize, weight: .medium, design: .monospaced)
            a.foregroundColor = Tok.blue; a.underlineStyle = .single; a.link = link
            return a
        }
        var a = AttributedString(inner)
        a.font = .system(size: codeSize, weight: .medium, design: .monospaced)
        a.foregroundColor = Tok.ink; a.backgroundColor = Tok.fillTertiary
        return a
    }

    /// Linkify bare file paths in a plain run (absolute / `~` / dotted-relative with a slash).
    private static func linkify(_ s: String, projectRoot: String?, baseSize: CGFloat, bodyColor: Color) -> AttributedString {
        func plainRun(_ t: String) -> AttributedString { var a = AttributedString(t); a.font = .system(size: baseSize); a.foregroundColor = bodyColor; return a }
        let pattern = #"(?:(?:~|\.\.?)?/)[^\s)\]}'"`,;]+|[A-Za-z0-9_.@\-]+(?:/[A-Za-z0-9_.@\-]+)+"#
        guard let re = try? NSRegularExpression(pattern: pattern) else { return plainRun(s) }
        let ns = s as NSString
        var out = AttributedString(); var last = 0
        for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
            if m.range.location > last { out += plainRun(ns.substring(with: NSRange(location: last, length: m.range.location - last))) }
            let full = ns.substring(with: m.range)
            var tok = full
            while let c = tok.last, ".,;:".contains(c) { tok.removeLast() }   // don't eat trailing punctuation
            if !tok.isEmpty, let link = fileURL(tok, projectRoot) {
                var a = AttributedString(tok); a.font = .system(size: baseSize)
                a.foregroundColor = Tok.blue; a.underlineStyle = .single; a.link = link
                out += a
                if full.count > tok.count { out += plainRun(String(full.dropFirst(tok.count))) }
            } else {
                out += plainRun(full)
            }
            last = m.range.location + m.range.length
        }
        if last < ns.length { out += plainRun(ns.substring(from: last)) }
        return out
    }

    /// A `maestrofile://open?p=<abs>` URL for a path, resolved against the project root. nil when a
    /// relative path can't be resolved (no root) — then it stays plain text, not a dead link.
    private static func fileURL(_ p: String, _ root: String?) -> URL? {
        guard let abs = ToolViz.absolutePath(p, root: root),
              let enc = abs.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return nil }
        return URL(string: "maestrofile://open?p=\(enc)")
    }
}

/// A fenced code block as a header-barred card (uppercase lang label + hover copy), horizontally
/// scrollable, mono 12.5/1.6 in `--ink` over `--bg-grouped` — mirrors the chat `CodeCard`.
struct CodeCardView: View {
    let code: String
    var lang: String?
    private let previewLimit = 16_000
    @State private var expanded = false

    private var needsGuard: Bool { code.count > previewLimit }
    private var visibleCode: String {
        guard needsGuard, !expanded else { return code }
        return String(code.prefix(previewLimit)) + "\n\n[...]"
    }
    private var tall: Bool { visibleCode.components(separatedBy: "\n").count > 18 }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text((lang ?? "code").uppercased())
                    .font(.system(size: 11, weight: .semibold, design: .monospaced)).tracking(0.4)
                    .foregroundStyle(Tok.inkTertiary)
                if needsGuard {
                    Text(expanded ? "FULL" : "\(compactCount(previewLimit)) / \(compactCount(code.count))")
                        .font(.system(size: 10.5, weight: .medium, design: .monospaced))
                        .foregroundStyle(Tok.inkTertiary)
                }
                Spacer(minLength: 8)
                if needsGuard {
                    Button(expanded ? "Collapse" : "Show full") {
                        var transaction = Transaction()
                        transaction.disablesAnimations = true
                        withTransaction(transaction) { expanded.toggle() }
                    }
                    .buttonStyle(.plain)
                    .font(TokFont.text(TokFont.caption, .semibold))
                    .foregroundStyle(Tok.blue)
                }
                CopyChip(text: code)   // always visible
            }
            .padding(.leading, 12).padding(.trailing, 8).frame(height: 30)
            .background(Tok.ink.opacity(0.04))
            .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }

            // Selectable, horizontally scrollable; tall blocks cap at 360pt and scroll vertically.
            if tall {
                ScrollView([.horizontal, .vertical], showsIndicators: true) { codeBody }.frame(height: 360)
            } else {
                ScrollView(.horizontal, showsIndicators: false) { codeBody }
            }
        }
        .background(Tok.bgGrouped)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        .padding(.vertical, 3)
    }

    private var codeBody: some View {
        SelectableText(attributed: NSMarkdown.code(visibleCode), wraps: false)
            .padding(.horizontal, 13).padding(.vertical, 11)
    }

    private func compactCount(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fm", Double(n) / 1_000_000) }
        if n >= 1_000 { return "\(n / 1_000)k" }
        return "\(n)"
    }
}
