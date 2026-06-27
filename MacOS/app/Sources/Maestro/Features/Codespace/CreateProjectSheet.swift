import SwiftUI

/// The single native "create a project" surface — covers all three flows inline (no navigation):
/// **New** (local folder), **Add folder** (adopt an existing folder), **Clone** (from a GitHub
/// URL). Mirrors the web AddProjectModal three-tab model. Folder pick is native (NSOpenPanel).
struct CreateProjectSheet: View {
    @Environment(AppEnv.self) private var env
    @Environment(\.dismiss) private var dismiss
    let onCreated: (String) -> Void

    enum Tab: Hashable { case new, folder, clone }
    @State private var tab: Tab = .new

    // New
    @State private var newName = ""
    @State private var newParent = ""
    // Folder
    @State private var folderPath = ""
    // Clone
    @State private var cloneURL = ""
    @State private var cloneDest = ""
    @State private var cloneLines: [String] = []

    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            tabBar
            ScrollView { panel.padding(18) }.frame(minHeight: 240, maxHeight: 360)
            if let error {
                Text(error).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.red)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18).padding(.bottom, 8)
            }
            footer
        }
        .frame(width: 540)
        .background(Tok.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var header: some View {
        HStack(spacing: 12) {
            Icon(name: "plus", size: 18).foregroundStyle(Tok.blue)
                .frame(width: 36, height: 36).background(Tok.blue.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text("Add a project").font(TokFont.display(TokFont.headline, .bold)).foregroundStyle(Tok.ink)
                Text("Stays right here in the workspace — no navigation.")
                    .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
            }
            Spacer()
            IconButton(icon: "x", size: 28, iconSize: 16) { dismiss() }
        }
        .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 8)
    }

    private var tabBar: some View {
        HStack(spacing: 4) {
            tabButton("From folder", .folder)
            tabButton("New", .new)
            tabButton("Clone", .clone)
        }
        .padding(.horizontal, 20).padding(.bottom, 6)
        .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }
    }

    private func tabButton(_ label: String, _ t: Tab) -> some View {
        Button { tab = t; error = nil } label: {
            Text(label).font(TokFont.text(TokFont.footnote, .semibold))
                .foregroundStyle(tab == t ? Tok.ink : Tok.inkSecondary)
                .frame(maxWidth: .infinity).padding(.vertical, 8)
                .background(tab == t ? Tok.bgElevated : .clear)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder private var panel: some View {
        switch tab {
        case .new: newPanel
        case .folder: folderPanel
        case .clone: clonePanel
        }
    }

    private var newPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            field("Project name") { TextField("my-side-project", text: $newName).textFieldStyle(.plain).inputBox() }
            field("Parent folder") {
                HStack {
                    Text(newParent.isEmpty ? "No folder picked yet" : shortPath(newParent))
                        .font(TokFont.mono(TokFont.footnote)).foregroundStyle(newParent.isEmpty ? Tok.inkTertiary : Tok.ink)
                        .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    PillButton(title: newParent.isEmpty ? "Choose…" : "Change…", kind: .plain) {
                        if let p = NativeBridge.pickFolder(prompt: "Choose parent") { newParent = p }
                    }
                }
            }
            infoCard("Creates a local-only coding project at parent/name on your Mac.")
        }
    }

    private var folderPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Pick a folder on your Mac — it becomes a coding project and stays in your workspace. Existing repos are detected automatically.")
                .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
            HStack {
                Text(folderPath.isEmpty ? "No folder picked yet" : shortPath(folderPath))
                    .font(TokFont.mono(TokFont.footnote)).foregroundStyle(folderPath.isEmpty ? Tok.inkTertiary : Tok.ink)
                    .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                PillButton(title: folderPath.isEmpty ? "Pick folder…" : "Change…", kind: .plain) {
                    if let p = NativeBridge.pickFolder(prompt: "Add folder") { folderPath = p }
                }
            }
        }
    }

    private var clonePanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            field("Repository") { TextField("owner/repo · https://github.com/…", text: $cloneURL).textFieldStyle(.plain).inputBox() }
            field("Local destination") {
                HStack {
                    Text(cloneDest.isEmpty ? "No folder picked yet" : shortPath(cloneDest))
                        .font(TokFont.mono(TokFont.footnote)).foregroundStyle(cloneDest.isEmpty ? Tok.inkTertiary : Tok.ink)
                        .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    PillButton(title: cloneDest.isEmpty ? "Choose…" : "Change…", kind: .plain) {
                        if let p = NativeBridge.pickFolder(prompt: "Clone into") { cloneDest = p }
                    }
                }
            }
            if !cloneLines.isEmpty {
                ScrollView {
                    Text(cloneLines.joined(separator: "\n")).font(TokFont.mono(TokFont.caption))
                        .foregroundStyle(Tok.inkSecondary).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 100).padding(10).background(Tok.fillTertiary)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
    }

    private var footer: some View {
        HStack {
            Spacer()
            PillButton(title: "Cancel", kind: .plain) { dismiss() }
            PillButton(title: createLabel, kind: .primary, disabled: !canCreate, busy: busy) { Task { await create() } }
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
        .overlay(alignment: .top) { Tok.separator.frame(height: Tok.hairline) }
    }

    private var createLabel: String { tab == .clone ? "Clone & create" : "Create project" }
    private var canCreate: Bool {
        switch tab {
        case .new: return !newName.trimmed.isEmpty && !newParent.isEmpty
        case .folder: return !folderPath.isEmpty
        case .clone: return !cloneURL.trimmed.isEmpty && !cloneDest.isEmpty
        }
    }

    private func create() async {
        busy = true; error = nil
        defer { busy = false }
        do {
            let proj: Project
            switch tab {
            case .new:
                let safe = newName.trimmed.replacingOccurrences(of: " ", with: "-")
                let path = newParent + "/" + safe
                proj = try await env.client.call("createProject",
                    ["name": newName.trimmed, "path": path, "kind": "coding", "template": "claude-code"], as: Project.self)
            case .folder:
                proj = try await env.client.call("createProject",
                    ["name": (folderPath as NSString).lastPathComponent, "path": folderPath, "kind": "coding", "template": "claude-code"], as: Project.self)
            case .clone:
                // Stream clone progress lines into the panel while the clone runs.
                env.client.onEvent { ev in
                    guard ev.name == "clone", let d = ev.data as? [String: Any] else { return }
                    if let line = d["line"] as? String { Task { @MainActor in cloneLines.append(line) } }
                }
                proj = try await env.client.call("cloneRepo",
                    ["url": cloneURL.trimmed, "dest": cloneDest], as: Project.self)
            }
            onCreated(proj.id)
            dismiss()
        } catch {
            self.error = (error as? RPCError)?.errorDescription ?? error.localizedDescription
        }
    }

    // helpers
    private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.inkSecondary)
            content()
        }
    }
    private func infoCard(_ text: String) -> some View {
        Text(text).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.blue)
            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background(Tok.blue.opacity(0.10)).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    private func shortPath(_ p: String) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return p.hasPrefix(home) ? "~" + p.dropFirst(home.count) : p
    }
}

extension String { var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) } }

extension View {
    func inputBox() -> some View {
        self.font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.ink)
            .padding(.horizontal, 12).frame(height: 38)
            .background(Tok.fillTertiary)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }
}
