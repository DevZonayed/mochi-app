import SwiftUI
import AppKit

/// One turn: the user's message bubble, then the assistant's work.
struct TurnView: View {
    let job: Job
    var answerable = false
    var onAnswer: (String) -> Void = { _ in }
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            UserBubble(job: job)
            AssistantTurn(job: job, answerable: answerable, onAnswer: onAnswer)
        }
    }
}

struct UserBubble: View {
    let job: Job

    /// Render `@/long/path/to/file.png` file mentions as compact `@file.png` chips (highlighted),
    /// instead of dumping the raw path — à la Conductor.
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
                            if let p = ref.imagePath, let img = NSImage(contentsOfFile: p) {
                                Image(nsImage: img).resizable().scaledToFill().frame(width: 96, height: 96)
                                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                            }
                        }
                    }
                }
                Text(Self.mentionStyled(job.input))
                    .font(TokFont.text(14)).foregroundStyle(.white)
                    .textSelection(.enabled)
                    .padding(.horizontal, 13).padding(.vertical, 9)
                    .background(
                        LinearGradient(colors: [Tok.blue, Tok.bluePress], startPoint: .topLeading, endPoint: .bottomTrailing)
                    )
                    .clipShape(.rect(topLeadingRadius: 18, bottomLeadingRadius: 18, bottomTrailingRadius: 5, topTrailingRadius: 18))
                    .frame(maxWidth: 640, alignment: .trailing)
            }
        }
    }
}

struct AssistantTurn: View {
    let job: Job
    var answerable = false
    var onAnswer: (String) -> Void = { _ in }
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Circle().fill(Tok.purple.opacity(0.16)).frame(width: 30, height: 30)
                .overlay(Icon(name: "spark", size: 15).foregroundStyle(Tok.purple))
            VStack(alignment: .leading, spacing: 10) {
                // header
                HStack(spacing: 8) {
                    Text(engineLabel).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.inkSecondary)
                    if let m = job.model { Text(m).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary) }
                    if job.goal == true { badge("GOAL", Tok.purple) }
                }
                // blocks — while running, show everything live; once settled, collapse the
                // tool/thinking "work" into a WorkBar and keep the prose/result.
                let blocks = job.transcript ?? []
                if job.isRunning {
                    ForEach(blocks) { item in
                        TranscriptBlock(item: item, answerable: answerable && item.kind == "ask", onAnswer: onAnswer)
                    }
                } else {
                    let work = blocks.filter { $0.kind == "tool" || $0.kind == "thinking" }
                    let content = blocks.filter { $0.kind != "tool" && $0.kind != "thinking" }
                    if !work.isEmpty { WorkBar(work: work, durMs: job.transcript?.compactMap(\.durMs).reduce(0, +)) }
                    ForEach(content) { item in
                        TranscriptBlock(item: item, answerable: answerable && item.kind == "ask", onAnswer: onAnswer)
                    }
                }

                // status / meta
                if job.status == "running" || job.status == "pending" {
                    HStack(spacing: 7) {
                        Spinner(size: 12).tint(Tok.purple)
                        Text(job.isPaused ? "Paused — will resume" : "Responding…")
                            .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.purple)
                    }
                } else if job.status == "failed" {
                    failureCard
                } else if job.status == "cancelled" {
                    Text("Stopped").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                } else {
                    metaLine
                }
            }
            Spacer(minLength: 0)
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
        Text(t).font(TokFont.text(TokFont.caption, .bold)).foregroundStyle(c)
            .padding(.horizontal, 6).padding(.vertical, 2).background(c.opacity(0.14)).clipShape(Capsule())
    }
}

/// Collapsed "Worked Ns · thought · N tools" summary for a settled turn — expands to reveal the
/// tool/thinking work. Mirrors Conductor: the run log folds away once the response is done.
struct WorkBar: View {
    let work: [TranscriptItem]
    var durMs: Double?
    @State private var expanded = false

    var body: some View {
        let tools = work.filter { $0.kind == "tool" }.count
        let thought = work.contains { $0.kind == "thinking" }
        VStack(alignment: .leading, spacing: 6) {
            Button { withAnimation(.smooth(duration: 0.2)) { expanded.toggle() } } label: {
                HStack(spacing: 6) {
                    Icon(name: "check", size: 11).foregroundStyle(Tok.green)
                    Text(summary(tools: tools, thought: thought)).font(TokFont.text(TokFont.caption, .medium)).foregroundStyle(Tok.inkSecondary)
                    Icon(name: expanded ? "chevronDown" : "chevronRight", size: 10).foregroundStyle(Tok.inkTertiary)
                }
                .padding(.horizontal, 9).padding(.vertical, 5)
                .background(Tok.fillTertiary).clipShape(Capsule())
            }.pressable()
            if expanded {
                VStack(alignment: .leading, spacing: 6) { ForEach(work) { TranscriptBlock(item: $0) } }
                    .padding(.leading, 8).padding(.vertical, 2)
                    .overlay(alignment: .leading) { Tok.separator.frame(width: Tok.hairline) }
                    .transition(.opacity.combined(with: .offset(y: -4)))
            }
        }
    }

