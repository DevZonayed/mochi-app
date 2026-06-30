import SwiftUI
import AppKit

// MARK: - Tool-call visualization model
//
// Ports the desktop app's two label layers — `electron/tool-label.ts` (intent extraction) and
// `src/lib/toolDisplay.ts` (name → verb/glyph) — plus the `fileChip.tsx` extension→colour map.
// The brain already cleans Claude tools (`text` = a human label, `cmd` = the raw command); Codex
// tools arrive RAW (`text` = `/bin/zsh -lc "…"`), so we additionally unwrap the shell here so the
// row reads "Run · grep -rn …", not the wrapper.
//
// One deliberate departure from a 1:1 port: verb TINTS use per-verb iOS accents (Read=blue,
// Edit=amber, Write=green …) rather than the reference's two-tone teal/blue grouping — a native
// macOS choice that makes the glyph column scan by action. Intent extraction, glyphs and the
// file-colour map are faithful.

enum ToolViz {
    /// `{ short verb, SF Symbol, tint, isFile, mono }` for a tool name. Regex order matters —
    /// first match wins (mirrors `toolDisplay`). `isFile` ⇒ render the detail as a file chip;
    /// `isFileWrite` ⇒ the tool actually wrote/edited a file (vs just read it).
    struct Display {
        let short: String; let symbol: String; let tint: Color; let isFile: Bool; let mono: Bool
        var isFileWrite: Bool { isFile && (short == "Edit" || short == "Write") }
    }

