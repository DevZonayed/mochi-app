import SwiftUI

/// Today/this-month spend from the brain's `costs()` RPC (USD).
struct CostsData: Decodable {
    var today: Double?
    var thisMonth: Double?
}

/// One Claude subscription limit bucket — `percent` is USED (0–100), `remaining = 100 - percent`.
struct ClaudeLimit: Decodable, Equatable {
    var percent: Double?
    var resetsAt: String?
}

/// Live Claude subscription utilization — the SAME data Claude Code's `/status` shows, fetched by
/// the brain from `GET /api/oauth/usage`. `error` set ⇒ signed out / unavailable (hide sub rows).
struct ClaudeUsage: Decodable, Equatable {
    var session: ClaudeLimit?        // 5-hour rolling session
    var weekly: ClaudeLimit?         // 7-day, all models
    var weeklyOpus: ClaudeLimit?
    var weeklySonnet: ClaudeLimit?
    var error: String?
}

/// Everything the composer's usage gauge renders. The headline is your real Claude **subscription
/// limit** (session / weekly), with context-window fill + today's spend as secondary detail.
struct UsageInfo: Equatable {
    /// Real subscription limits (nil/`.error` until loaded or when on API-key/Codex).
    var claude: ClaudeUsage?
    /// Latest turn's context fill = input + cache-read + cache-creation tokens.
    var contextTokens: Double?
    /// Model id of that turn — picks the window size.
    var model: String?
    /// USD spent today (from `costs()`), nil until loaded.
    var todaySpend: Double?
    /// Epoch ms when a hit Claude usage-limit lifts (from a capped turn).
    var limitResetsAt: Double?

    // ── subscription ──
    var hasSubscription: Bool { (claude?.error == nil) && (claude?.session != nil || claude?.weekly != nil) }
    /// The binding (highest-utilization) limit's USED %, for the pill headline.
    var primaryUsed: Double? {
        [claude?.session?.percent, claude?.weekly?.percent, claude?.weeklySonnet?.percent, claude?.weeklyOpus?.percent]
            .compactMap { $0 }.max()
    }

    // ── context window ──
    var contextWindow: Double {
        let m = (model ?? "").lowercased()
        let base: Double = (m.contains("[1m]") || m.contains("-1m") || m.contains(" 1m")) ? 1_000_000 : 200_000
        if let c = contextTokens, c > base { return 1_000_000 }
        return base
    }
    var contextFraction: Double {
        guard let c = contextTokens, contextWindow > 0 else { return 0 }
        return min(1, max(0, c / contextWindow))
    }
    var limited: Bool {
        guard let r = limitResetsAt else { return false }
        return r > Date().timeIntervalSince1970 * 1000
    }
    var visible: Bool { hasSubscription || (contextTokens ?? 0) > 0 || limited }
}

/// Compact usage gauge for the composer controls row: a tiny fill bar + the most-constrained
/// Claude limit's used %, tapping opens a popover with the full breakdown (session + weekly limits
/// with reset countdowns, context-window fill, today's spend). Shows in Codespace and Design.
struct UsageGauge: View {
    let info: UsageInfo
    @State private var open = false

    /// Headline fraction (0–1): the binding subscription limit if known, else context fill.
    private var headFraction: Double {
        if info.hasSubscription, let u = info.primaryUsed { return min(1, max(0, u / 100)) }
        return info.contextFraction
    }
    private var headLabel: String {
        if info.limited { return "limit" }
        return "\(Int((headFraction * 100).rounded()))%"
    }
    private func tint(_ f: Double) -> Color { f < 0.6 ? Tok.green : (f < 0.85 ? Tok.orange : Tok.red) }
    private var pillTint: Color { info.limited ? Tok.orange : tint(headFraction) }

    var body: some View {
        Button { open.toggle() } label: { pill }
            .buttonStyle(.plain).pressable(scale: 0.96)
            .help(info.hasSubscription ? "Claude usage limits" : "Context window usage")
            .popover(isPresented: $open, arrowEdge: .top) { detail }
    }

