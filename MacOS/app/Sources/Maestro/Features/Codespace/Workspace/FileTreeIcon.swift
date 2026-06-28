import SwiftUI
import AppKit

/// A colored brand-label tile per file type (VS Code Material-Icon style), ported 1:1 from
/// `lib/fileIcons.tsx` ICONS — used by the file tree, tabs, and file-viewer header.
struct FileTreeIcon: View {
    let name: String
    var size: CGFloat = 14
    var body: some View {
        let s = Self.spec(name)
        Text(s.label)
            .font(.system(size: Self.fontFor(s.label.count), weight: .heavy, design: .monospaced))
            .tracking(-0.3)
            .foregroundStyle(s.fg)
            .frame(width: size, height: size)
            .background(s.bg)
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
    }

    struct Spec { let bg: Color; let fg: Color; let label: String }

    static func fontFor(_ len: Int) -> CGFloat { len <= 2 ? 8 : len == 3 ? 6.5 : 5.5 }

    static func ext(_ name: String) -> String {
        let base = (name.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? name).lowercased()
        if base == "dockerfile" || base.hasPrefix("dockerfile.") || base.hasSuffix(".dockerfile") { return "dockerfile" }
        if base == "makefile" || base == "gnumakefile" { return "makefile" }
        if base == "package.json" { return "npm" }
        if base.hasPrefix(".env") { return "env" }
        if let dot = base.lastIndex(of: "."), dot != base.startIndex { return String(base[base.index(after: dot)...]) }
        return ""
    }

    static func spec(_ name: String) -> Spec {
        let e = ext(name)
        if let i = icons[e] { return Spec(bg: hex(i.0), fg: hex(i.1), label: i.2) }
        return Spec(bg: Tok.fillTertiary, fg: Tok.inkSecondary, label: e.isEmpty ? "•" : String(e.prefix(4)).uppercased())
    }

    private static func hex(_ s: String) -> Color { Color(nsColor: NSColor(hex: s)) }

    // (bg, fg, label) — verbatim from fileIcons.tsx ICONS.
    private static let icons: [String: (String, String, String)] = [
        "js": ("#f0db4f", "#3a3a00", "JS"), "mjs": ("#f0db4f", "#3a3a00", "JS"), "cjs": ("#f0db4f", "#3a3a00", "JS"),
        "jsx": ("#61dafb", "#08303f", "JSX"), "ts": ("#3178c6", "#ffffff", "TS"), "tsx": ("#3178c6", "#bfe0ff", "TSX"),
        "html": ("#e34f26", "#ffffff", "<>"), "htm": ("#e34f26", "#ffffff", "<>"),
        "css": ("#1572b6", "#ffffff", "#"), "scss": ("#cd6799", "#ffffff", "#"), "sass": ("#cd6799", "#ffffff", "#"), "less": ("#1d365d", "#ffffff", "#"),
        "vue": ("#41b883", "#0b3a26", "V"), "svelte": ("#ff3e00", "#ffffff", "S"), "astro": ("#ff5d01", "#ffffff", "A"),
        "json": ("#cbb723", "#2a2700", "{}"), "jsonc": ("#cbb723", "#2a2700", "{}"), "json5": ("#cbb723", "#2a2700", "{}"),
        "npm": ("#cb3837", "#ffffff", "NPM"),
        "yaml": ("#cb171e", "#ffffff", "YML"), "yml": ("#cb171e", "#ffffff", "YML"), "toml": ("#9c4221", "#ffffff", "TML"),
        "xml": ("#f1662a", "#ffffff", "XML"), "ini": ("#6d6d6d", "#ffffff", "INI"), "env": ("#ecd53f", "#3a3500", "ENV"),
        "csv": ("#1d6f42", "#ffffff", "CSV"), "tsv": ("#1d6f42", "#ffffff", "TSV"), "sql": ("#336791", "#ffffff", "SQL"),
        "graphql": ("#e10098", "#ffffff", "GQL"), "gql": ("#e10098", "#ffffff", "GQL"), "proto": ("#5a67d8", "#ffffff", "PB"),
        "py": ("#3776ab", "#ffe873", "PY"), "go": ("#00add8", "#ffffff", "GO"), "rs": ("#222222", "#deae8e", "RS"),
        "rb": ("#cc342d", "#ffffff", "RB"), "java": ("#ea2d2e", "#ffffff", "JV"), "kt": ("#7f52ff", "#ffffff", "KT"),
        "php": ("#777bb4", "#ffffff", "PHP"), "c": ("#5577aa", "#ffffff", "C"), "h": ("#5577aa", "#ffffff", "H"),
        "cpp": ("#00599c", "#ffffff", "C++"), "cc": ("#00599c", "#ffffff", "C++"), "hpp": ("#00599c", "#ffffff", "H++"),
        "cs": ("#178600", "#ffffff", "C#"), "swift": ("#f05138", "#ffffff", "SW"), "dart": ("#0175c2", "#ffffff", "DRT"),
        "sh": ("#4eaa25", "#ffffff", "SH"), "bash": ("#4eaa25", "#ffffff", "SH"), "zsh": ("#4eaa25", "#ffffff", "SH"),
        "lua": ("#000080", "#ffffff", "LUA"), "r": ("#276dc3", "#ffffff", "R"), "ex": ("#6e4a7e", "#ffffff", "EX"), "exs": ("#6e4a7e", "#ffffff", "EX"),
        "dockerfile": ("#2496ed", "#ffffff", "DKR"), "makefile": ("#6d8086", "#ffffff", "MK"),
        "md": ("#519aba", "#ffffff", "MD"), "mdx": ("#519aba", "#ffffff", "MDX"), "txt": ("#7d7d7d", "#ffffff", "TXT"),
        "pdf": ("#e34f26", "#ffffff", "PDF"), "rst": ("#7d7d7d", "#ffffff", "RST"),
        "png": ("#a259ff", "#ffffff", "PNG"), "jpg": ("#a259ff", "#ffffff", "JPG"), "jpeg": ("#a259ff", "#ffffff", "JPG"),
        "gif": ("#a259ff", "#ffffff", "GIF"), "webp": ("#a259ff", "#ffffff", "WEB"), "ico": ("#a259ff", "#ffffff", "ICO"),
        "svg": ("#ffb13b", "#3a2a00", "SVG"),
        "zip": ("#b8860b", "#ffffff", "ZIP"), "tar": ("#b8860b", "#ffffff", "TAR"), "gz": ("#b8860b", "#ffffff", "GZ"), "lock": ("#6d6d6d", "#ffd343", "LCK"),
    ]
}
