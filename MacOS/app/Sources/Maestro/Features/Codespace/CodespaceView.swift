import SwiftUI

/// CodeSpace — the coding-projects gallery + inline create + navigation into a project.
struct CodespaceView: View {
    @Environment(AppEnv.self) private var env
    @State private var store: ProjectsStore?
    @State private var listView = false
    @State private var creating = false
    @State private var openProject: Project?
    @State private var confirmDelete: Project?

    var body: some View {
        Group {
            if let p = openProject {
                ProjectDetailView(project: p) { openProject = nil }
            } else {
                gallery
            }
        }
        .task {
            if store == nil { store = ProjectsStore(client: env.client) }
            await waitConnectedAndLoad()
        }
        .sheet(isPresented: $creating) {
            CreateProjectSheet { id in
                Task {
                    await store?.reload()
                    if let p = store?.projects.first(where: { $0.id == id }) { openProject = p }
                }
            }
            .environment(env)
        }
        .confirmationDialog("Delete project?", isPresented: Binding(get: { confirmDelete != nil }, set: { if !$0 { confirmDelete = nil } }), titleVisibility: .visible) {
            Button("Delete project", role: .destructive) { if let p = confirmDelete { Task { await store?.delete(p) } } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Removes “\(confirmDelete?.name ?? "")” and its chats from Maestro. The folder on disk is left untouched.")
        }
    }

    private var gallery: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                content
            }
            .padding(.top, 26).padding(.horizontal, 28).padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private var header: some View {
        let s = store
        HStack(alignment: .bottom) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Projects").font(TokFont.display(TokFont.largeTitle, .bold)).foregroundStyle(Tok.ink)
                Text(subtitle(s)).font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary)
            }
            Spacer()
            HStack(spacing: 12) {
                SegmentedControl(options: [(false, "Grid", "layers"), (true, "List", "jobs")],
                                 value: Binding(get: { listView }, set: { listView = $0 }))
                if let s, s.hiddenCount > 0 {
                    Button { s.showHidden.toggle() } label: {
                        HStack(spacing: 7) {
                            Icon(name: s.showHidden ? "eye" : "eyeOff", size: 15)
                            Text("Hidden (\(s.hiddenCount))").font(TokFont.text(TokFont.subhead, .medium))
                        }
                        .foregroundStyle(s.showHidden ? Tok.ink : Tok.inkSecondary)
                        .padding(.horizontal, 14).frame(height: 38)
                        .background(s.showHidden ? Tok.fillSecondary : .clear)
                        .clipShape(Capsule())
                        .overlay(Capsule().strokeBorder(Tok.separator, lineWidth: Tok.hairline))
                    }
                    .buttonStyle(.plain)
                }
                Button { creating = true } label: {
                    HStack(spacing: 7) {
                        Icon(name: "plus", size: 16, weight: .bold)
                        Text("New project").font(TokFont.text(TokFont.callout, .semibold))
                    }
                    .foregroundStyle(.white).padding(.horizontal, 16).frame(height: 38)
                    .background(Tok.blue).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.bottom, 22)
    }

    private func subtitle(_ s: ProjectsStore?) -> String {
        guard let s else { return "Connecting…" }
        let n = s.visible.count
        return "\(n) project\(n == 1 ? "" : "s")"
    }

    @ViewBuilder private var content: some View {
        if let s = store {
            if let err = s.error, s.projects.isEmpty {
                ConnState(icon: "alert", title: "Engine not connected", detail: err)
            } else if s.loading {
                ConnState(icon: "refresh", title: "Loading projects…", detail: nil)
            } else if s.visible.isEmpty {
                ConnState(icon: "layers", title: "No projects yet",
                          detail: "Create one with New project, add an existing folder, or clone a GitHub repo.")
            } else if listView {
                VStack(spacing: 0) {
                    ForEach(s.visible) { p in
                        ProjectRowView(project: p, onOpen: { openProject = p },
                                       onHide: { Task { await s.setHidden(p, !(p.hidden ?? false)) } },
                                       onDelete: { confirmDelete = p })
                    }
                }
                .background(Tok.bgGrouped)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
            } else {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 316), spacing: 18)], spacing: 18) {
                    ForEach(s.visible) { p in
                        ProjectCardView(project: p, onOpen: { openProject = p },
                                        onHide: { Task { await s.setHidden(p, !(p.hidden ?? false)) } },
                                        onDelete: { confirmDelete = p })
                    }
                }
            }
        }
    }

    private func waitConnectedAndLoad() async {
        for _ in 0..<200 {
            if env.client.state == .connected { await store?.load(); return }
            try? await Task.sleep(for: .milliseconds(50))
        }
        if env.client.state != .connected, let s = store {
            s.loading = false
            if case .failed(let m) = env.supervisor.status { s.error = m }
            else { s.error = "The Maestro engine isn't running yet." }
        }
    }
}

