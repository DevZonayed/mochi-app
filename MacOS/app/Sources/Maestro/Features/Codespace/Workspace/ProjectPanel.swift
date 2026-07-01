import SwiftUI

/// The per-project hub, opened as a `kind:'project'` tab from the tree's ⋯ menu. Mirrors
/// `lib/ProjectPanel.tsx`: a small folder title icon + name, an underlined sub-tab bar
/// (Settings / Instructions / Memory / Skills / WhatsApp / Jobs), then the active body.
struct ProjectPanel: View {
    @Environment(AppEnv.self) private var env
    let project: Project
    @Binding var section: ProjectSection
    let onClose: () -> Void

    private var tint: Color { ProjectColor.color(project.color) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            subTabBar
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Tok.bg)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Icon(name: project.kind == "design" ? "brush" : "folder", size: 20).foregroundStyle(tint)
            Text(project.name).font(TokFont.display(20, .bold)).foregroundStyle(Tok.ink).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16).padding(.top, 14)
    }

    private var subTabBar: some View {
        HStack(spacing: 2) {
            ForEach(ProjectSection.allCases, id: \.self) { s in
                let on = section == s
                Button { section = s } label: {
                    HStack(spacing: 7) {
                        Icon(name: s.icon, size: 15)
                        Text(s.rawValue).font(TokFont.text(TokFont.subhead, on ? .semibold : .medium))
                    }
                    .foregroundStyle(on ? Tok.ink : Tok.inkSecondary)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .overlay(alignment: .bottom) {
                        if on { Tok.blue.frame(height: 2).clipShape(Capsule()).padding(.horizontal, 8).offset(y: 1) }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.top, 10)
        .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }
    }

    @ViewBuilder private var content: some View {
        switch section {
        case .settings: ProjectSettingsTab(project: project)
        case .instructions: InstructionsTab(project: project)
        case .memory: MemoryTab(project: project)
        case .skills: SkillsTab(project: project)
        case .whatsapp: WhatsAppTab(project: project)
        case .jobs: JobsTab(project: project)
        }
    }
}
