import SwiftUI
import AppKit

/// Put a string on the pasteboard (chat copy).
@MainActor func copyToPasteboard(_ s: String) {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(s, forType: .string)
}

/// One turn: the user's message bubble, then the assistant's work.
struct TurnView: View {
    let job: Job
    var projectRoot: String? = nil
    var answerable = false
    var onAnswer: (String) -> Void = { _ in }
    var onOpenFile: (String) -> Void = { FilePreviewWindowController.shared.open(path: $0) }
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            UserBubble(job: job, onOpenFile: onOpenFile)
            AssistantTurn(job: job, projectRoot: projectRoot, answerable: answerable, onAnswer: onAnswer, onOpenFile: onOpenFile)
        }
    }
}

// MARK: - User bubble

struct UserBubble: View {
    let job: Job
    var onOpenFile: (String) -> Void = { FilePreviewWindowController.shared.open(path: $0) }

    /// Render `@/long/path/to/file.png` file mentions as compact `@file.png` chips (highlighted),
    /// instead of dumping the raw path — à la Conductor. Bold (`**…**`) is honored inline.
    static func mentionStyled(_ s: String) -> AttributedString {
        var out = AttributedString()
        let words = s.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
        for (i, w) in words.enumerated() {
            if i > 0 { out += AttributedString(" ") }
            if w.count > 1, w.hasPrefix("@") {
                let path = String(w.dropFirst())
                let name = path.contains("/") ? (path as NSString).lastPathComponent : path
                var chip = AttributedString("@" + name)
                chip.font = .system(size: 12.5, weight: .semibold)
                chip.foregroundColor = .white
                chip.backgroundColor = Color.white.opacity(0.22)
                out += chip
            } else {
                out += AttributedString(w)
            }
        }
        return out
    }

    var body: some View {
        HStack {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 6) {
                if let imgs = job.inputImages, !imgs.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(Array(imgs.enumerated()), id: \.offset) { _, ref in
                            UserAttachmentChip(ref: ref, onOpenFile: onOpenFile)
                        }
                    }
                }
                if let files = job.inputFiles, !files.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(Array(files.enumerated()), id: \.offset) { _, f in
                            UserFileChip(file: f, onOpenFile: onOpenFile)
                        }
                    }
                }
                Text(Self.mentionStyled(job.input))
                    .font(TokFont.text(14)).foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    // Vertical gradient: a touch-lightened blue at the top → full blue (matches the web).
                    .background(
                        LinearGradient(colors: [Color(nsColor: NSColor(hex: "#0F82FF")), Tok.blue],
                                       startPoint: .top, endPoint: .bottom)
                    )
                    .clipShape(.rect(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 5, topTrailingRadius: 18))
                    .shadow(color: Tok.blue.opacity(0.30), radius: 7, y: 4)
                    .frame(maxWidth: 640, alignment: .trailing)
                    .contextMenu { Button { copyToPasteboard(job.input) } label: { Label("Copy", systemImage: "doc.on.doc") } }
            }
        }
    }
}

struct UserAttachmentChip: View {
    let ref: ChatImageRef
    var onOpenFile: (String) -> Void = { FilePreviewWindowController.shared.open(path: $0) }
    @State private var hovering = false

    private var title: String {
        ref.name ?? ref.imagePath.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "image"
    }

    var body: some View {
        Button {
            if let p = ref.imagePath { onOpenFile(p) }
        } label: {
            HStack(spacing: 7) {
                if let p = ref.imagePath, let img = NSImage(contentsOfFile: p) {
                    Image(nsImage: img)
                        .resizable().scaledToFill().frame(width: 28, height: 28)
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                } else {
                    Image(systemName: "photo")
                        .font(.system(size: 13, weight: .semibold)).foregroundStyle(Tok.green)
                        .frame(width: 28, height: 28).background(Tok.green.opacity(0.18))
                        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                Text(title).font(TokFont.text(TokFont.footnote, .medium)).foregroundStyle(.white).lineLimit(1)
            }
            .padding(.leading, 4).padding(.trailing, 9).padding(.vertical, 4)
            .background(Color.white.opacity(hovering ? 0.28 : 0.20))
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.white.opacity(0.18), lineWidth: Tok.hairline))
        }
        .buttonStyle(.plain).disabled(ref.imagePath == nil).onHover { hovering = $0 }.help(ref.imagePath ?? title)
    }
}