struct ProjectCardView: View {
    let project: Project
    var onOpen: () -> Void = {}
    var onHide: () -> Void = {}
    var onDelete: () -> Void = {}
    private var tint: Color { ProjectColor.template(project.kind ?? project.template) }

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(tint).frame(height: 3)
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 12) {
                    Icon(name: iconName, size: 22).foregroundStyle(tint)
                        .frame(width: 42, height: 42).background(tint.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(project.name).font(TokFont.text(TokFont.headline, .semibold)).foregroundStyle(Tok.ink).lineLimit(1)
                        Text(templateLabel).font(TokFont.text(TokFont.footnote, .medium)).foregroundStyle(Tok.inkTertiary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    ProjectMenu(hidden: project.hidden ?? false, onHide: onHide, onDelete: onDelete)
                }
                if let path = project.path {
                    HStack(spacing: 5) {
                        Icon(name: project.repoUrl != nil ? "gitMerge" : "folder", size: 12)
                        Text(shortPath(path)).font(TokFont.mono(TokFont.caption, .semibold)).lineLimit(1)
                    }
                    .foregroundStyle(Tok.inkSecondary).padding(.horizontal, 9).frame(height: 24)
                    .background(Tok.fillTertiary).clipShape(Capsule())
                }
            }
            .padding(18)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tok.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: Tok.Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Tok.Radius.card, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        .cardShadow()
        .opacity(project.hidden == true ? 0.5 : 1)
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
    }

    private var iconName: String { (project.kind ?? project.template) == "design" ? "brush" : "terminal" }
    private var templateLabel: String { (project.kind ?? project.template ?? "Project").capitalized }
    private func shortPath(_ p: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let s = p.hasPrefix(home) ? "~" + p.dropFirst(home.count) : p
        let parts = s.split(separator: "/")
        return parts.count > 3 ? "…/" + parts.suffix(2).joined(separator: "/") : s
    }
}

struct ProjectRowView: View {
    let project: Project
    var onOpen: () -> Void = {}
    var onHide: () -> Void = {}
    var onDelete: () -> Void = {}
    private var tint: Color { ProjectColor.template(project.kind ?? project.template) }
    var body: some View {
        HStack(spacing: 12) {
            Icon(name: (project.kind ?? project.template) == "design" ? "brush" : "terminal", size: 16)
                .foregroundStyle(tint).frame(width: 32, height: 32).background(tint.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                Text(project.name).font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink).lineLimit(1)
                Text((project.kind ?? project.template ?? "Project").capitalized).font(TokFont.text(TokFont.caption, .medium)).foregroundStyle(Tok.inkTertiary)
            }
            Spacer()
            ProjectMenu(hidden: project.hidden ?? false, onHide: onHide, onDelete: onDelete)
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
        .contentShape(Rectangle())
        .onTapGesture(perform: onOpen)
        .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline).padding(.leading, 16) }
        .opacity(project.hidden == true ? 0.5 : 1)
    }
}

struct ProjectMenu: View {
    let hidden: Bool
    let onHide: () -> Void
    let onDelete: () -> Void
    var body: some View {
        Menu {
            Button(hidden ? "Unhide" : "Hide", action: onHide)
            Button("Delete", role: .destructive, action: onDelete)
        } label: {
            Icon(name: "more", size: 16).foregroundStyle(Tok.inkTertiary).frame(width: 30, height: 30).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
    }
}

struct ConnState: View {
    let icon: String; let title: String; let detail: String?
    var body: some View {
        VStack(spacing: 16) {
            Icon(name: icon, size: 30).foregroundStyle(Tok.inkTertiary)
                .frame(width: 64, height: 64).background(Tok.fillSecondary)
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            Text(title).font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
            if let detail {
                Text(detail).font(TokFont.text(TokFont.body)).foregroundStyle(Tok.inkSecondary)
                    .multilineTextAlignment(.center).frame(maxWidth: 420)
            }
        }
        .frame(maxWidth: .infinity).padding(.top, 70)
    }
}
