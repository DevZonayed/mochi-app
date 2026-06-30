import SwiftUI

// MARK: - Live activity (single source of truth)

/// The agent's *current* activity, derived from the running turn's latest transcript item.
/// One source of truth for both the in-transcript heartbeat (`AssistantTurn.statusView`) and the
/// pinned `LiveStatusBar` above the composer, so the two never drift apart.
///
/// `label` is the human heartbeat string ("Running npm test…", "Thinking…", "Responding…");
/// `symbol`/`tint` give the bar a per-activity glyph + accent so it recolours by what's happening
/// (blue while running a command, teal while editing, purple while thinking…).
struct LiveActivity {
    let label: String
    let symbol: String
    let tint: Color

    /// The heartbeat string. Kept byte-for-byte identical to the original in-transcript logic so the
    /// transcript's status row and the pinned bar always read the same.
    static func label(for job: Job) -> String {
        let items = job.transcript ?? []
        guard let last = items.last else { return "Thinking…" }
        switch last.kind {
        case "tool":
            if last.toolStatus == "running" {
                let verb = toolVerb(ToolViz.display(last.name).short)
                let detail = String(ToolViz.detail(last).trimmed.prefix(54))
                return detail.isEmpty ? "\(verb)…" : "\(verb) \(detail)…"
            }
            return "Thinking…"
        case "thinking": return "Thinking…"
        case "image": return "Saving image…"
        case "ask": return "Waiting for your answer…"
        case "text", "result": return "Responding…"
        default: return "Thinking…"
        }
    }

    static func from(_ job: Job) -> LiveActivity {
        let last = (job.transcript ?? []).last
        let text = label(for: job)
        // A live tool call borrows that tool's own glyph + tint (Run=blue, Edit=teal, Browse=indigo…).
        if let last, last.kind == "tool", last.toolStatus == "running" {
            let skill = ToolViz.isSkill(last.name)
            let d = ToolViz.display(last.name)
            return LiveActivity(label: text, symbol: skill ? "sparkles" : d.symbol, tint: skill ? Tok.purple : d.tint)
        }
        switch last?.kind {
        case "image":          return LiveActivity(label: text, symbol: "photo",               tint: Tok.purple)
        case "ask":            return LiveActivity(label: text, symbol: "questionmark.bubble",  tint: Tok.blue)
        case "text", "result": return LiveActivity(label: text, symbol: "text.alignleft",       tint: Tok.purple)
        default:               return LiveActivity(label: text, symbol: "sparkles",             tint: Tok.purple)
        }
    }

    private static func toolVerb(_ short: String) -> String {
        switch short {
        case "Image": return "Generating image"
        case "Run": return "Running"
        case "Edit": return "Editing"
        case "Write": return "Writing"
        case "Read": return "Reading"
        case "Search", "Find": return "Searching"
        case "Browser", "Fetch", "Web search": return "Browsing"
        default: return "Working"
        }
    }
}

// MARK: - Live status bar

/// A slim status strip pinned just above the composer that previews what the agent is doing **right
/// now** — current tool / thinking / responding, a live-ticking elapsed clock, the running token
/// count, and (when a `ScheduleWakeup` parks the turn) a pause countdown. It stays visible even when
/// the transcript is scrolled away from the live turn; tapping it scrolls back down to that turn.
///
/// The whole bar recolours to the activity's accent, so a glance tells you the *kind* of work in
/// flight before you even read the label.
struct LiveStatusBar: View {
    let job: Job
    /// Scroll the transcript back to the running turn.
    var onJump: () -> Void = {}

    @State private var hovering = false

    private var act: LiveActivity { LiveActivity.from(job) }
    private var paused: Bool { job.isPaused }
    private var accent: Color { paused ? Tok.orange : act.tint }
    /// Anchor the per-second tick to the turn's own start (epoch ms) rather than `.now`, so the clock
    /// keeps a steady 1s cadence even as the bar re-renders on every stream delta.
    private var turnStart: Date { Date(timeIntervalSince1970: job.createdAt / 1000) }

