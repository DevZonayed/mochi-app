import SwiftUI

/// Standing project instructions. Mirrors `ProjectPanel.tsx` InstructionsBody: a help line + one
/// autosaving textarea (600ms debounce → updateProject{instructions}). The agent always sees these.
struct InstructionsTab: View {
    @Environment(AppEnv.self) private var env
    let project: Project

    @State private var text = ""
    @State private var lastSaved = ""
    @State private var seeded = false
    @State private var debounce: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            (Text("Standing instructions the agent ").foregroundColor(Tok.inkSecondary)
             + Text("always").fontWeight(.semibold).foregroundColor(Tok.inkSecondary)
             + Text(" sees for this project — conventions, gotchas, what to remember. Saved automatically.").foregroundColor(Tok.inkSecondary))
                .font(TokFont.text(TokFont.footnote)).lineSpacing(3).fixedSize(horizontal: false, vertical: true)

            TextEditor(text: $text)
                .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.ink)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 14).padding(.vertical, 12)
                .frame(minHeight: 240)
                .background(Tok.bgElevated)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Tok.separator, lineWidth: 1))
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("e.g. This project uses pnpm. Always run the type-check before finishing. The deploy script is ./scripts/deploy.sh…")
                            .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                            .padding(.horizontal, 19).padding(.vertical, 20).allowsHitTesting(false)
                    }
                }
                .onChange(of: text) { scheduleSave() }
        }
        .frame(maxWidth: 720, alignment: .leading)
        .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 28)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onAppear { if !seeded { text = project.instructions ?? ""; lastSaved = text; seeded = true } }
    }

    private func scheduleSave() {
        guard seeded else { return }
        debounce?.cancel()
        debounce = Task {
            try? await Task.sleep(for: .milliseconds(600))
            if Task.isCancelled || text == lastSaved { return }
            let v = text
            try? await env.client.callVoid("updateProject", ["id": project.id, "instructions": v])
            lastSaved = v
        }
    }
}
