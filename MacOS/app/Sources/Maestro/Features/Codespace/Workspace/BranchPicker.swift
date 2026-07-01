import SwiftUI

/// Base-branch picker popover, anchored to a project-row "+". Mirrors `BranchPicker.tsx`: a filter,
/// branch rows with default/current/local-only badges + last-commit subtitle + relative time, and
/// the keyboard hints footer. Picking a non-default branch forks the new chat's worktree from it.
struct BranchPicker: View {
    let projectId: String
    let client: MaestroClient
    /// (branchName, isDefault) — caller omits `base` when `isDefault` so the tab title stays clean.
    let onPick: (String, Bool) -> Void
    var onClose: () -> Void = {}

    @State private var all: [BranchInfo]? = nil
    @State private var error: String?
    @State private var query = ""
    @State private var active = 0
    @FocusState private var filterFocused: Bool

    private var visible: [BranchInfo] {
        guard let all else { return [] }
        let q = query.trimmed.lowercased()
        return q.isEmpty ? all : all.filter { $0.name.lowercased().contains(q) }
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            filterField
            listBody
            footer
        }
        .frame(width: 320)
        .background(Tok.bgElevated)
        .task { await load() }
        .onExitCommand { onClose() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Icon(name: "gitBranch", size: 13).foregroundStyle(Tok.inkTertiary)
            Text("Base branch").font(TokFont.text(TokFont.caption, .semibold)).tracking(0.2).foregroundStyle(Tok.inkSecondary)
            Spacer(minLength: 0)
            Button { onClose() } label: { Icon(name: "x", size: 11, weight: .bold).foregroundStyle(Tok.inkTertiary).frame(width: 18, height: 18) }
                .buttonStyle(.plain).help("Close (Esc)")
        }
        .padding(.horizontal, 8).padding(.top, 8).padding(.bottom, 6)
    }

    private var filterField: some View {
        HStack(spacing: 7) {
            Icon(name: "search", size: 13).foregroundStyle(Tok.inkTertiary)
            TextField("Filter branches…", text: $query).textFieldStyle(.plain).font(TokFont.text(TokFont.footnote))
                .focused($filterFocused)
                .onChange(of: query) { active = 0 }
                .onSubmit { if let b = visible.indices.contains(active) ? visible[active] : visible.first { onPick(b.name, b.isDefault) } }
            if !query.isEmpty {
                Button { query = "" } label: { Icon(name: "x", size: 10, weight: .bold).foregroundStyle(Tok.inkTertiary) }.buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 9).frame(height: 30)
        .background(Tok.fillSecondary).clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        .padding(.horizontal, 6).padding(.bottom, 6)
        .onAppear { filterFocused = true }
    }

    @ViewBuilder private var listBody: some View {
        if all == nil {
            VStack(spacing: 6) {
                ForEach(0..<3, id: \.self) { _ in
                    HStack { RoundedRectangle(cornerRadius: 4).fill(Tok.fillTertiary).frame(width: 130, height: 9); Spacer() }
                        .padding(.horizontal, 10).padding(.vertical, 6)
                }
            }.padding(.vertical, 4)
        } else if let error {
            Text("Couldn't load branches. \(error)").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                .frame(maxWidth: .infinity).padding(.vertical, 20).padding(.horizontal, 10)
        } else if visible.isEmpty {
            Text(query.isEmpty ? "No branches found in this project." : "No branch matches “\(query)”.")
                .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                .frame(maxWidth: .infinity).padding(.vertical, 20).padding(.horizontal, 10)
        } else {
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(Array(visible.enumerated()), id: \.element.id) { i, b in branchRow(b, active: i == active) }
                }
                .padding(.horizontal, 6)
            }
            .frame(maxHeight: 320)
        }
    }

    private func branchRow(_ b: BranchInfo, active: Bool) -> some View {
        Button { onPick(b.name, b.isDefault) } label: {
            HStack(alignment: .top, spacing: 9) {
                Icon(name: "gitBranch", size: 13).foregroundStyle(b.isDefault ? Tok.blue : Tok.inkTertiary).padding(.top, 2)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(b.name).font(TokFont.mono(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink).lineLimit(1)
                        if b.isDefault { badge("default", fg: Tok.blue, bg: Tok.blue.opacity(0.16)) }
                        if b.isCurrent && !b.isDefault { badge("current", fg: Tok.inkSecondary, bg: Tok.fillSecondary) }
                        if !b.hasRemote && !b.isDefault { badge("local only", fg: Tok.inkTertiary, bg: .clear) }
                    }
                    if let c = b.lastCommit {
                        Text((c.subject.isEmpty ? c.sha : c.subject) + " · " + relTime(c.date * 1000))
                            .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(active ? Tok.fillSecondary : .clear, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func badge(_ t: String, fg: Color, bg: Color) -> some View {
        Text(t).font(TokFont.text(TokFont.caption, .semibold)).tracking(0.2).foregroundStyle(fg)
            .padding(.horizontal, 6).frame(height: 14).background(bg).clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }

    private var footer: some View {
        HStack(spacing: 8) {
            kbd("⌘"); Text("+ click skips").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
            Spacer(minLength: 0)
            kbd("↵"); Text("pick").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
            kbd("esc"); Text("close").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
        }
        .padding(.horizontal, 8).padding(.top, 6).padding(.bottom, 4)
        .overlay(alignment: .top) { Tok.separator.frame(height: Tok.hairline) }
    }
    private func kbd(_ s: String) -> some View {
        Text(s).font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(Tok.inkSecondary)
            .padding(.horizontal, 4).frame(minWidth: 14, minHeight: 14)
            .background(Tok.fillSecondary).clipShape(RoundedRectangle(cornerRadius: 3, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 3, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private func load() async {
        do {
            let list = try await client.call("listBranches", ["projectId": projectId], as: [BranchInfo].self)
            all = list
            active = list.firstIndex { $0.isDefault } ?? 0
        } catch let e { error = "\(e)"; all = [] }
    }

    private func relTime(_ ms: Double) -> String {
        let secs = max(0, Date().timeIntervalSince1970 - ms / 1000)
        if secs < 60 { return "just now" }
        if secs < 3600 { return "\(Int(secs / 60))m ago" }
        if secs < 86400 { return "\(Int(secs / 3600))h ago" }
        if secs < 604800 { return "\(Int(secs / 86400))d ago" }
        return "\(Int(secs / 604800))w ago"
    }
}
