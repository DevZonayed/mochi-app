import SwiftUI

/// Per-project hub. Breadcrumb + header + scoped tab bar. The Chat tab is the full sessions rail
/// + streamed thread + composer. Instructions/Skills/Settings tabs arrive in P1d.
struct ProjectDetailView: View {
    @Environment(AppEnv.self) private var env
    let project: Project
    let onBack: () -> Void

    enum Tab: String, CaseIterable { case chat = "Chat", instructions = "Instructions", skills = "Skills & tools", settings = "Settings" }
    @State private var tab: Tab = .chat
    @State private var sessions: SessionsStore?
    @State private var activeSessionId: String?

    private var tint: Color { ProjectColor.color(project.color) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerBlock
            tabBar
            Divider().overlay(Tok.separator)
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .task(id: project.id) {
            let s = SessionsStore(projectId: project.id, client: env.client)
            sessions = s
            await s.start()
            activeSessionId = s.active.first?.id
        }
        .onDisappear { sessions?.stop() }
    }

    private var headerBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Button("Projects", action: onBack).buttonStyle(.plain)
                    .font(TokFont.text(TokFont.subhead, .medium)).foregroundStyle(Tok.inkSecondary)
                Icon(name: "chevronRight", size: 14).foregroundStyle(Tok.inkTertiary)
                Text(project.name).font(TokFont.text(TokFont.subhead, .semibold)).foregroundStyle(Tok.ink)
            }
            HStack(alignment: .top, spacing: 16) {
                Icon(name: project.kind == "design" ? "brush" : "terminal", size: 28).foregroundStyle(tint)
                    .frame(width: 52, height: 52).background(tint.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
                VStack(alignment: .leading, spacing: 8) {
                    Text(project.name).font(TokFont.display(TokFont.largeTitle, .bold)).foregroundStyle(Tok.ink)
                    if let path = project.path {
                        HStack(spacing: 5) {
                            Icon(name: project.repoUrl != nil ? "gitMerge" : "folder", size: 12)
                            Text(shortPath(path)).font(TokFont.mono(TokFont.caption, .semibold)).lineLimit(1)
                        }
                        .foregroundStyle(Tok.inkSecondary).padding(.horizontal, 9).frame(height: 22)
                        .background(Tok.fillTertiary).clipShape(Capsule())
                    }
                }
                Spacer()
                if let path = project.path {
                    PillButton(title: "Reveal", icon: "folder", kind: .plain) { NativeBridge.reveal(path) }
                }
            }
        }
        .padding(.horizontal, 28).padding(.top, 18).padding(.bottom, 14)
    }

    private var tabBar: some View {
        HStack(spacing: 0) {
            ForEach(Tab.allCases, id: \.self) { t in
                Button { tab = t } label: {
                    Text(t.rawValue).font(TokFont.text(TokFont.subhead, tab == t ? .semibold : .medium))
                        .foregroundStyle(tab == t ? Tok.ink : Tok.inkSecondary)
                        .frame(width: 120).padding(.vertical, 8)
                        .background(tab == t ? Tok.bgElevated : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3).background(Tok.fillSecondary).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .padding(.horizontal, 28).padding(.bottom, 12)
    }

    @ViewBuilder private var content: some View {
        switch tab {
        case .chat: chatTab
        case .instructions: InstructionsTab(project: project)
        case .skills: SkillsTab(project: project)
        case .settings: ProjectSettingsTab(project: project, onArchived: onBack)
        }
    }

    @ViewBuilder private var chatTab: some View {
        if let sessions {
            HStack(spacing: 14) {
                SessionsRail(store: sessions, activeSessionId: $activeSessionId)
                ChatThread(projectId: project.id, projectName: project.name, sessionId: $activeSessionId) { created in
                    sessions.upsert(created)
                }
            }
            .padding(.horizontal, 28).padding(.bottom, 18)
        } else {
            Spinner(size: 20).tint(Tok.inkTertiary).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func shortPath(_ p: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return p.hasPrefix(home) ? "~" + p.dropFirst(home.count) : p
    }
}
