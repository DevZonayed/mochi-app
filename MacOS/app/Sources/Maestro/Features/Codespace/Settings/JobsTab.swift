import SwiftUI

/// Per-project job list. Mirrors `ProjectPanel.tsx` JobsBody: rows sorted newest-first with a
/// status dot, title (fallbacks to the prompt), status text, optional cost, and a relative time.
struct JobsTab: View {
    @Environment(AppEnv.self) private var env
    let project: Project

    @State private var jobs: [Job]? = nil

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                if jobs == nil {
                    Text("Loading…").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                } else if (jobs ?? []).isEmpty {
                    Text("No jobs yet for this project.")
                        .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                        .frame(maxWidth: .infinity).padding(.vertical, 32)
                } else {
                    ForEach(sorted) { jobRow($0) }
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 28)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .task { jobs = (try? await env.client.call("listJobs", ["projectId": project.id], as: [Job].self)) ?? [] }
    }

    private var sorted: [Job] { (jobs ?? []).sorted { ($0.updatedAt ?? $0.createdAt) > ($1.updatedAt ?? $1.createdAt) } }

    private func jobRow(_ j: Job) -> some View {
        HStack(spacing: 10) {
            Circle().fill(statusTint(j.status)).frame(width: 8, height: 8)
            Text(jobTitle(j)).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.ink).lineLimit(1)
            Spacer(minLength: 8)
            Text(j.status.replacingOccurrences(of: "_", with: " ").capitalized)
                .font(TokFont.text(TokFont.caption)).foregroundStyle(statusTint(j.status))
            if let c = j.cost, c > 0 {
                Text(String(format: "$%.2f", c)).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
            }
            Text(relTime(j.updatedAt ?? j.createdAt)).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                .frame(minWidth: 56, alignment: .trailing)
        }
        .padding(.horizontal, 12).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private func jobTitle(_ j: Job) -> String {
        if let t = j.title, !t.isEmpty { return t }
        let input = j.input.trimmed
        return input.isEmpty ? "Job" : String(input.prefix(80))
    }

    private func statusTint(_ s: String) -> Color {
        switch s {
        case "done": Tok.green
        case "running": Tok.blue
        case "failed": Color(nsColor: NSColor(hex: "#e5484d"))
        case "cancelled": Tok.inkTertiary
        case "pending": Color(nsColor: NSColor(hex: "#d9821b"))
        default: Tok.inkTertiary
        }
    }

    /// "just now" / "Nm ago" / "Nh ago" / "Nd ago" / "Nw ago" from an epoch-ms timestamp.
    private func relTime(_ ms: Double) -> String {
        let secs = max(0, Date().timeIntervalSince1970 - ms / 1000)
        if secs < 60 { return "just now" }
        if secs < 3600 { return "\(Int(secs / 60))m ago" }
        if secs < 86400 { return "\(Int(secs / 3600))h ago" }
        if secs < 604800 { return "\(Int(secs / 86400))d ago" }
        return "\(Int(secs / 604800))w ago"
    }
}
