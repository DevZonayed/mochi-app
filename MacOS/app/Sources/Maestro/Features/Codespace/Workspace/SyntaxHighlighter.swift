import SwiftUI
import AppKit

/// A lightweight, dependency-free source highlighter → AttributedString, themed to the app palette
/// (keyword purple, string green, number orange, comment ink-tertiary italic) to approximate the
/// renderer's hljs+`HLJS_CSS` mapping. Not a full grammar — comments / strings / numbers / keywords.
enum SyntaxHighlighter {
    static func attributed(_ code: String, name: String, size: CGFloat = 12.5) -> AttributedString {
        var out = AttributedString(code)
        out.font = .system(size: size, design: .monospaced)
        out.foregroundColor = Tok.ink
        let ns = code as NSString
        let hash = hashCommentLangs.contains(FileTreeIcon.ext(name))

        // One left-to-right pass: comments/strings consume first so keywords/numbers inside them
        // aren't recolored.
        let commentAlt = hash ? #"//[^\n]*|/\*[\s\S]*?\*/|#[^\n]*"# : #"//[^\n]*|/\*[\s\S]*?\*/"#
        let pattern = "(?<cm>\(commentAlt))|(?<st>\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*'|`(?:\\\\.|[^`\\\\])*`)|(?<nm>\\b\\d[\\d_.]*\\b)|(?<id>[A-Za-z_][A-Za-z0-9_]*)"
        guard let re = try? NSRegularExpression(pattern: pattern) else { return out }
        re.enumerateMatches(in: code, range: NSRange(location: 0, length: ns.length)) { m, _, _ in
            guard let m else { return }
            func colorize(_ name: String, _ color: Color, italic: Bool = false) -> Bool {
                let r = m.range(withName: name)
                guard r.location != NSNotFound, let sr = Range(r, in: out) else { return false }
                out[sr].foregroundColor = color
                if italic { out[sr].font = .system(size: size, design: .monospaced).italic() }
                return true
            }
            if colorize("cm", Tok.inkTertiary, italic: true) { return }
            if colorize("st", Tok.green) { return }
            if colorize("nm", Tok.orange) { return }
            let idRange = m.range(withName: "id")
            if idRange.location != NSNotFound, let sr = Range(idRange, in: out) {
                let word = ns.substring(with: idRange)
                if literals.contains(word) { out[sr].foregroundColor = Tok.orange }
                else if keywords.contains(word) { out[sr].foregroundColor = Tok.purple }
                else if types.contains(word) { out[sr].foregroundColor = Tok.teal }
            }
        }
        return out
    }

    private static let hashCommentLangs: Set<String> = ["py", "sh", "bash", "zsh", "rb", "yaml", "yml", "toml", "ini", "r", "ex", "exs", "makefile", "dockerfile", "env"]

    private static let keywords: Set<String> = [
        "func", "function", "fn", "def", "let", "var", "const", "val", "return", "if", "else", "elif",
        "for", "while", "switch", "case", "default", "break", "continue", "struct", "class", "enum",
        "protocol", "interface", "extension", "trait", "impl", "import", "from", "export", "package",
        "namespace", "use", "mod", "pub", "public", "private", "protected", "internal", "static", "final",
        "abstract", "async", "await", "try", "catch", "finally", "throw", "throws", "rethrows", "guard",
        "defer", "in", "of", "as", "is", "new", "delete", "typeof", "instanceof", "and", "or", "not",
        "lambda", "pass", "with", "yield", "match", "where", "do", "then", "end", "fi", "done", "elseif",
        "override", "required", "lazy", "weak", "unowned", "mutating", "extends", "implements", "type",
    ]
    private static let literals: Set<String> = ["true", "false", "nil", "null", "undefined", "None", "True", "False", "self", "this", "super"]
    private static let types: Set<String> = [
        "Int", "String", "Bool", "Double", "Float", "Void", "Any", "Array", "Dictionary", "Set", "Optional",
        "number", "string", "boolean", "object", "void", "unknown", "never", "Promise", "char", "int", "bool",
        "float", "double", "long", "short", "byte", "uint", "usize", "i32", "i64", "u32", "u64", "f32", "f64",
    ]
}