    private func summary(tools: Int, thought: Bool) -> String {
        var parts: [String] = []
        if let d = durMs, d > 0 { parts.append("Worked \(d < 1000 ? "\(Int(d))ms" : String(format: "%.0fs", d / 1000))") } else { parts.append("Worked") }
        if thought { parts.append("thought") }
        if tools > 0 { parts.append("\(tools) tool\(tools == 1 ? "" : "s")") }
        return parts.joined(separator: " · ")
    }
}

/// Renders a single transcript item by kind.
struct TranscriptBlock: View {
    let item: TranscriptItem
    var answerable = false
    var onAnswer: (String) -> Void = { _ in }
    @State private var expanded = false
    @State private var answered: String?
    @State private var custom = ""

    var body: some View {
        switch item.kind {
        case "text", "result": MarkdownText(text: item.text)
        case "thinking": thinking
        case "tool": toolRow
        case "image": imageChip
        case "ask": answerable ? AnyView(questionCard) : AnyView(askCard)
        case "review": reviewCard
        default: MarkdownText(text: item.text)
        }
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

    private var thinking: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { expanded.toggle() } label: {
                HStack(spacing: 6) {
                    Icon(name: "spark", size: 12).foregroundStyle(Tok.purple)
                    Text("Thinking").font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.purple)
                    Icon(name: expanded ? "chevronDown" : "chevronRight", size: 11).foregroundStyle(Tok.inkTertiary)
                }
            }.buttonStyle(.plain)
            if expanded {
                Text(item.text).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
                    .lineSpacing(2).fixedSize(horizontal: false, vertical: true)
            } else {
                Text(String(item.text.prefix(96))).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary).lineLimit(1)
            }
        }
    }

    private var hasChildren: Bool { !(item.children ?? []).isEmpty }

    private var toolRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button { if hasChildren { expanded.toggle() } } label: {
                HStack(spacing: 8) {
                    statusGlyph
                    VStack(alignment: .leading, spacing: 1) {
                        Text(item.text).font(TokFont.text(TokFont.footnote, .medium)).foregroundStyle(Tok.ink).lineLimit(1)
                        if let cmd = item.cmd, !cmd.isEmpty {
                            Text(cmd).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1)
                        } else if hasChildren, let r = item.result, !r.isEmpty, !expanded {
                            Text("→ \(r.prefix(120))").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                    if hasChildren {
                        Text("\(item.children?.count ?? 0)").font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                        Icon(name: expanded ? "chevronDown" : "chevronRight", size: 11).foregroundStyle(Tok.inkTertiary)
                    } else if let d = item.durMs, d > 0 {
                        Text(durLabel(d)).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                    }
                }
            }
            .buttonStyle(.plain).disabled(!hasChildren)

            // Sub-agent (Task/Agent) transcript, nested.
            if expanded, let kids = item.children, !kids.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(kids) { child in TranscriptBlock(item: child) }
                    if let r = item.result, !r.isEmpty {
                        Text(r).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary)
                    }
                }
                .padding(.leading, 18).padding(.vertical, 4)
                .overlay(alignment: .leading) { Tok.separator.frame(width: Tok.hairline) }
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder private var statusGlyph: some View {
        switch item.toolStatus {
        case "running": Spinner(size: 12).tint(Tok.inkTertiary)
        case "error": Icon(name: "x", size: 12).foregroundStyle(Tok.red)
        default: Icon(name: "check", size: 12).foregroundStyle(Tok.green)
        }
    }

    private var imageChip: some View {
        // The app runs on the Mac, so a generated image's absolute imagePath is readable directly
        // (no relay/assetImage round-trip needed).
        Group {
            if let path = item.imagePath, let img = NSImage(contentsOfFile: path) {
                VStack(alignment: .leading, spacing: 4) {
                    Image(nsImage: img).resizable().scaledToFit()
                        .frame(maxWidth: 360, maxHeight: 360)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
                    if let alt = item.alt, !alt.isEmpty {
                        Text(alt).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(2)
                    }
                }
            } else {
                HStack(spacing: 8) {
                    Icon(name: "spark", size: 14).foregroundStyle(Tok.teal)
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

    private func durLabel(_ ms: Double) -> String { ms < 1000 ? "\(Int(ms))ms" : String(format: "%.1fs", ms / 1000) }
}
