import SwiftUI

/// Per-project Settings: live project info (name, default branch, setup script, run-mode worktree
/// isolation) + a Danger zone (archive). Wired to updateProject — unlike the web's static mock.
struct ProjectSettingsTab: View {
    @Environment(AppEnv.self) private var env
    let project: Project
    let onArchived: () -> Void

    @State private var name = ""
    @State private var defaultBranch = ""
    @State private var setupScript = ""
    @State private var runMode = "concurrent"
    @State private var seeded = false
    @State private var confirmArchive = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                GroupedList(header: "Project") {
                    GLRow { Text("Name").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                        Spacer()
                        commitField($name, "Project name", key: "name") }
                    GLRow { Text("Default branch").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                        Spacer()
                        commitField($defaultBranch, "auto", key: "defaultBaseBranch", mono: true) }
                    GLRow { Text("Run mode").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                        Spacer()
                        SegmentedControl(options: [("concurrent", "Concurrent", nil), ("nonconcurrent", "One at a time", nil)],
                                         value: Binding(get: { runMode }, set: { runMode = $0; save("runMode", $0) })) }
                    if let path = project.path {
                        GLRow(last: true) { Text("Folder").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                            Spacer()
                            Text(path).font(TokFont.mono(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).lineLimit(1) }
                    }
                }

                GroupedList(header: "Setup", footer: "Shell script run once in each new session worktree (e.g. install deps).") {
                    GLRow(last: true) {
                        TextField("e.g. pnpm install", text: $setupScript, axis: .vertical)
                            .textFieldStyle(.plain).font(TokFont.mono(TokFont.footnote)).foregroundStyle(Tok.ink)
                            .lineLimit(1...4).onSubmit { save("setupScript", setupScript) }
                    }
                }

                GroupedList(header: "Danger zone", footer: "Archiving stops all jobs and hides the project. The folder on disk is untouched.") {
                    GLRow(last: true) {
                        Text("Archive project").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.red)
                        Spacer()
                        Icon(name: "chevronRight", size: 16).foregroundStyle(Tok.inkTertiary)
                    }
                    .onTapGesture { confirmArchive = true }
                }
            }
            .frame(maxWidth: 680, alignment: .leading)
            .padding(.horizontal, 28).padding(.bottom, 36)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .onAppear {
            if !seeded {
                name = project.name; defaultBranch = project.defaultBaseBranch ?? ""
                setupScript = project.setupScript ?? ""; runMode = project.runMode ?? "concurrent"; seeded = true
            }
        }
        .confirmationDialog("Archive “\(project.name)”?", isPresented: $confirmArchive, titleVisibility: .visible) {
            Button("Archive project", role: .destructive) {
                Task { try? await env.client.callVoid("updateProject", ["id": project.id, "hidden": true]); onArchived() }
            }
            Button("Cancel", role: .cancel) {}
        }
    }

    private func commitField(_ value: Binding<String>, _ placeholder: String, key: String, mono: Bool = false) -> some View {
        TextField(placeholder, text: value)
            .textFieldStyle(.plain).multilineTextAlignment(.trailing)
            .font(mono ? TokFont.mono(TokFont.footnote) : TokFont.text(TokFont.body))
            .foregroundStyle(Tok.inkSecondary).frame(maxWidth: 280)
            .onSubmit { save(key, value.wrappedValue) }
    }

    private func save(_ key: String, _ val: String) {
        Task { try? await env.client.callVoid("updateProject", ["id": project.id, key: val]) }
    }
}
