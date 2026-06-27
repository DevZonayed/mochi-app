import SwiftUI

/// Project memory / standing-instructions editor. Debounced auto-save → updateProject(instructions),
/// with a resolved-view + workspace-folder rail. Mirrors the web InstructionsTab.
struct InstructionsTab: View {
    @Environment(AppEnv.self) private var env
    let project: Project

    enum SaveState { case idle, saving, saved }
    @State private var text = ""
    @State private var lastSaved = ""
    @State private var state: SaveState = .idle
    @State private var debounce: Task<Void, Never>?
    @State private var seeded = false

    var body: some View {
        HStack(alignment: .top, spacing: 20) {
            editorCard
            rail.frame(width: 360)
        }
        .padding(.horizontal, 28).padding(.bottom, 36)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .onAppear { if !seeded { text = project.instructions ?? ""; lastSaved = text; seeded = true } }
    }

    private var editorCard: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Icon(name: "terminal", size: 16).foregroundStyle(Tok.inkSecondary)
                Text("instructions.md").font(TokFont.text(TokFont.subhead, .semibold)).foregroundStyle(Tok.ink)
                Spacer()
                saveIndicator
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }

            TextEditor(text: $text)
                .font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 28).padding(.vertical, 24)
                .frame(minHeight: 420)
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("Standing instructions for this project — the agent reads these before every job. e.g. the stack, conventions, what to never touch, how to open PRs…")
                            .font(TokFont.text(TokFont.body)).foregroundStyle(Tok.inkTertiary)
                            .padding(.horizontal, 33).padding(.vertical, 32).allowsHitTesting(false)
                    }
                }
                .onChange(of: text) { scheduleSave() }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tok.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        .cardShadow()
    }

    @ViewBuilder private var saveIndicator: some View {
        switch state {
        case .saving: HStack(spacing: 5) { Spinner(size: 11).tint(Tok.inkTertiary); Text("Saving…").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary) }
        case .saved: HStack(spacing: 5) { Circle().fill(Tok.green).frame(width: 6, height: 6); Text("Saved").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.green) }
        case .idle: Text("Auto-saves").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
        }
    }

    private var rail: some View {
        VStack(alignment: .leading, spacing: 14) {
            card(eyebrow: "Resolved view", sub: "What the agent actually sees, in order, on every run.") {
                Text(resolvedPreview).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let path = project.path {
                card(eyebrow: "Workspace folder", sub: nil) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(path).font(TokFont.mono(TokFont.footnote)).foregroundStyle(Tok.ink)
                        Text("Jobs in this project run inside this folder on your Mac.")
                            .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                    }
                }
            }
        }
    }

    private var resolvedPreview: String {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return (t.isEmpty ? "" : t + "\n\n---\n\n") + "<your goal for the job>"
    }

    private func card<C: View>(eyebrow: String, sub: String?, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(eyebrow.uppercased()).font(TokFont.text(TokFont.caption, .semibold)).tracking(0.5).foregroundStyle(Tok.inkTertiary)
            if let sub { Text(sub).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).padding(.bottom, 6) }
            content()
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(Tok.bgGrouped).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private func scheduleSave() {
        guard seeded else { return }
        state = .saving
        debounce?.cancel()
        debounce = Task {
            try? await Task.sleep(for: .milliseconds(700))
            if Task.isCancelled { return }
            if text == lastSaved { state = .saved; return }
            do {
                try await env.client.callVoid("updateProject", ["id": project.id, "instructions": text])
                lastSaved = text; state = .saved
            } catch { state = .idle }
        }
    }
}
