import SwiftUI

/// Per-project Settings. Mirrors `ProjectPanel.tsx` SettingsBody: a left-label/full-input Field grid
/// (Name / Type / Folder+Reveal / Repository) and, when the project has a folder, a "Worktree
/// isolation" block (Default branch / Run mode / Files to copy / Setup script). Wired to updateProject.
struct ProjectSettingsTab: View {
    @Environment(AppEnv.self) private var env
    let project: Project

    @State private var name = ""
    @State private var defaultBranch = ""
    @State private var runMode = "concurrent"
    @State private var copyGlobs = ""
    @State private var setupScript = ""
    @State private var seeded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                field("Name") {
                    input($name, placeholder: "Project name").onSubmit { save("name", name.trimmed) }
                }
                field("Type") {
                    Text((project.kind ?? "general").capitalized)
                        .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.ink)
                }
                if let path = project.path, !path.isEmpty {
                    field("Folder") {
                        HStack(spacing: 8) {
                            Text(path).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkSecondary).lineLimit(1).truncationMode(.middle)
                            Spacer(minLength: 0)
                            Button("Reveal") { NativeBridge.reveal(path) }.buttonStyle(.plain)
                                .font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.inkSecondary)
                                .padding(.horizontal, 9).frame(height: 26)
                                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Tok.separator, lineWidth: 1))
                        }
                    }
                }
                if let repo = project.repoUrl, !repo.isEmpty {
                    field("Repository") {
                        Text(repo).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkSecondary).lineLimit(1).truncationMode(.middle)
                    }
                }

                if let path = project.path, !path.isEmpty { worktreeIsolation }
            }
            .frame(maxWidth: 560, alignment: .leading)
            .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 28)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .onAppear {
            guard !seeded else { return }
            name = project.name
            defaultBranch = project.defaultBaseBranch ?? ""
            runMode = project.runMode ?? "concurrent"
            copyGlobs = (project.copyGlobs ?? []).joined(separator: ", ")
            setupScript = project.setupScript ?? ""
            seeded = true
        }
    }

    private var worktreeIsolation: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Worktree isolation").font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink)
                Text("Each session runs in its own git worktree. These control how a new worktree is set up and whether sessions can run their dev server in parallel.")
                    .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.top, 6)
            .overlay(alignment: .top) { Tok.separator.frame(height: Tok.hairline).offset(y: -8) }

            field("Default branch") {
                input($defaultBranch, placeholder: "auto-detect (origin/HEAD)", mono: true).onSubmit { save("defaultBaseBranch", defaultBranch.trimmed) }
            }
            field("Run mode") {
                Picker("", selection: Binding(get: { runMode }, set: { runMode = $0; save("runMode", $0) })) {
                    Text("Concurrent — sessions run in parallel (own MOCHI_PORT each)").tag("concurrent")
                    Text("One at a time — shared port / DB / Docker stack").tag("nonconcurrent")
                }
                .labelsHidden().pickerStyle(.menu).font(TokFont.text(TokFont.footnote)).tint(Tok.ink)
            }
            field("Files to copy") {
                input($copyGlobs, placeholder: ".env*, config/*.local.json", mono: true).onSubmit { saveGlobs() }
            }
            // sub-help, indented under the input column
            (Text("Gitignored files copied into each new worktree. A committed ")
             + Text(".worktreeinclude").font(TokFont.mono(TokFont.caption))
             + Text(" at the repo root overrides this. Default ")
             + Text(".env*").font(TokFont.mono(TokFont.caption)) + Text("."))
                .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                .lineSpacing(2).fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 104)
            field("Setup script") {
                input($setupScript, placeholder: "pnpm install", mono: true).onSubmit { save("setupScript", setupScript.trimmed) }
            }
        }
    }

    /// A left-label (92pt) + full-width value row.
    private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Text(label).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary).frame(width: 92, alignment: .leading)
            content().frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: 30)
    }

    /// The `settingsInput` style: 1px hairline border, radius 8, padded, elevated bg.
    private func input(_ value: Binding<String>, placeholder: String, mono: Bool = false) -> some View {
        TextField(placeholder, text: value).textFieldStyle(.plain)
            .font(mono ? TokFont.mono(TokFont.footnote) : TokFont.text(TokFont.footnote)).foregroundStyle(Tok.ink)
            .padding(.horizontal, 10).padding(.vertical, 6)
            .background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Tok.separator, lineWidth: 1))
    }

    private func saveGlobs() {
        let globs = copyGlobs.split(whereSeparator: { $0 == "," || $0 == "\n" }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        Task { try? await env.client.callVoid("updateProject", ["id": project.id, "copyGlobs": globs]) }
    }
    private func save(_ key: String, _ val: String) {
        Task { try? await env.client.callVoid("updateProject", ["id": project.id, key: val]) }
    }
}