    static func display(_ rawName: String?) -> Display {
        let raw = (rawName ?? "").replacingOccurrences(of: #"^mcp__[^_]+__"#, with: "", options: .regularExpression)
        let n = raw.lowercased()
        func m(_ pat: String) -> Bool { n.range(of: pat, options: .regularExpression) != nil }

        // Tints/glyphs mirror `lib/toolDisplay.ts` EXACTLY: file ops + search = teal, web = indigo,
        // image/agent = purple, plan/run = blue. Read & Write share the `doc` (file) glyph like the
        // reference. (Earlier this file used per-verb iOS accents — that departure is now removed.)
        if m("multiedit|multi_edit|^edit|apply_patch|str_replace") { return .init(short: "Edit",  symbol: "pencil",          tint: Tok.teal,   isFile: true,  mono: false) }
        if m("^write|create_file|^notebook")                       { return .init(short: "Write", symbol: "doc",             tint: Tok.teal,   isFile: true,  mono: false) }
        if m("^read|^view|^cat|open_file")                          { return .init(short: "Read",  symbol: "doc",             tint: Tok.teal,   isFile: true,  mono: false) }
        if m("grep|^search$|ripgrep")                               { return .init(short: "Search",symbol: "magnifyingglass", tint: Tok.teal,   isFile: false, mono: false) }
        if m("glob|^ls$|list_dir|list_files|^find")                 { return .init(short: "Find",  symbol: "magnifyingglass", tint: Tok.teal,   isFile: false, mono: false) }
        if m("websearch|web_search")                                { return .init(short: "Web search",symbol: "binoculars", tint: Tok.indigo, isFile: false, mono: false) }
        if m("webfetch|web_fetch|^fetch|^http")                     { return .init(short: "Fetch", symbol: "globe",           tint: Tok.indigo, isFile: false, mono: false) }
        if m("browser|navigate|snapshot|playwright")                { return .init(short: "Browser",symbol: "globe",          tint: Tok.indigo, isFile: false, mono: false) }
        if m("image|photo|picture|generate_image")                  { return .init(short: "Image", symbol: "photo",           tint: Tok.purple, isFile: false, mono: false) }
        if m("todo")                                                { return .init(short: "Plan",  symbol: "checkmark.circle",tint: Tok.blue,   isFile: false, mono: false) }
        if m("task|subagent|^agent|dispatch")                       { return .init(short: "Agent", symbol: "sparkles",        tint: Tok.purple, isFile: false, mono: false) }
        if m("schedule")                                            { return .init(short: "Schedule",symbol:"calendar.badge.clock", tint: Tok.orange, isFile: false, mono: false) }
        if m("wa_|whatsapp")                                        { return .init(short: "WhatsApp",symbol:"message.fill",   tint: hex("#25D366"), isFile: false, mono: false) }
        if m("bash|shell|^run|exec|terminal|command")               { return .init(short: "Run",   symbol: "terminal",        tint: Tok.blue,   isFile: false, mono: true) }
        let pretty = prettify(raw)
        return .init(short: pretty.isEmpty ? "Tool" : pretty, symbol: "command", tint: Tok.inkSecondary, isFile: false, mono: false)
    }

    static func isSkill(_ name: String?) -> Bool { (name ?? "").lowercased() == "skill" }

    /// "superpowers:brainstorming" → "Brainstorming".
    static func prettySkill(_ raw: String) -> String {
        let tail = (raw.split(separator: ":").last.map(String.init) ?? raw).replacingOccurrences(of: #"[-_]"#, with: " ", options: .regularExpression).trimmed
        return tail.isEmpty ? raw : tail.split(separator: " ").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: " ")
    }

    private static func prettify(_ raw: String) -> String {
        let s = raw.replacingOccurrences(of: #"[_-]+"#, with: " ", options: .regularExpression).trimmed
        return s.isEmpty ? "" : s.prefix(1).uppercased() + s.dropFirst()
    }

    /// `mcp__maestro__git_status` → `Git status` (renderer copy of the electron scrubber).
    static func scrubInternalMcp(_ s: String) -> String {
        guard !s.isEmpty else { return s }
        return s.replacing(regex: #"mcp__maestro__([A-Za-z0-9_]+)"#) { prettify($0) }
    }

    /// The display detail for a tool row: scrubbed, and for shell tools with a raw wrapper,
    /// unwrapped (`/bin/zsh -lc "grep …"` → `grep …`).
    static func detail(_ item: TranscriptItem) -> String {
        let scrubbed = scrubInternalMcp(item.text)
        let d = display(item.name)
        if d.mono && !d.isFile { return unwrapShell(scrubbed) }
        return scrubbed
    }

    /// Strip a leading shell wrapper so a Codex command reads as the command itself.
    static func unwrapShell(_ s: String) -> String {
        let t = s.trimmed
        guard let r = t.range(of: #"^(?:[^\s]*/)?(?:zsh|bash|sh)\s+-[A-Za-z]*c\s+"#, options: .regularExpression) else { return t }
        var inner = String(t[r.upperBound...]).trimmed
        if inner.count >= 2, let f = inner.first, (f == "\"" || f == "'"), inner.last == f { inner = String(inner.dropFirst().dropLast()) }
        return inner.isEmpty ? t : inner
    }

    // MARK: file helpers (ported from fileChip.tsx)

    static func baseName(_ p: String) -> String {
        let head = p.split(whereSeparator: { $0 == "?" || $0 == "#" }).first.map(String.init) ?? p
        return head.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init) ?? head
    }

    static func fileExt(_ name: String) -> String {
        let lower = baseName(name).lowercased()
        if lower.hasSuffix(".d.ts") { return "ts" }
        if lower.contains("dockerfile") { return "dockerfile" }
        // Dotfiles whose FIRST segment is a known styling key keep it (.env.local → env).
        if lower.hasPrefix("."), let key = lower.dropFirst().split(separator: ".").first.map(String.init),
           (extColorHex[key] != nil || extSymbol[key] != nil) { return key }
        if lower.contains(".") { return lower.split(separator: ".").last.map(String.init) ?? "" }
        if lower.hasPrefix(".") { return String(lower.dropFirst()) }   // .gitignore (no inner dot)
        return ""
    }

    /// extension → accent colour (the tile tint).
    static func extColor(_ name: String) -> Color {
        if let hexStr = extColorHex[fileExt(name)] { return hex(hexStr) }
        return Tok.inkTertiary
    }

    /// extension → foreground ink for the badge. The tile tint is fine on dark, but bright accents
    /// (js #F7DF1E, json amber, env, svg) wash out on a white tile in light mode — so darken the
    /// foreground there (luminance-clamped) while keeping the bright accent in dark mode.
    static func extInk(_ name: String) -> Color {
        let base = NSColor(hex: extColorHex[fileExt(name)] ?? "#8A9199").usingColorSpace(.sRGB) ?? NSColor(hex: "#8A9199")
        let lum = 0.2126 * base.redComponent + 0.7152 * base.greenComponent + 0.0722 * base.blueComponent
        let light = lum > 0.6
            ? NSColor(srgbRed: base.redComponent * 0.5, green: base.greenComponent * 0.5, blue: base.blueComponent * 0.5, alpha: 1)
            : base
        return Color.dyn(light, base)
    }

    /// extension → SF Symbol.
    static func fileSymbol(_ name: String) -> String { extSymbol[fileExt(name)] ?? "doc" }

    /// Binary/media types read better as a glyph than as extension text; code/text types show the
    /// extension string so TypeScript/Python/Go/Rust chips are distinguishable at a glance.
    private static let glyphExts: Set<String> = ["png", "jpg", "jpeg", "gif", "svg", "webp", "heic", "pdf", "zip", "lock"]
    static func badgeUsesSymbol(_ name: String) -> Bool { glyphExts.contains(fileExt(name)) }
    /// Badge text mirrors `fileChip.tsx` `(ext || 'file').slice(0,4)`.
    static func badgeText(_ name: String) -> String { let e = fileExt(name); return e.isEmpty ? "file" : String(e.prefix(4)) }

    private static let extSymbol: [String: String] = [
        "swift": "swift",
        "ts": "chevron.left.forwardslash.chevron.right", "tsx": "chevron.left.forwardslash.chevron.right",
        "js": "chevron.left.forwardslash.chevron.right", "jsx": "chevron.left.forwardslash.chevron.right",
        "cjs": "chevron.left.forwardslash.chevron.right", "mjs": "chevron.left.forwardslash.chevron.right",
        "json": "curlybraces", "jsonc": "curlybraces",
        "md": "doc.richtext", "mdx": "doc.richtext", "txt": "doc.text",
        "py": "chevron.left.forwardslash.chevron.right", "rb": "chevron.left.forwardslash.chevron.right",
        "go": "chevron.left.forwardslash.chevron.right", "rs": "chevron.left.forwardslash.chevron.right",
        "java": "cup.and.saucer.fill", "kt": "chevron.left.forwardslash.chevron.right",
        "c": "chevron.left.forwardslash.chevron.right", "cpp": "chevron.left.forwardslash.chevron.right",
        "h": "chevron.left.forwardslash.chevron.right", "cs": "chevron.left.forwardslash.chevron.right",
        "php": "chevron.left.forwardslash.chevron.right", "html": "chevron.left.forwardslash.chevron.right",
        "htm": "chevron.left.forwardslash.chevron.right",
        "css": "number", "scss": "number", "sass": "number",
        "sh": "terminal", "bash": "terminal", "zsh": "terminal",
        "yml": "list.bullet.indent", "yaml": "list.bullet.indent", "toml": "list.bullet.indent", "ini": "list.bullet.indent",
        "xml": "chevron.left.forwardslash.chevron.right", "sql": "cylinder.split.1x2",
        "png": "photo", "jpg": "photo", "jpeg": "photo", "webp": "photo", "heic": "photo",
        "gif": "photo.stack", "svg": "square.on.circle",
        "pdf": "doc.richtext.fill", "zip": "doc.zipper", "lock": "lock.fill",
        "env": "gearshape.2", "gitignore": "arrow.triangle.branch", "dockerfile": "shippingbox.fill",
        "plist": "list.bullet.rectangle", "csv": "tablecells", "vue": "chevron.left.forwardslash.chevron.right",
        "svelte": "chevron.left.forwardslash.chevron.right", "dart": "chevron.left.forwardslash.chevron.right",
    ]

    /// Aligned 1:1 with `lib/fileChip.tsx` EXT_COLOR (GitHub-linguist accents). Extensions not in
    /// this map fall back to ink-tertiary (matching the reference).
    private static let extColorHex: [String: String] = [
        "js": "#f7df1e", "cjs": "#f7df1e", "mjs": "#f7df1e", "jsx": "#61dafb", "ts": "#3178c6", "tsx": "#3178c6",
        "json": "#cbcb41", "jsonc": "#cbcb41", "py": "#3572a5", "rb": "#cc342d", "go": "#00add8", "rs": "#dea584", "php": "#777bb4",
        "html": "#e34c26", "htm": "#e34c26", "css": "#2965f1", "scss": "#c6538c", "sass": "#c6538c", "md": "#519aba", "mdx": "#519aba",
        "sh": "#89e051", "bash": "#89e051", "zsh": "#89e051", "yml": "#cb171e", "yaml": "#cb171e", "toml": "#9c4221", "ini": "#6d8086",
        "env": "#cbcb41", "sql": "#e38c00", "java": "#b07219", "kt": "#a97bff", "swift": "#f05138", "c": "#599bd6", "h": "#599bd6",
        "cpp": "#f34b7d", "cs": "#178600", "vue": "#41b883", "svelte": "#ff3e00", "dart": "#00b4ab", "xml": "#0060ac", "svg": "#ffb13b",
        "txt": "#9aa0a6", "lock": "#9aa0a6", "dockerfile": "#2496ed",
        // Media/binary kept for the file-tree (Phase 5); the transcript chip shows ext text either way.
        "png": "#26a69a", "jpg": "#26a69a", "jpeg": "#26a69a", "webp": "#26a69a", "heic": "#42a5f5",
        "gif": "#ab47bc", "pdf": "#e5252a", "zip": "#fbc02d", "csv": "#1d6f42", "gitignore": "#f05033", "plist": "#9aa0a6",
    ]

    /// Rejoin a project-relative path with the project root so a chip can be previewed. Absolute
    /// and `~`-paths pass through; relative paths join onto `root` (best-effort — a missing file
    /// just shows "File not found" in the preview window).
    static func absolutePath(_ rel: String, root: String?) -> String? {
        if rel.hasPrefix("/") { return rel }
        if rel.hasPrefix("~") { return (rel as NSString).expandingTildeInPath }
        guard let root, !root.isEmpty else { return nil }
        return (root as NSString).appendingPathComponent(rel)
    }

    /// True when the tool actually wrote/edited a file — routed through the `display()` table (which
    /// strips the `mcp__` prefix and classifies by verb) so non-file MCP tools whose names merely
    /// CONTAIN "edit"/"write" (credit_card_lookup, wa_edit_message…) aren't misclassified.
    static func isWriteFileTool(_ name: String?) -> Bool { display(name).isFileWrite }

    /// A detail string is path-shaped if it has a directory separator or a real extension — guards
    /// the file-chip strip against non-path payloads slipping through.
    static func looksLikePath(_ s: String) -> Bool {
        let t = s.trimmed
        guard !t.isEmpty, !t.contains("\n") else { return false }
        return t.contains("/") || !fileExt(t).isEmpty
    }

    static func hex(_ s: String) -> Color { Color(nsColor: NSColor(hex: s)) }
}

private extension String {
    /// Replace each regex match by transforming its first capture group (or whole match).
    func replacing(regex pattern: String, _ transform: (String) -> String) -> String {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return self }
        let ns = self as NSString
        var out = ""; var last = 0
        for m in re.matches(in: self, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
            let capRange = m.numberOfRanges > 1 ? m.range(at: 1) : m.range
            out += transform(ns.substring(with: capRange))
            last = m.range.location + m.range.length
        }
        out += ns.substring(from: last)
        return out
    }
}

// MARK: - Views

/// An extension-coloured file-type tile. Code/text types show the extension AS TEXT (so ts/py/go/
/// rs chips read distinctly, like the desktop FileBadge); binary/media types show a glyph. The
/// foreground ink is luminance-clamped so bright accents stay legible on a white tile in light mode.
struct FileTypeIcon: View {
    let name: String
    /// Larger variant for the file tree (Phase 5). The transcript chip uses the default.
    var compact: Bool = true
    var body: some View {
        Text(ToolViz.badgeText(name))
            .font(.system(size: compact ? 9 : 9.5, weight: .bold, design: .monospaced))
            .tracking(0.18)
            .foregroundStyle(ToolViz.extInk(name))
            .padding(.horizontal, 4)
            .frame(minWidth: 18, idealWidth: 18)
            .frame(height: 16)
            .background(ToolViz.extColor(name).opacity(0.22))
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
    }
}

/// A clickable file chip: coloured type tile · dimmed directory + emphasised basename. Tapping
/// opens the file in a native QuickLook preview window (any type: pdf/image/markdown/code…).
struct ToolFileChip: View {
    let rel: String
    var root: String?
    var preview: String? = nil
    var toolName: String? = nil
    var onOpenFile: (String) -> Void = { FilePreviewWindowController.shared.open(path: $0) }
    /// Cap the path width so head-truncation engages even inside an unconstrained FlowLayout.
    var maxPathWidth: CGFloat = 260
    @State private var hovering = false

    private var abs: String? { ToolViz.absolutePath(rel, root: root) }

    var body: some View {
        Button { if let abs { onOpenFile(abs) } } label: {
            HStack(spacing: 6) {
                FileTypeIcon(name: rel)
                Text(ToolViz.baseName(rel))
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundStyle(Tok.ink)
                    .lineLimit(1).truncationMode(.tail).frame(maxWidth: maxPathWidth, alignment: .leading)
            }
            .padding(.horizontal, hovering ? 7 : 0).padding(.vertical, hovering ? 3 : 0)
            .background(hovering ? Tok.fillSecondary : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }
        .buttonStyle(.plain).pressable(scale: 0.97)
        .onHover { hovering = $0 }
        .help((abs ?? rel) + " — click to preview")
    }
}

/// One agent tool call, rendered Conductor-style: tinted glyph · bold verb · file chip / detail ·
/// secondary command line · duration + status. Task sub-agents expand to their nested transcript.
struct ToolCallRow: View {
    let item: TranscriptItem
    var root: String?
    var onOpenFile: (String) -> Void = { FilePreviewWindowController.shared.open(path: $0) }
    var projectRoot: String? { root }
    @State private var expanded = false
    @State private var hovering = false

    private var d: ToolViz.Display { ToolViz.display(item.name) }
    private var skill: Bool { ToolViz.isSkill(item.name) }
    private var error: Bool { item.toolStatus == "error" }
    private var running: Bool { item.toolStatus == "running" }
    private var hasChildren: Bool { !(item.children ?? []).isEmpty }
    private var hasNest: Bool { hasChildren || !(item.result?.trimmed.isEmpty ?? true) }
    /// Auto-expanded while the sub-agent is RUNNING (mirrors SessionTranscript `isOpen`).
    private var isOpen: Bool { hasNest && (expanded || running) }
    /// The Response-block rail/tile tint (purple-mixed-with-separator).
    private var purpleRail: Color { Tok.purple.opacity(0.45) }
    private var detailText: String { skill ? ToolViz.prettySkill(ToolViz.scrubInternalMcp(item.text)) : ToolViz.detail(item) }
    private var showFile: Bool { d.isFile && !detailText.isEmpty && !skill }
    private var cleanCmd: String? { item.cmd.map(ToolViz.scrubInternalMcp).flatMap { $0.isEmpty ? nil : $0 } }
    private var hasCmd: Bool { cleanCmd != nil && !showFile && !skill }
    /// One-line, whitespace-collapsed preview of a sub-agent's final answer (capped at 180 chars).
    private var resultPreview: String? {
        guard let r = item.result?.replacing(regex: #"\s+"#, { _ in " " }).trimmed, !r.isEmpty else { return nil }
        return r.count > 180 ? String(r.prefix(180)) + "…" : r
    }

    var body: some View {
        VStack(alignment: .leading, spacing: isOpen ? 4 : 0) {
            // Only wrap the row in a (toggle) Button when it actually expands — a disabled Button
            // would also disable the nested file chip's Button, killing the click-to-preview.
            if hasNest {
                Button { withAnimation(.smooth(duration: 0.2)) { expanded.toggle() } } label: { row }
                    .buttonStyle(.plain)
            } else {
                row
            }

            if isOpen {
                // The sub-agent's OWN transcript + a purple "RESPONSE" card, behind a purple-tinted
                // indent rail (marginLeft 22, paddingLeft 12 — mirrors the reference).
                HStack(alignment: .top, spacing: 12) {
                    purpleRail.frame(width: 1.5)
                    VStack(alignment: .leading, spacing: 6) {
                        if let kids = item.children, !kids.isEmpty {
                            ForEach(kids) { TranscriptBlock(item: $0, projectRoot: projectRoot, onOpenFile: onOpenFile) }
                        }
                        if let r = item.result?.trimmed, !r.isEmpty { responseBlock(r) }
                    }
                }
                .padding(.leading, 22).padding(.top, 2).padding(.bottom, 4)
                .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
    }

    /// The purple-tinted "RESPONSE" card shown for a finished sub-agent.
    private func responseBlock(_ text: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                Image(systemName: "checkmark").font(.system(size: 9, weight: .bold)).foregroundStyle(Tok.purple)
                    .frame(width: 18, height: 18).background(Tok.purple.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                Text("RESPONSE").font(TokFont.text(TokFont.caption, .semibold)).tracking(0.7).foregroundStyle(Tok.purple)
            }
            GuardedMarkdownText(text: text, projectRoot: projectRoot, baseSize: 13, bodyColor: Tok.ink)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(ZStack { Tok.bgElevated; Tok.purple.opacity(0.04) })
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Tok.purple.opacity(0.18), lineWidth: Tok.hairline))
        }
    }

    private var row: some View {
        HStack(alignment: hasCmd ? .top : .center, spacing: 9) {
            Image(systemName: skill ? "sparkles" : d.symbol)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(skill ? Tok.purple : (error ? Tok.red : d.tint))
                .frame(width: 16).padding(.top, hasCmd ? 2 : 0)

            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 7) {
                    Text(skill ? "Skill" : d.short)
                        .font(TokFont.text(TokFont.footnote, .semibold))
                        .foregroundStyle(error ? Tok.red : Tok.ink)
                    if showFile {
                        ToolFileChip(rel: detailText, root: projectRoot, preview: item.preview, toolName: item.name, onOpenFile: onOpenFile)
                    } else if !detailText.isEmpty {
                        Text(detailText)
                            .font(d.mono && !hasCmd ? TokFont.mono(TokFont.footnote) : TokFont.text(TokFont.footnote))
                            .foregroundStyle(skill ? Tok.ink : Tok.inkSecondary)
                            .lineLimit(1).truncationMode(.tail)
                    }
                }
                if hasCmd, let c = cleanCmd {
                    Text(c).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkSecondary)
                        .lineLimit(1).truncationMode(.tail)
                        .padding(.horizontal, 6).padding(.vertical, 1.5)
                        .background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                }
                // Collapsed sub-agent (Task): a one-line preview of the agent's answer.
                if hasChildren, !expanded, !running, let preview = resultPreview {
                    Text("→ " + preview)
                        .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                        .lineLimit(1).truncationMode(.tail)
                }
            }
            Spacer(minLength: 6)
            trailing.padding(.top, hasCmd ? 2 : 0)
        }
        .padding(.horizontal, 7).padding(.vertical, 4)
        .background(hovering ? Tok.fillTertiary : Color.clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
    }

    @ViewBuilder private var trailing: some View {
        HStack(spacing: 6) {
            if running {
                Spinner(size: 11).tint(d.tint)
            } else if error {
                Icon(name: "x", size: 12).foregroundStyle(Tok.red)
            } else {
                if hasChildren {
                    let n = item.children?.count ?? 0
                    Text("\(n) step\(n == 1 ? "" : "s")").font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Tok.fillTertiary).clipShape(Capsule())
                    Icon(name: expanded ? "chevronDown" : "chevronRight", size: 11).foregroundStyle(Tok.inkTertiary)
                } else {
                    if let ms = item.durMs, ms > 0 {
                        Text(durLabel(ms)).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                    }
                    Image(systemName: "checkmark").font(.system(size: 10.5, weight: .bold)).foregroundStyle(Tok.green)
                }
            }
        }
    }

