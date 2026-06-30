import SwiftUI

/// Project durable memory (`.continuum/STATE.md`) + checkpoints. Mirrors `ProjectPanel.tsx`
/// MemoryBody: a description, a MONO autosaving textarea (700ms debounce → setProjectMemory),
/// and the recent checkpoints list.
struct MemoryTab: View {
    @Environment(AppEnv.self) private var env
    let project: Project

    @State private var state = ""
    @State private var checkpoints: [ProjectMemory.Checkpoint] = []
    @State private var loaded = false
    @State private var seeded = false
    @State private var lastSaved = ""
    @State private var debounce: Task<Void, Never>?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                description
                if !loaded {
                    Text("Loading…").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                } else {
                    editor
                    if !checkpoints.isEmpty { checkpointList }
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 28)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .task { if !loaded { await load() } }
    }

    private var description: some View {
        // "The project's durable memory (.continuum/STATE.md) — loaded into every chat…"
        (Text("The project's ").foregroundColor(Tok.inkSecondary)
         + Text("durable memory").fontWeight(.semibold).foregroundColor(Tok.inkSecondary)
         + Text(" (").foregroundColor(Tok.inkSecondary)
         + Text(".continuum/STATE.md").font(TokFont.mono(TokFont.footnote)).foregroundColor(Tok.ink)
         + Text(") — loaded into every chat so the agent never re-learns this project. The agent keeps it current as it works; you can edit it directly. Shared across coding & design.").foregroundColor(Tok.inkSecondary))
            .font(TokFont.text(TokFont.footnote)).lineSpacing(3)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var editor: some View {
        TextEditor(text: $state)
            .font(TokFont.mono(TokFont.footnote)).foregroundStyle(Tok.ink)
            .scrollContentBackground(.hidden)
            .padding(.horizontal, 14).padding(.vertical, 12)
            .frame(minHeight: 220)
            .background(Tok.bgElevated)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Tok.separator, lineWidth: 1))
            .overlay(alignment: .topLeading) {
                if state.isEmpty {
                    Text("Empty for now. The agent will record decisions, structure, conventions and open threads here as it works — or write what it should always remember.")
                        .font(TokFont.mono(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                        .padding(.horizontal, 19).padding(.vertical, 20).allowsHitTesting(false)
                }
            }
            .onChange(of: state) { scheduleSave() }
    }

    private var checkpointList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("CHECKPOINTS").font(TokFont.text(TokFont.caption, .bold)).tracking(0.5).foregroundStyle(Tok.inkTertiary)
                .padding(.top, 4)
            ForEach(checkpoints) { c in
                HStack(alignment: .top, spacing: 8) {
                    Text("#\(c.id)").font(TokFont.mono(TokFont.caption, .bold)).foregroundStyle(Tok.blue)
                    Text(String(c.summary.prefix(280))).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
                        .lineSpacing(2).fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 12).padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
            }
        }
    }

    private func load() async {
        if let m = try? await env.client.call("getProjectMemory", ["id": project.id], as: ProjectMemory.self) {
            state = m.state; lastSaved = m.state; checkpoints = m.checkpoints ?? []
        }
        seeded = true; loaded = true
    }
    private func scheduleSave() {
        guard seeded else { return }
        debounce?.cancel()
        debounce = Task {
            try? await Task.sleep(for: .milliseconds(700))
            if Task.isCancelled || state == lastSaved { return }
            let v = state
            try? await env.client.callVoid("setProjectMemory", ["id": project.id, "state": v])
            lastSaved = v
        }
    }
}