/// A non-image attachment chip on the user bubble (text/file) — doc glyph + name, opens the saved file.
struct UserFileChip: View {
    let file: ChatFileRef
    var onOpenFile: (String) -> Void = { FilePreviewWindowController.shared.open(path: $0) }
    @State private var hovering = false

    var body: some View {
        Button { if let p = file.path { onOpenFile(p) } } label: {
            HStack(spacing: 7) {
                Image(systemName: file.kind == "text" ? "doc.text" : "doc")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 28, height: 28).background(Color.white.opacity(0.18))
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                Text(file.name).font(TokFont.text(TokFont.footnote, .medium)).foregroundStyle(.white).lineLimit(1)
            }
            .padding(.leading, 4).padding(.trailing, 9).padding(.vertical, 4)
            .background(Color.white.opacity(hovering ? 0.28 : 0.20))
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.white.opacity(0.18), lineWidth: Tok.hairline))
        }
        .buttonStyle(.plain).disabled(file.path == nil).onHover { hovering = $0 }.help(file.path ?? file.name)
    }
}

// MARK: - Assistant turn

/// Grouping so consecutive tool calls render as a tight list (Electron `ToolGroup` gap:1) while
/// other blocks keep the larger turn rhythm.
private enum RBlock: Identifiable {
    case tools([TranscriptItem])
    case single(TranscriptItem)
    var id: String {
        switch self {
        case .tools(let t): return "tools-\(t.first?.id ?? "")-\(t.count)"
        case .single(let s): return s.id
        }
    }
}
private func groupBlocks(_ items: [TranscriptItem]) -> [RBlock] {
    var out: [RBlock] = []; var run: [TranscriptItem] = []
    func flush() { if !run.isEmpty { out.append(.tools(run)); run = [] } }
    for it in items {
        if it.kind == "tool" { run.append(it) } else { flush(); out.append(.single(it)) }
    }
    flush(); return out
}

struct AssistantTurn: View {
    let job: Job
    var projectRoot: String? = nil
    var answerable = false
    var onAnswer: (String) -> Void = { _ in }
    var onOpenFile: (String) -> Void = { FilePreviewWindowController.shared.open(path: $0) }