    var body: some View {
        Button(action: onJump) {
            HStack(spacing: 11) {
                indicator
                activity
                Spacer(minLength: 8)
                meta
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Tok.inkTertiary)
                    .opacity(hovering ? 0.95 : 0.4)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .frame(minHeight: 38)
            .background(ZStack { Tok.bgElevated; accent.opacity(0.055) })
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            .overlay(alignment: .leading) {
                Capsule().fill(accent).frame(width: 3).padding(.vertical, 8)
            }
            .overlay(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .strokeBorder(accent.opacity(0.30), lineWidth: Tok.hairline)
            )
            .shadow(color: accent.opacity(0.16), radius: 7, y: 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pressable(scale: 0.992)
        .onHover { hovering = $0 }
        .help("Jump to the running turn")
        .animation(.easeOut(duration: 0.3), value: accent)
    }

    /// Leading badge: a spinning ring with the activity glyph at its centre (a pause tile when parked).
    @ViewBuilder private var indicator: some View {
        if paused {
            Image(systemName: "pause.fill")
                .font(.system(size: 10, weight: .bold)).foregroundStyle(Tok.orange)
                .frame(width: 22, height: 22)
                .background(Tok.orange.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        } else {
            ZStack {
                Spinner(size: 19).tint(accent)
                Image(systemName: act.symbol)
                    .font(.system(size: 8.5, weight: .bold))
                    .foregroundStyle(accent)
            }
            .frame(width: 22, height: 22)
        }
    }

    /// The heartbeat line: shimmering activity text, or a live pause countdown.
    @ViewBuilder private var activity: some View {
        if paused {
            TimelineView(.periodic(from: turnStart, by: 1)) { ctx in
                Text(pauseLine(now: ctx.date))
                    .font(TokFont.text(TokFont.footnote, .semibold))
                    .foregroundStyle(Tok.orange)
                    .lineLimit(1).truncationMode(.tail)
            }
        } else {
            ShimmerText(text: act.label, size: 13)
        }
    }

    /// Trailing chips: a live-ticking elapsed clock + the running token count.
    private var meta: some View {
        HStack(spacing: 9) {
            TimelineView(.periodic(from: turnStart, by: 1)) { ctx in
                Label {
                    Text(elapsed(now: ctx.date)).monospacedDigit()
                } icon: {
                    Image(systemName: "clock").font(.system(size: 9.5, weight: .medium))
                }
                .font(TokFont.mono(TokFont.caption))
                .foregroundStyle(Tok.inkTertiary)
                .labelStyle(.titleAndIcon)
            }
            if let t = job.tokens, t > 0 {
                Text("\(tokenLabel(t)) tok")
                    .font(TokFont.mono(TokFont.caption))
                    .foregroundStyle(Tok.inkTertiary)
            }
        }
        .fixedSize()
    }

    // MARK: format

    /// Wall-clock since the turn started (`createdAt` is epoch ms), as `m:ss` (or `h:mm:ss`).
    private func elapsed(now: Date) -> String {
        let total = max(0, Int(now.timeIntervalSince1970 - job.createdAt / 1000))
        let h = total / 3600, m = (total % 3600) / 60, s = total % 60
        if h > 0 { return String(format: "%d:%02d:%02d", h, m, s) }
        return String(format: "%d:%02d", m, s)
    }

    /// Compact token count: 1.2k past a thousand, raw below.
    private func tokenLabel(_ t: Double) -> String {
        let n = Int(t)
        return n >= 1000 ? String(format: "%.1fk", t / 1000) : "\(n)"
    }

    /// "Paused · <reason> — resuming in 1m 20s" using `pausedUntil`/`pausedReason`.
    private func pauseLine(now: Date) -> String {
        let reason = job.pausedReason?.trimmed
        let remainMs = (job.pausedUntil ?? 0) - now.timeIntervalSince1970 * 1000
        let tail: String
        if remainMs > 0 {
            let s = Int((remainMs / 1000).rounded())
            tail = "resuming in \(s >= 60 ? "\(s / 60)m \(s % 60)s" : "\(s)s")"
        } else {
            tail = "resuming…"
        }
        if let reason, !reason.isEmpty { return "Paused · \(reason) — \(tail)" }
        return "Paused — \(tail)"
    }
}
