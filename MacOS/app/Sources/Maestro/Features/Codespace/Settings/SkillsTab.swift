import SwiftUI

/// Per-project skills. Mirrors `ProjectPanel.tsx` SkillsBody ("Project skills"): a description, the
/// installed list first (with a "by agent" badge + source-path subtitle + enable/remove), then a
/// "Search available skills" bar and registry results (pre-populated on mount).
struct SkillsTab: View {
    @Environment(AppEnv.self) private var env
    let project: Project

    @State private var installed: [InstalledSkill] = []
    @State private var registryCount = 0
    @State private var query = ""
    @State private var results: [RegistrySkill] = []
    @State private var searching = false
    @State private var busyId: String?
    @State private var loaded = false

    private var activeCount: Int { installed.filter { $0.enabled != false }.count }
    private var disabledCount: Int { installed.filter { $0.enabled == false }.count }
    private var sortedInstalled: [InstalledSkill] { installed.sorted { ($0.enabled != false ? 0 : 1) < ($1.enabled != false ? 0 : 1) } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                headerBlock
                installedCard
                searchBar
                if searching { Text("Searching…").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary) }
                ForEach(results, id: \.resolvedId) { resultRow($0) }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 28)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .task { if !loaded { await loadAll(); loaded = true } }
    }

    private var headerBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Project skills").font(TokFont.display(TokFont.headline, .bold)).foregroundStyle(Tok.ink)
            Text(metaLine).font(TokFont.text(TokFont.caption, .medium)).foregroundStyle(Tok.inkTertiary)
            (Text("Everything active on this project — including skills the agent installed itself mid-run. Toggle to disable a skill without losing it (its ").foregroundColor(Tok.inkSecondary)
             + Text("SKILL.md").font(TokFont.mono(TokFont.caption))
             + Text(" is set aside); Remove deletes it from ").foregroundColor(Tok.inkSecondary)
             + Text(".claude/skills/").font(TokFont.mono(TokFont.caption)) + Text(".").foregroundColor(Tok.inkSecondary))
                .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).lineSpacing(2)
                .fixedSize(horizontal: false, vertical: true).padding(.top, 2)
        }
    }
    private var metaLine: String {
        var s = "\(activeCount) active"
        if disabledCount > 0 { s += " · \(disabledCount) disabled" }
        if registryCount > 0 { s += " · \(registryCount) in registry" }
        return s
    }

    @ViewBuilder private var installedCard: some View {
        if installed.isEmpty {
            Text("No skills on this project yet. Search below to add one — or the agent will add what it needs during a run, and it'll show up here.")
                .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(style: StrokeStyle(lineWidth: Tok.hairline, dash: [4, 3])).foregroundStyle(Tok.separatorStrong))
        } else {
            VStack(spacing: 0) {
                ForEach(Array(sortedInstalled.enumerated()), id: \.element.id) { i, s in
                    installedRow(s)
                    if i < installed.count - 1 { Tok.separator.frame(height: Tok.hairline) }
                }
            }
            .background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        }
    }

    private func installedRow(_ s: InstalledSkill) -> some View {
        let on = s.enabled != false
        return HStack(alignment: .top, spacing: 10) {
            Icon(name: "spark", size: 15).foregroundStyle(on ? Tok.indigo : Tok.inkTertiary).padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(s.name ?? s.slug ?? s.id).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink).lineLimit(1)
                    if s.addedBy == "agent" {
                        HStack(spacing: 3) {
                            Icon(name: "bolt", size: 10); Text("by agent").font(TokFont.text(TokFont.caption, .semibold))
                        }
                        .foregroundStyle(Tok.indigo).padding(.horizontal, 6).frame(height: 16)
                        .background(Tok.indigo.opacity(0.14)).clipShape(Capsule())
                        .help("The agent installed this itself during a run")
                    }
                    if !on {
                        Text("Disabled").font(TokFont.text(TokFont.caption, .medium)).foregroundStyle(Tok.inkTertiary)
                            .padding(.horizontal, 6).frame(height: 16).background(Tok.fillTertiary).clipShape(Capsule())
                    }
                }
                Text(sourcePath(s)).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 8)
            MSwitch(on: Binding(get: { on }, set: { v in Task { await setEnabled(s, v) } }))
            Button("Remove") { Task { await remove(s) } }
                .buttonStyle(.plain).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.inkSecondary)
                .padding(.horizontal, 10).frame(height: 28)
                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Tok.separator, lineWidth: 1))
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .opacity(on ? 1 : 0.6)
    }

    private func sourcePath(_ s: InstalledSkill) -> String {
        let base = ".claude/skills/\(s.slug ?? s.id)/SKILL.md"
        if let sha = s.sha256, !sha.isEmpty { return base + " · " + String(sha.prefix(12)) }
        return base
    }

    private var searchBar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                Icon(name: "search", size: 14).foregroundStyle(Tok.inkTertiary)
                TextField("Search available skills", text: $query).textFieldStyle(.plain).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.ink)
                    .onSubmit { Task { await runSearch() } }
            }
            .padding(.horizontal, 12).frame(height: 34).background(Tok.bgElevated)
            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Tok.separator, lineWidth: 1))

            Button { Task { await runSearch() } } label: {
                Text(searching ? "Searching" : "Search").font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 14).frame(height: 34).background(Tok.blue).clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            }.buttonStyle(.plain)
        }
    }

    private func resultRow(_ s: RegistrySkill) -> some View {
        let isInstalled = installed.contains { $0.id == s.resolvedId }
        return HStack(alignment: .top, spacing: 12) {
            Circle().fill(riskTint(s.risk)).frame(width: 7, height: 7).padding(.top, 5)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(s.name ?? s.resolvedId).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink)
                    if let src = s.sourceRepo ?? s.mirrorRepo { Text(src).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1) }
                }
                if let d = s.description { Text(d).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary).lineLimit(2) }
            }
            Spacer(minLength: 0)
            Button { Task { await add(s) } } label: {
                Text(isInstalled ? "Added" : (busyId == s.resolvedId ? "Adding" : "Add"))
                    .font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(isInstalled ? Tok.inkTertiary : .white)
                    .padding(.horizontal, 12).frame(height: 28)
                    .background(isInstalled ? Tok.fillTertiary : Tok.blue)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain).disabled(isInstalled || busyId != nil)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    // MARK: data
    private func loadAll() async {
        async let inst = env.client.call("listProjectSkills", ["id": project.id], as: InstalledSkillsResult.self)
        async let meta = env.client.call("skillRegistryMeta", as: RegistryMeta.self)
        installed = (try? await inst)?.skills ?? []
        registryCount = (try? await meta)?.count ?? 0
        // Pre-populate results so the registry shows before typing.
        results = (try? await env.client.call("searchSkills", ["q": "", "limit": 12], as: SkillSearchResult.self))?.results ?? []
    }
    private func runSearch() async {
        searching = true
        results = (try? await env.client.call("searchSkills", ["q": query.trimmed, "limit": 18], as: SkillSearchResult.self))?.results ?? []
        searching = false
    }
    private func add(_ s: RegistrySkill) async {
        busyId = s.resolvedId; defer { busyId = nil }
        try? await env.client.callVoid("addSkillToProject", [
            "projectId": project.id, "skillId": s.resolvedId,
            "name": s.name ?? "", "description": s.description ?? "",
            "risk": s.risk ?? "", "source": s.sourceRepo ?? s.mirrorRepo ?? "", "version": s.version ?? "latest",
        ])
        await reloadInstalled()
    }
    private func remove(_ s: InstalledSkill) async {
        installed.removeAll { $0.id == s.id }
        try? await env.client.callVoid("removeSkillFromProject", ["projectId": project.id, "skillId": s.id])
    }
    private func setEnabled(_ s: InstalledSkill, _ enabled: Bool) async {
        if let i = installed.firstIndex(of: s) { installed[i].enabled = enabled }
        try? await env.client.callVoid("setProjectSkillEnabled", ["projectId": project.id, "skillId": s.id, "enabled": enabled])
    }
    private func reloadInstalled() async {
        installed = (try? await env.client.call("listProjectSkills", ["id": project.id], as: InstalledSkillsResult.self))?.skills ?? []
    }

    private func riskTint(_ risk: String?) -> Color {
        switch risk?.uppercased() {
        case "MEDIUM": return Tok.orange
        case "HIGH", "CRITICAL": return Tok.red
        case "LOW", "SAFE", "NONE": return Tok.green
        default: return Tok.inkTertiary
        }
    }
}