    private var provider: String { job.engine == "codex" ? "openai" : "anthropic" }
    private var hasBody: Bool { (job.transcript ?? []).contains { ($0.kind == "text" || $0.kind == "result") && !$0.text.trimmed.isEmpty } }
    private var replyText: String? { (job.transcript ?? []).last { ($0.kind == "text" || $0.kind == "result") && !$0.text.trimmed.isEmpty }?.text }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            avatar
            VStack(alignment: .leading, spacing: 10) {
                header
                blocksView
                statusView
            }
            .contextMenu { if let r = replyText, !r.trimmed.isEmpty { Button { copyToPasteboard(r) } label: { Label("Copy response", systemImage: "doc.on.doc") } } }
            Spacer(minLength: 0)
        }
    }

    // 30×30 elevated rounded-square card with the provider brand glyph (spinner while live, no body yet).
    private var avatar: some View {
        ZStack {
            if job.isRunning && !hasBody {
                Spinner(size: 14).tint(Tok.purple)
            } else {
                ProviderGlyph(provider: provider, size: 16, color: Tok.ink)
            }
        }
        .frame(width: 30, height: 30)
        .background(Tok.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        .shadow(color: .dyn(.rgba(15, 20, 50, 0.06), .rgba(0, 0, 0, 0.4)), radius: 1.5, y: 1)
        .padding(.top, 1)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Text(engineLabel).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink)
            if let m = job.model, m != job.engine { Text(m).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary) }
            if job.goal == true { badge("GOAL", Tok.purple) }
            if job.isRunning {
                HStack(spacing: 5) {
                    Circle().fill(Tok.purple).frame(width: 6, height: 6)
                        .modifier(Breathe())
                    Text(hasBody ? "streaming" : "thinking").font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.purple)
                }
            }
            Spacer(minLength: 6)
            if let r = replyText, !r.trimmed.isEmpty {
                CopyChip(text: r)
            }
        }
    }

    @ViewBuilder private var blocksView: some View {
        let blocks = job.transcript ?? []
        if job.isRunning {
            renderGroups(groupBlocks(blocks), live: true)
        } else {
            let work = blocks.filter { $0.kind == "tool" || $0.kind == "thinking" }
            let content = blocks.filter { $0.kind != "tool" && $0.kind != "thinking" }
            if !work.isEmpty {
                WorkBar(work: work, elapsedMs: max(0, (job.updatedAt ?? job.createdAt) - job.createdAt),
                        projectRoot: projectRoot, onOpenFile: onOpenFile)
            }
            renderGroups(groupBlocks(content), live: false)
        }
    }

    @ViewBuilder private func renderGroups(_ groups: [RBlock], live: Bool) -> some View {
        ForEach(groups) { g in
            switch g {
            case .tools(let ts):
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(ts) { ToolCallRow(item: $0, root: projectRoot, onOpenFile: onOpenFile) }
                }
            case .single(let it):
                TranscriptBlock(item: it, projectRoot: projectRoot, live: live,
                                answerable: answerable && it.kind == "ask", onAnswer: onAnswer, onOpenFile: onOpenFile)
            }
        }
    }

    @ViewBuilder private var statusView: some View {
        if job.isRunning {
            if job.isPaused {
                HStack(spacing: 7) {
                    Icon(name: "pause", size: 12).foregroundStyle(Tok.orange)
                    Text("Paused — will resume").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.orange)
                }
            } else {
                // Fixed-height row: streaming swaps `liveActivity` constantly; a constant row
                // height keeps the bottom-most element stable so the bottom-anchored scroll
                // doesn't oscillate (the "shaking at the bottom" bug).
                HStack(spacing: 8) {
                    Spinner(size: 12).tint(Tok.purple)
                    ShimmerText(text: LiveActivity.label(for: job))
                    StreamCaret(height: 15)
                }
                .frame(height: 18, alignment: .leading)
            }
        } else if job.status == "failed" {
            failureCard
        } else if job.status == "cancelled" {
            Text("Stopped").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
        } else {
            metaLine
        }
    }

    private var engineLabel: String {
        switch job.engine { case "codex": return "Codex"; case "claude-code", "claude": return "Claude Code"; default: return job.engine?.capitalized ?? "Agent" }
    }

    private var metaLine: some View {
        HStack(spacing: 10) {
            if let t = job.tokens, t > 0 { Text("\(Int(t)) tok").font(TokFont.mono(TokFont.caption)) }
            if let c = job.cost, c > 0 { Text(String(format: "$%.3f", c)).font(TokFont.mono(TokFont.caption)) }
            if let n = job.transcript?.filter({ $0.kind == "tool" }).count, n > 0 { Text("\(n) tool\(n == 1 ? "" : "s")").font(TokFont.text(TokFont.caption)) }
        }
        .foregroundStyle(Tok.inkTertiary)
    }

    private var failureCard: some View {
        Text(job.error ?? "The turn failed.")
            .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.red)
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(Tok.red.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func badge(_ t: String, _ c: Color) -> some View {
        Text(t).font(TokFont.text(9, .bold)).tracking(0.4).foregroundStyle(c)
            .padding(.horizontal, 6).padding(.vertical, 2).background(c.opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}

/// Breathing opacity (1 → .45 → 1) for the live status dot — mirrors `.breathe`.
private struct Breathe: ViewModifier {
    @State private var dim = false
    func body(content: Content) -> some View {
        content.opacity(dim ? 0.45 : 1)
            .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true } }
    }
}

// MARK: - Work bar (collapsed settled work)

/// Collapsed "Worked Ns · thought · N tools" summary for a settled turn — expands to reveal the
/// tool/thinking work behind an indent rail. `elapsedMs` is the turn wall-clock.
struct WorkBar: View {
    let work: [TranscriptItem]
    var elapsedMs: Double
    var projectRoot: String? = nil
    var onOpenFile: (String) -> Void = { FilePreviewWindowController.shared.open(path: $0) }
    @State private var expanded = false