    private func durLabel(_ ms: Double) -> String {
        ms < 1000 ? "\(Int(ms))ms" : String(format: ms < 10000 ? "%.1fs" : "%.0fs", ms / 1000)
    }
}

/// Conductor-style strip of the files an agent WROTE this turn — coloured chips with a "+K more"
/// overflow, each opening a native preview. Shown under the collapsed WorkBar.
struct WorkChipBar: View {
    let work: [TranscriptItem]
    var root: String?
    var limit: Int = 8
    var onOpenFile: (String) -> Void = { FilePreviewWindowController.shared.open(path: $0) }

    private var chips: [(rel: String, item: TranscriptItem)] {
        var seen = Set<String>(); var out: [(String, TranscriptItem)] = []
        for it in work where ToolViz.isWriteFileTool(it.name) {       // edits/writes only (display-based)
            let rel = ToolViz.scrubInternalMcp(it.text).trimmed
            guard !rel.isEmpty, ToolViz.looksLikePath(rel), !seen.contains(rel) else { continue }
            seen.insert(rel); out.append((rel, it))
        }
        return out
    }

    var body: some View {
        let all = chips
        if !all.isEmpty {
            let shown = Array(all.prefix(limit))
            let extra = all.count - shown.count
            FlowLayout(spacing: 6, lineSpacing: 6) {
                ForEach(Array(shown.enumerated()), id: \.offset) { _, c in
                    ToolFileChip(rel: c.rel, root: root, preview: c.item.preview, toolName: c.item.name, onOpenFile: onOpenFile)
                }
                if extra > 0 {
                    Text("+\(extra) more").font(TokFont.text(TokFont.caption, .medium)).foregroundStyle(Tok.inkTertiary)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Tok.fillTertiary).clipShape(Capsule())
                }
            }
        }
    }
}

/// A minimal wrapping (flow) layout — chips reflow onto new lines like the desktop file bar.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, maxRowW: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > maxW, x > 0 { maxRowW = max(maxRowW, x - spacing); x = 0; y += rowH + lineSpacing; rowH = 0 }
            x += s.width + spacing; rowH = max(rowH, s.height)
        }
        maxRowW = max(maxRowW, x - spacing)
        return CGSize(width: maxW.isFinite ? maxW : maxRowW, height: y + rowH)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowH + lineSpacing; rowH = 0 }
            v.place(at: CGPoint(x: x, y: y), anchor: .topLeading, proposal: ProposedViewSize(s))
            x += s.width + spacing; rowH = max(rowH, s.height)
        }
    }
}
