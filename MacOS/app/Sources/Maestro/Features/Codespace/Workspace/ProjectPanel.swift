import SwiftUI

/// The per-project hub, opened as a `kind:'project'` tab from the tree's ⋯ menu — not page-tabs on
/// a detail page. Sections: Instructions (memory), Skills & tools, Settings.
struct ProjectPanel: View {
    @Environment(AppEnv.self) private var env
    let project: Project
    @Binding var section: ProjectSection
    let onClose: () -> Void

    private var tint: Color { ProjectColor.color(project.color) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().overlay(Tok.separator)
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 14) {
            Icon(name: project.kind == "design" ? "brush" : "terminal", size: 22).foregroundStyle(tint)
                .frame(width: 44, height: 44).background(tint.opacity(0.15)).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(project.name).font(TokFont.display(TokFont.title1, .bold)).foregroundStyle(Tok.ink)
                if let path = project.path {
                    Text(shortPath(path)).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1)
                }
            }
            Spacer()
            if let path = project.path { PillButton(title: "Reveal", icon: "folder", kind: .plain) { NativeBridge.reveal(path) } }
            SegmentedControl(options: ProjectSection.allCases.map { ($0, $0.rawValue, nil) },
                             value: $section)
        }
        .padding(.horizontal, 28).padding(.vertical, 18)
    }

    @ViewBuilder private var content: some View {
        switch section {
        case .instructions: InstructionsTab(project: project)
        case .skills: SkillsTab(project: project)
        case .settings: ProjectSettingsTab(project: project, onArchived: onClose)
        }
    }

    private func shortPath(_ p: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return p.hasPrefix(home) ? "~" + p.dropFirst(home.count) : p
    }
}