    private var pill: some View {
        HStack(spacing: 6) {
            ZStack(alignment: .leading) {
                Capsule().fill(Tok.fillTertiary).frame(width: 38, height: 5)
                Capsule().fill(pillTint).frame(width: max(2, 38 * headFraction), height: 5)
            }
            Text(headLabel)
                .font(TokFont.mono(TokFont.caption)).foregroundStyle(info.limited ? Tok.orange : Tok.inkSecondary)
                .monospacedDigit()
        }
        .padding(.horizontal, 8).frame(height: 26)
        .background(Tok.fillSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous)
            .strokeBorder(info.limited ? Tok.orange.opacity(0.45) : .clear, lineWidth: Tok.hairline))
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 13) {
            if info.hasSubscription {
                section("CLAUDE SUBSCRIPTION")
                if let s = info.claude?.session { limitRow("Session (5h)", s) }
                if let w = info.claude?.weekly { limitRow("Weekly (all models)", w) }
                if let so = info.claude?.weeklySonnet, (so.percent ?? 0) > 0 { limitRow("Weekly (Sonnet)", so) }
                if let op = info.claude?.weeklyOpus, (op.percent ?? 0) > 0 { limitRow("Weekly (Opus)", op) }
            } else if info.claude?.error != nil {
                Text("Sign in with your Claude subscription to see limit usage.")
                    .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).fixedSize(horizontal: false, vertical: true)
            }

            if (info.contextTokens ?? 0) > 0 {
                if info.hasSubscription { rule }
                section("CONTEXT WINDOW")
                bar(info.contextFraction, tint(info.contextFraction))
                HStack {
                    Text("\(tok(info.contextTokens ?? 0)) used").foregroundStyle(Tok.ink)
                    Spacer()
                    Text("\(Int((info.contextFraction * 100).rounded()))% of \(tok(info.contextWindow))").foregroundStyle(Tok.inkSecondary)
                }.font(TokFont.mono(TokFont.caption)).monospacedDigit()
            }

            if let spend = info.todaySpend {
                rule
                HStack { Text("Spent today").foregroundStyle(Tok.inkSecondary); Spacer(); Text(String(format: "$%.2f", spend)).foregroundStyle(Tok.ink) }
                    .font(TokFont.text(TokFont.caption))
            }
        }
        .padding(14)
        .frame(width: 270)
    }

    // MARK: rows

    private func section(_ t: String) -> some View {
        Text(t).font(TokFont.text(TokFont.caption, .semibold)).tracking(0.6).foregroundStyle(Tok.inkTertiary)
    }

    /// A subscription-limit row: name, used→remaining bar, and "81% left · resets in 14h".
    private func limitRow(_ name: String, _ lim: ClaudeLimit) -> some View {
        let used = min(100, max(0, lim.percent ?? 0))
        let frac = used / 100
        return VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(name).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink)
                Spacer()
                Text("\(Int((100 - used).rounded()))% left").font(TokFont.mono(TokFont.caption, .semibold))
                    .foregroundStyle(tint(frac)).monospacedDigit()
            }
            bar(frac, tint(frac))
            HStack {
                Text("\(Int(used.rounded()))% used").foregroundStyle(Tok.inkTertiary)
                Spacer()
                if let r = resetLabel(lim.resetsAt) { Text("resets \(r)").foregroundStyle(Tok.inkTertiary) }
            }.font(TokFont.text(TokFont.caption))
        }
    }

    private func bar(_ frac: Double, _ color: Color) -> some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Tok.fillTertiary)
                Capsule().fill(color).frame(width: max(3, geo.size.width * frac))
            }
        }
        .frame(height: 7)
    }

    private var rule: some View { Tok.separator.frame(height: Tok.hairline) }

    // MARK: format

    private func tok(_ n: Double) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", n / 1_000_000) }
        if n >= 1_000 { return "\(Int((n / 1000).rounded()))k" }
        return "\(Int(n))"
    }

    /// "in 14h 12m" / "in 2d 6h" / "in 9m" / "soon", from an ISO-8601 reset timestamp.
    private func resetLabel(_ iso: String?) -> String? {
        guard let d = Self.parseISO(iso) else { return nil }
        let secs = Int(d.timeIntervalSinceNow)
        guard secs > 0 else { return "soon" }
        let days = secs / 86400, h = (secs % 86400) / 3600, m = (secs % 3600) / 60
        if days > 0 { return "in \(days)d \(h)h" }
        if h > 0 { return "in \(h)h \(m)m" }
        return m > 0 ? "in \(m)m" : "in <1m"
    }

    /// Parse "2026-06-29T10:39:59.480208+00:00" (microsecond precision, offset tz).
    static func parseISO(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression))
    }
}