    var body: some View {
        let tools = work.filter { $0.kind == "tool" }.count
        let thought = work.contains { $0.kind == "thinking" }
        VStack(alignment: .leading, spacing: 8) {
            Button { withAnimation(.smooth(duration: 0.2)) { expanded.toggle() } } label: {
                HStack(spacing: 6) {
                    Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Tok.green)
                    Text(summary(tools: tools, thought: thought)).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.inkSecondary)
                    Icon(name: expanded ? "chevronDown" : "chevronRight", size: 10).foregroundStyle(Tok.inkTertiary)
                }
                .padding(.horizontal, 9).padding(.vertical, 5)
                .background(Tok.fillTertiary).clipShape(Capsule())
                .overlay(Capsule().strokeBorder(Tok.separator, lineWidth: Tok.hairline))
            }.pressable()
            if expanded {
                HStack(alignment: .top, spacing: 11) {
                    Tok.separator.frame(width: 1.5)
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(groupedTight) { g in
                            switch g {
                            case .tools(let ts): VStack(alignment: .leading, spacing: 1) { ForEach(ts) { ToolCallRow(item: $0, root: projectRoot, onOpenFile: onOpenFile) } }
                            case .single(let it): TranscriptBlock(item: it, projectRoot: projectRoot, onOpenFile: onOpenFile)
                            }
                        }
                    }.opacity(0.85)
                }
                .padding(.leading, 2)
                .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
    }

    private var groupedTight: [RBlock] { groupBlocks(work) }

    private func summary(tools: Int, thought: Bool) -> String {
        var parts: [String] = ["Worked \(fmtDuration(elapsedMs))"]
        if thought { parts.append("thought") }
        if tools > 0 { parts.append("\(tools) tool\(tools == 1 ? "" : "s")") }
        return parts.joined(separator: " · ")
    }
    private func fmtDuration(_ ms: Double) -> String {
        let s = Int((ms / 1000).rounded())
        if s < 60 { return "\(s)s" }
        return "\(s / 60)m \(s % 60)s"
    }
}

// MARK: - Thinking block

/// The agent's extended thinking: a purple-tile spark glyph + uppercase tracked label, a collapsed
/// one-line preview, and a markdown body behind a purple-tinted rail. Auto-opens while the turn is live.
struct ThinkingBlock: View {
    let item: TranscriptItem
    var projectRoot: String? = nil
    var live: Bool = false
    @State private var expanded = false
    private var isOpen: Bool { expanded || live }

    var body: some View {
        let text = item.text.trimmed
        if !text.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 7) {
                        Image(systemName: "sparkles").font(.system(size: 11, weight: .medium)).foregroundStyle(Tok.purple)
                            .frame(width: 18, height: 18).background(Tok.purple.opacity(0.14))
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        Text(live ? "THINKING…" : "THINKING")
                            .font(TokFont.text(TokFont.caption, .semibold)).tracking(0.7).foregroundStyle(Tok.purple)
                            .modifier(ConditionalBreathe(on: live))
                        if !isOpen {
                            Text(preview(text)).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1)
                        }
                        Spacer(minLength: 4)
                        Icon(name: isOpen ? "chevronDown" : "chevronRight", size: 11).foregroundStyle(Tok.inkTertiary)
                    }
                    .contentShape(Rectangle())
                }.buttonStyle(.plain)
                if isOpen {
                    HStack(alignment: .top, spacing: 13) {
                        Tok.purple.opacity(0.42).frame(width: 1.5)
                        VStack(alignment: .leading, spacing: 6) {
                            MarkdownText(text: text, projectRoot: projectRoot, baseSize: 13, bodyColor: Tok.inkSecondary, nsBodyColor: TokNS.inkSecondary)
                            if live { StreamCaret(height: 14) }
                        }
                    }
                    .padding(.leading, 8)
                    .transition(.opacity)
                }
            }
        }
    }

    private func preview(_ s: String) -> String {
        let collapsed = s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmed
        return collapsed.count > 96 ? String(collapsed.prefix(96)) + "…" : collapsed
    }
}

private struct ConditionalBreathe: ViewModifier {
    let on: Bool
    @State private var dim = false
    func body(content: Content) -> some View {
        content.opacity(on && dim ? 0.5 : 1)
            .onAppear { if on { withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true } } }
    }
}

// MARK: - Transcript block dispatch

/// Renders a single transcript item by kind.
struct TranscriptBlock: View {
    let item: TranscriptItem
    var projectRoot: String? = nil
    var live: Bool = false
    var answerable = false
    var onAnswer: (String) -> Void = { _ in }
    var onOpenFile: (String) -> Void = { FilePreviewWindowController.shared.open(path: $0) }
    @State private var answered: String?
    @State private var custom = ""

    var body: some View {
        switch item.kind {
        case "text", "result": MarkdownText(text: item.text, projectRoot: projectRoot, onOpenFile: onOpenFile)
        case "thinking": ThinkingBlock(item: item, projectRoot: projectRoot, live: live)
        case "tool": ToolCallRow(item: item, root: projectRoot, onOpenFile: onOpenFile)
        case "image": imageChip
        case "ask": answerable ? AnyView(questionCard) : AnyView(askCard)
        case "review": reviewCard
        case "steer": steerRow
        default: MarkdownText(text: item.text, projectRoot: projectRoot, onOpenFile: onOpenFile)
        }
    }

