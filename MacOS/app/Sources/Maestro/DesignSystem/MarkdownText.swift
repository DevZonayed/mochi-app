import SwiftUI

/// A lightweight block-level Markdown renderer for chat messages — headings, paragraphs, bullet/
/// ordered lists, fenced code blocks, and inline (bold/italic/`code`/links). SwiftUI's
/// `AttributedString(markdown:)` only does *inline* syntax, so `###`/lists/code-fences would show
/// raw; this parses blocks and styles each with the right type ramp + a softened body ink.
struct MarkdownText: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(Self.parse(text).enumerated()), id: \.offset) { _, block in
                view(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: blocks
    enum Block: Hashable {
        case heading(level: Int, text: String)
        case paragraph(String)
        case code(String, lang: String?)
        case bullets([String])
        case ordered([String])
        case quote(String)
        case rule
    }

    @ViewBuilder private func view(_ b: Block) -> some View {
        switch b {
        case .heading(let level, let t):
            Text(Self.inline(t))
                .font(headingFont(level)).foregroundStyle(Tok.ink)
                .padding(.top, level <= 2 ? 4 : 2)
        case .paragraph(let t):
            Text(Self.inline(t)).font(TokFont.text(14)).foregroundStyle(Tok.inkBody)
                .lineSpacing(3.5).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        case .code(let code, _):
            Text(code).font(TokFont.mono(12.5)).foregroundStyle(Tok.inkBody)
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                .padding(10).background(Tok.fillTertiary)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        case .bullets(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, it in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("•").font(TokFont.text(14)).foregroundStyle(Tok.inkTertiary)
                        Text(Self.inline(it)).font(TokFont.text(14)).foregroundStyle(Tok.inkBody).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case .ordered(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { i, it in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text("\(i + 1).").font(TokFont.mono(13)).foregroundStyle(Tok.inkTertiary)
                        Text(Self.inline(it)).font(TokFont.text(14)).foregroundStyle(Tok.inkBody).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        case .quote(let t):
            Text(Self.inline(t)).font(TokFont.text(14)).foregroundStyle(Tok.inkSecondary)
                .padding(.leading, 10).overlay(alignment: .leading) { Tok.separatorStrong.frame(width: 2.5) }
        case .rule:
            Tok.separator.frame(height: Tok.hairline).padding(.vertical, 2)
        }
    }

    private func headingFont(_ level: Int) -> Font {
        switch level { case 1: TokFont.display(19, .bold); case 2: TokFont.display(16.5, .bold); case 3: TokFont.text(15, .semibold); default: TokFont.text(14, .semibold) }
    }

    // MARK: parsing
    static func parse(_ src: String) -> [Block] {
        var blocks: [Block] = []
        var para: [String] = []
        var bullets: [String] = []
        var ordered: [String] = []
        func flushPara() { if !para.isEmpty { blocks.append(.paragraph(para.joined(separator: "\n"))); para = [] } }
        func flushLists() {
            if !bullets.isEmpty { blocks.append(.bullets(bullets)); bullets = [] }
            if !ordered.isEmpty { blocks.append(.ordered(ordered)); ordered = [] }
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
            if let m = headingMatch(trimmed) { flushAll(); blocks.append(.heading(level: m.0, text: m.1)); i += 1; continue }
            if trimmed == "---" || trimmed == "***" || trimmed == "___" { flushAll(); blocks.append(.rule); i += 1; continue }
            if trimmed.hasPrefix("> ") { flushPara(); flushLists(); blocks.append(.quote(String(trimmed.dropFirst(2)))); i += 1; continue }
            if let item = bulletMatch(trimmed) { flushPara(); if !ordered.isEmpty { flushLists() }; bullets.append(item); i += 1; continue }
            if let item = orderedMatch(trimmed) { flushPara(); if !bullets.isEmpty { flushLists() }; ordered.append(item); i += 1; continue }
            if trimmed.isEmpty { flushAll(); i += 1; continue }
            flushLists(); para.append(line); i += 1
        }
        flushAll()
        return blocks
    }

    private static func headingMatch(_ s: String) -> (Int, String)? {
        var level = 0; var idx = s.startIndex
        while idx < s.endIndex, s[idx] == "#", level < 6 { level += 1; idx = s.index(after: idx) }
        guard level > 0, idx < s.endIndex, s[idx] == " " else { return nil }
        return (level, String(s[s.index(after: idx)...]))
    }
    private static func bulletMatch(_ s: String) -> String? {
        for p in ["- ", "* ", "+ "] where s.hasPrefix(p) { return String(s.dropFirst(2)) }
        return nil
    }
    private static func orderedMatch(_ s: String) -> String? {
        guard let dot = s.firstIndex(of: "."), s[s.startIndex..<dot].allSatisfy(\.isNumber), !s[s.startIndex..<dot].isEmpty,
              s.index(after: dot) < s.endIndex, s[s.index(after: dot)] == " " else { return nil }
        return String(s[s.index(dot, offsetBy: 2)...])
    }

    /// Inline markdown (bold/italic/`code`/links) → AttributedString, with `code` runs styled.
    static func inline(_ s: String) -> AttributedString {
        var a = (try? AttributedString(markdown: s, options: .init(allowsExtendedAttributes: true, interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible))) ?? AttributedString(s)
        for run in a.runs where run.inlinePresentationIntent?.contains(.code) == true {
            a[run.range].font = .system(size: 12.5, design: .monospaced)
            a[run.range].foregroundColor = Tok.anthropic
        }
        return a
    }
}
