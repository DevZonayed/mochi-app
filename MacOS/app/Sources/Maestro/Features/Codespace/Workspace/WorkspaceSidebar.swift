import SwiftUI
import AppKit

/// The CodeSpace left tree: header, filter, and projects → chats (expandable), with the per-project
/// hub on the ⋯ menu. Mirrors Workspace.tsx's sidebar.
struct WorkspaceSidebar: View {
    @Environment(AppEnv.self) private var env
    @Bindable var store: WorkspaceStore
    var width: CGFloat = 260
    let onAddProject: () -> Void

    @State private var renamingId: String?
    @State private var renameText = ""
    @State private var hoverSession: String?
    @State private var hoverProject: String?
    @State private var confirmDeleteProject: Project?
    @State private var pickerProject: Project?   // project whose base-branch picker is open

    var body: some View {
        VStack(spacing: 0) {
            header
            if !store.projects.isEmpty { filters }
            tree
        }
        .frame(width: width)
        .background(Tok.bgGrouped)
        .sheet(item: $confirmDeleteProject) { deleteProjectModal($0) }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Icon(name: "terminal", size: 16).foregroundStyle(Tok.blue)
            Text("CodeSpace").font(TokFont.display(TokFont.callout, .bold)).foregroundStyle(Tok.ink)
            Spacer()
            Button(action: onAddProject) {
                Icon(name: "plus", size: 16, weight: .bold).foregroundStyle(Tok.inkTertiary).frame(width: 28, height: 28).contentShape(Rectangle())
            }.buttonStyle(.plain)
        }
        .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 10)
    }

    private var filters: some View {
        VStack(spacing: 8) {
            HStack(spacing: 7) {
                Icon(name: "search", size: 14).foregroundStyle(Tok.inkTertiary)
                TextField("Filter projects & chats…", text: $store.query).textFieldStyle(.plain).font(TokFont.text(TokFont.footnote))
            }
            .padding(.horizontal, 10).frame(height: 32).background(Tok.fillSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Tok.separator, lineWidth: Tok.hairline))

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 5) {
                    ForEach(KindFilter.allCases, id: \.self) { k in
                        let n = store.kindCount(k)
                        if k == .all || n > 0 {
                            let on = store.kind == k
                            Button { store.kind = k } label: {
                                HStack(spacing: 5) {
                                    Icon(name: k.icon, size: 12); Text(k.label).font(TokFont.text(TokFont.caption, .semibold)); Text("\(n)").opacity(0.7).font(TokFont.text(TokFont.caption))
                                }
                                .foregroundStyle(on ? Tok.blue : Tok.inkSecondary)
                                .padding(.horizontal, 9).frame(height: 26)
                                .background(on ? Tok.blue.opacity(0.16) : Tok.fillSecondary)
                                .overlay(Capsule().strokeBorder(on ? Tok.blue.opacity(0.45) : .clear, lineWidth: 1))
                                .clipShape(Capsule())
                            }.buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 12).padding(.bottom, 10)
    }

    private var tree: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                if store.loading && store.projects.isEmpty {
                    Spinner(size: 18).tint(Tok.inkTertiary).frame(maxWidth: .infinity).padding(.vertical, 40)
                } else if store.codeProjects.isEmpty {
                    VStack(spacing: 12) {
                        Text("No projects yet.").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                        Button("Create a project", action: onAddProject).buttonStyle(.plain)
                            .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(.white)
                            .padding(.horizontal, 14).frame(height: 32).background(Tok.blue).clipShape(Capsule())
                    }.frame(maxWidth: .infinity).padding(.vertical, 40)
                } else {
                    sectionLabel(store.kind == .all ? "Projects" : "\(store.kind.label) projects")
                    if store.hiddenCount > 0 {
                        Button { store.showHidden.toggle() } label: {
                            HStack(spacing: 7) {
                                Icon(name: store.showHidden ? "eye" : "eyeOff", size: 13)
                                Text(store.showHidden ? "Hide \(store.hiddenCount) hidden" : "Show \(store.hiddenCount) hidden").font(TokFont.text(TokFont.caption, .medium))
                            }.foregroundStyle(Tok.inkTertiary).padding(.horizontal, 8).padding(.vertical, 4)
                        }.buttonStyle(.plain)
                    }
                    ForEach(store.visibleProjects) { p in projectNode(p) }
                }
            }
            .padding(.horizontal, 8).padding(.bottom, 12)
            .animation(.smooth(duration: 0.3), value: store.projects)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func projectNode(_ p: Project) -> some View {
        let open = store.expanded.contains(p.id) || (!store.query.isEmpty && !store.activeSessions(p.id).isEmpty)
        let active = store.activeProjectId == p.id
        let tint = ProjectColor.template(p.kind ?? p.template)
        return VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 7) {
                Icon(name: "chevronRight", size: 13).foregroundStyle(Tok.inkTertiary)
                    .rotationEffect(.degrees(open ? 90 : 0))
                Icon(name: p.kind == "design" ? "brush" : "folder", size: 14).foregroundStyle(tint).opacity(p.hidden == true ? 0.5 : 1)
                Text(p.name).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink).opacity(p.hidden == true ? 0.5 : 1).lineLimit(1)
                Spacer(minLength: 0)
                let n = store.activeSessions(p.id).count
                if n > 0 { Text("\(n)").font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary) }
                // ⋯ menu + blue "+" new-chat — revealed on row hover (or while active).
                if hoverProject == p.id || active {
                    projectMenu(p)
                    Button {
                        // ⌘/Ctrl+click skips the picker and starts a chat off the default branch.
                        let skip = NSEvent.modifierFlags.contains(.command) || NSEvent.modifierFlags.contains(.control)
                        if skip { store.newChat(p.id) } else { pickerProject = p }
                    } label: {
                        Icon(name: "plus", size: 14, weight: .bold).foregroundStyle(Tok.blue).frame(width: 20, height: 20).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).help("New chat here — pick a base branch (⌘+click to skip)")
                    .popover(isPresented: Binding(get: { pickerProject?.id == p.id }, set: { if !$0 { pickerProject = nil } }), arrowEdge: .trailing) {
                        BranchPicker(projectId: p.id, client: env.client,
                                     onPick: { branch, isDefault in store.newChat(p.id, base: isDefault ? nil : branch); pickerProject = nil },
                                     onClose: { pickerProject = nil })
                    }
                }
            }
            .padding(.horizontal, 6).padding(.vertical, 5)
            .background(active ? tint.opacity(0.13) : .clear)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .hoverFill(active ? .clear : Tok.fillTertiary, radius: 6)
            .overlay(alignment: .leading) { if active { tint.frame(width: 2.5).padding(.vertical, 5) } }
            .contentShape(Rectangle())
            .onHover { hoverProject = $0 ? p.id : (hoverProject == p.id ? nil : hoverProject) }
            .onTapGesture { if p.id != store.activeProjectId { store.switchToProject(p.id) }; store.toggleExpand(p.id) }
            .draggable(p.id) { // drag handle for reordering
                HStack(spacing: 6) { Icon(name: "folder", size: 13).foregroundStyle(tint); Text(p.name).font(TokFont.text(TokFont.caption, .semibold)) }
                    .padding(6).background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 7))
            }
            .dropDestination(for: String.self) { items, _ in
                if let from = items.first { withAnimation(.smooth(duration: 0.3)) { store.moveProject(from, before: p.id) } }
                return true
            }

            if open {
                let sessions = store.activeSessions(p.id)
                if sessions.isEmpty {
                    Button { store.newChat(p.id) } label: {
                        HStack(spacing: 6) { Icon(name: "plus", size: 12).foregroundStyle(Tok.inkTertiary); Text("New chat").font(TokFont.text(TokFont.caption, .medium)).foregroundStyle(Tok.inkTertiary) }
                            .padding(.leading, 26).padding(.vertical, 5)
                    }.buttonStyle(.plain)
                } else {
                    // Cap the active list at 7 (CHAT_PREVIEW) unless searching or expanded.
                    let showAll = store.chatsAllOpen.contains(p.id) || !store.query.isEmpty
                    let shown = showAll ? sessions : Array(sessions.prefix(7))
                    ForEach(shown) { sessionRow($0, tint: tint) }
                    if store.query.isEmpty && sessions.count > 7 {
                        Button { store.toggleChatsOpen(p.id) } label: {
                            Text(showAll ? "Show less" : "Show all \(sessions.count) chats")
                                .font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.blue)
                                .padding(.leading, 26).padding(.vertical, 4)
                        }.buttonStyle(.plain)
                    }
                }
                let arch = store.archivedSessions(p.id)
                if !arch.isEmpty {
                    Button { if store.archivedOpen.contains(p.id) { store.archivedOpen.remove(p.id) } else { store.archivedOpen.insert(p.id) } } label: {
                        HStack(spacing: 5) {
                            Icon(name: store.archivedOpen.contains(p.id) ? "chevronDown" : "chevronRight", size: 10)
                            Icon(name: "archive", size: 11); Text("Archived").font(TokFont.text(TokFont.caption, .medium)); Text("\(arch.count)").font(TokFont.mono(TokFont.caption)).opacity(0.7)
                        }.foregroundStyle(Tok.inkTertiary).padding(.leading, 24).padding(.vertical, 4)
                    }.buttonStyle(.plain)
                    if store.archivedOpen.contains(p.id) { ForEach(arch) { sessionRow($0, tint: tint) } }
                }
            }
        }
    }

    private func sessionRow(_ s: ChatSession, tint: Color) -> some View {
        let on = store.activeTab?.sessionId == s.id
        return HStack(spacing: 6) {
            if let c = s.codename {
                Text(c.uppercased()).font(TokFont.mono(9)).foregroundStyle(Tok.inkTertiary)
            }
            if renamingId == s.id {
                TextField("", text: $renameText).textFieldStyle(.plain).font(TokFont.text(TokFont.caption))
                    .onSubmit { let t = renameText.trimmed; renamingId = nil; if !t.isEmpty { Task { await store.rename(s, t) } } }
            } else {
                Text(s.displayTitle).font(TokFont.text(TokFont.caption, on ? .semibold : .medium))
                    .foregroundStyle(s.isArchived ? Tok.inkTertiary : (on ? Tok.ink : Tok.inkSecondary)).lineLimit(1)
            }
            Spacer(minLength: 0)
            if hoverSession == s.id && renamingId != s.id {
                miniAction("pencil") { renamingId = s.id; renameText = s.title ?? "" }
                miniAction("archive") { Task { await store.setArchived(s, !s.isArchived) } }
                miniAction("trash") { Task { await store.delete(s) } }
            }
        }
        .padding(.leading, 26).padding(.trailing, 6).padding(.vertical, 5)
        .background(on ? Tok.fillSecondary : (hoverSession == s.id ? Tok.fillTertiary : .clear))
        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        .animation(.easeOut(duration: 0.12), value: hoverSession)
        .contentShape(Rectangle())
        .onTapGesture { if renamingId != s.id { store.openChat(s) } }
        .onHover { hovering in
            hoverSession = hovering ? s.id : (hoverSession == s.id ? nil : hoverSession)
            // Preload this session's transcript so opening it is instant.
            if hovering, let pid = s.projectId { TranscriptCache.shared.prefetch(s.id, projectId: pid, client: env.client) }
        }
    }

    private func miniAction(_ icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { Icon(name: icon, size: 11).foregroundStyle(Tok.inkTertiary).frame(width: 18, height: 18).contentShape(Rectangle()) }.buttonStyle(.plain)
    }

    /// The per-project ⋯ menu — Electron order: Project settings / Instructions & memory / Project
    /// skills / Jobs · Reveal in Finder · Hide / Delete. (The global skills-registry shortcut is
    /// omitted — the native sidebar has no route to it.)
    private func projectMenu(_ p: Project) -> some View {
        Menu {
            Button { store.openProjectPanel(p.id, .settings) } label: { Label("Project settings", systemImage: "gearshape") }
            Button { store.openProjectPanel(p.id, .instructions) } label: { Label("Instructions & memory", systemImage: "bookmark") }
            Button { store.openProjectPanel(p.id, .skills) } label: { Label("Project skills", systemImage: "sparkles") }
            Button { store.openProjectPanel(p.id, .jobs) } label: { Label("Jobs", systemImage: "list.bullet") }
            Divider()
            Button { store.openBrowser(p) } label: { Label("Open browser", systemImage: "globe") }
            Button { store.closeBrowser(p) } label: { Label("Close browser", systemImage: "xmark.circle") }
            Divider()
            if let path = p.path, !path.isEmpty {
                Button { NativeBridge.reveal(path) } label: { Label("Reveal in Finder", systemImage: "folder") }
            }
            Divider()
            Button { store.setHidden(p, !(p.hidden ?? false)) } label: {
                Label(p.hidden == true ? "Unhide project" : "Hide project", systemImage: p.hidden == true ? "eye" : "eye.slash")
            }
            Button(role: .destructive) { confirmDeleteProject = p } label: { Label("Delete project", systemImage: "trash") }
        } label: {
            Icon(name: "more", size: 15).foregroundStyle(Tok.inkSecondary).frame(width: 20, height: 20).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
    }

    /// "Delete project?" confirm sheet — matches the Electron destructive modal copy.
    private func deleteProjectModal(_ p: Project) -> some View {
        let n = store.activeSessions(p.id).count + store.archivedSessions(p.id).count
        return VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                Icon(name: "trash", size: 20).foregroundStyle(Tok.red)
                    .frame(width: 40, height: 40).background(Tok.red.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Delete project?").font(TokFont.display(TokFont.headline, .bold)).foregroundStyle(Tok.ink)
                    Text(p.name).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            Text("This removes the project and its \(n) chat\(n == 1 ? "" : "s") from Maestro. The folder on disk is left untouched. This can't be undone.")
                .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Spacer()
                Button("Cancel") { confirmDeleteProject = nil }.buttonStyle(.plain)
                    .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink)
                    .padding(.horizontal, 14).frame(height: 32).background(Tok.fillSecondary).clipShape(Capsule())
                Button("Delete project") { store.deleteProject(p); confirmDeleteProject = nil }.buttonStyle(.plain)
                    .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 14).frame(height: 32).background(Tok.red).clipShape(Capsule())
            }
        }
        .padding(20).frame(width: 380)
    }
    private func sectionLabel(_ t: String) -> some View {
        Text(t.uppercased()).font(TokFont.text(TokFont.caption, .bold)).tracking(0.5).foregroundStyle(Tok.inkTertiary)
            .padding(.horizontal, 8).padding(.top, 6).padding(.bottom, 4)
    }
}