    /// A user message injected mid-turn via ⌘↩ (steer): the agent picks it up at the
    /// next boundary without the turn being killed + reseeded. Rendered as a tinted
    /// interjection so it's clearly distinct from the agent's own prose.
    private var steerRow: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "arrowshape.turn.up.right.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Tok.blue)
                .padding(.top, 2)
            Text(item.text)
                .font(TokFont.text(TokFont.subhead))
                .foregroundStyle(Tok.ink)
                .textSelection(.enabled)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(Tok.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tok.blue.opacity(0.25), lineWidth: 1))
    }

    /// Interactive AskUserQuestion card: option chips + a type-your-own field → answerQuestion.
    private var questionCard: some View {
        let payload = (try? JSONDecoder().decode(AskPayload.self, from: Data((item.ask ?? "{}").utf8)))
        let q = payload?.questions?.first
        return VStack(alignment: .leading, spacing: 10) {
            if let header = q?.header ?? q?.question, !header.isEmpty {
                Text(header).font(TokFont.text(TokFont.subhead, .semibold)).foregroundStyle(Tok.ink)
            } else {
                Text(item.text).font(TokFont.text(TokFont.subhead, .semibold)).foregroundStyle(Tok.ink)
            }
            if let answered {
                Text("Answered: \(answered)").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.green)
            } else {
                ForEach(Array((q?.options ?? []).enumerated()), id: \.offset) { _, opt in
                    if let label = opt.label {
                        Button { answered = label; onAnswer(label) } label: {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(label).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink)
                                if let d = opt.description, !d.isEmpty { Text(d).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary) }
                            }
                            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 11).padding(.vertical, 8)
                            .background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
                        }.buttonStyle(.plain)
                    }
                }
                HStack(spacing: 6) {
                    TextField("Type your own answer…", text: $custom).textFieldStyle(.plain).font(TokFont.text(TokFont.footnote))
                        .padding(.horizontal, 10).frame(height: 32).background(Tok.bgElevated)
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
                        .onSubmit { submitCustom() }
                    PillButton(title: "Send", kind: .plain, disabled: custom.trimmed.isEmpty) { submitCustom() }
                }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(Tok.blue.opacity(0.08))
        .overlay(alignment: .leading) { Tok.blue.frame(width: 2.5).clipShape(Capsule()) }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func submitCustom() {
        let t = custom.trimmed; guard !t.isEmpty else { return }
        answered = t; onAnswer(t)
    }

    private var imageChip: some View {
        Group {
            if let path = item.imagePath, let img = NSImage(contentsOfFile: path) {
                VStack(alignment: .leading, spacing: 7) {
                    Button { onOpenFile(path) } label: {
                        ZStack(alignment: .bottomLeading) {
                            Image(nsImage: img).resizable().scaledToFit()
                                .frame(maxWidth: 420, maxHeight: 420)
                                .background(Tok.fillTertiary)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
                            HStack(spacing: 6) {
                                Image(systemName: "photo").font(.system(size: 11.5, weight: .semibold))
                                Text(URL(fileURLWithPath: path).lastPathComponent).font(TokFont.text(TokFont.caption, .semibold)).lineLimit(1)
                            }
                            .foregroundStyle(.white).padding(.horizontal, 8).padding(.vertical, 5)
                            .background(.black.opacity(0.46)).clipShape(Capsule()).padding(8)
                        }
                    }.buttonStyle(.plain)
                    if let alt = item.alt, !alt.isEmpty {
                        Text(alt).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(2)
                    }
                }
            } else {
                HStack(spacing: 8) {
                    Icon(name: "image", size: 14).foregroundStyle(Tok.purple)
                    Text(item.alt ?? "Generated image").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).lineLimit(1)
                }
                .padding(8).background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
    }

    private var askCard: some View {
        Text(item.text).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.ink)
            .padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(Tok.blue.opacity(0.10))
            .overlay(alignment: .leading) { Tok.blue.frame(width: 2.5).clipShape(Capsule()) }
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var reviewCard: some View {
        HStack(spacing: 8) {
            Icon(name: item.verdict == "approved" ? "check" : "alert", size: 13)
                .foregroundStyle(item.verdict == "approved" ? Tok.green : Tok.orange)
            Text(item.text).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
        }
        .padding(10).background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}
