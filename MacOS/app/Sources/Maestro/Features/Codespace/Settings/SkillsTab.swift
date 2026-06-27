import SwiftUI

/// Project-scoped skills + tools: registry search→add, installed list (enable/remove), built-in
/// capabilities, and the deny-by-default Allowed-MCP section. Mirrors the web SkillsTab.
struct SkillsTab: View {
    @Environment(AppEnv.self) private var env
    let project: Project

    @State private var installed: [InstalledSkill] = []
    @State private var builtins: [Capability] = []
    @State private var mcps: [Capability] = []
    @State private var registryCount = 0
    @State private var query = ""
    @State private var results: [RegistrySkill] = []
    @State private var searching = false
    @State private var busyId: String?
    @State private var loaded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                addSkill
                if !installed.isEmpty { installedSection }
                if !builtins.isEmpty { builtinSection }
                mcpSection
            }
            .frame(maxWidth: 720, alignment: .leading)
            .padding(.horizontal, 28).padding(.bottom, 36)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .task { if !loaded { await loadAll(); loaded = true } }
    }

    // MARK: registry search
    private var addSkill: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Add a skill").font(TokFont.display(TokFont.headline, .bold)).foregroundStyle(Tok.ink)
                Text("\(registryCount) secure skills in the registry").font(TokFont.text(TokFont.caption, .medium)).foregroundStyle(Tok.inkTertiary)
            }
            HStack(spacing: 8) {
                Icon(name: "search", size: 15).foregroundStyle(Tok.inkTertiary)
                TextField("Search skills — e.g. pdf, google sheets, stripe, next.js…", text: $query)
                    .textFieldStyle(.plain).font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.ink)
                    .onSubmit { Task { await runSearch() } }
            }
            .padding(.horizontal, 12).frame(height: 38).background(Tok.fillTertiary)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))

            if searching { Text("Searching…").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary) }
            ForEach(results, id: \.resolvedId) { resultRow($0) }
            if !searching && !query.isEmpty && results.isEmpty {
                Text("No skills match “\(query)”. The agent can also add skills itself during a run.")
                    .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
            }
        }
    }

    private func resultRow(_ s: RegistrySkill) -> some View {
        let isInstalled = installed.contains { $0.id == s.resolvedId }
        return HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(s.name ?? s.resolvedId).font(TokFont.text(TokFont.subhead, .semibold)).foregroundStyle(Tok.ink)
                    Circle().fill(riskTint(s.risk)).frame(width: 6, height: 6)
                    if let src = s.sourceRepo ?? s.mirrorRepo { Text(src).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1) }
                }
                if let d = s.description { Text(d).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).lineLimit(2) }
            }
            Spacer(minLength: 0)
            Button { Task { await add(s) } } label: {
                Text(isInstalled ? "Added" : (busyId == s.resolvedId ? "Adding…" : "Add"))
                    .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(isInstalled ? Tok.inkTertiary : .white)
                    .padding(.horizontal, 13).frame(height: 30)
                    .background(isInstalled ? Tok.fillTertiary : Tok.blue)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain).disabled(isInstalled || busyId != nil)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private var installedSection: some View {
        GroupedList(header: "Installed in this project") {
            ForEach(Array(installed.enumerated()), id: \.element.id) { i, s in
                GLRow(last: i == installed.count - 1) {
                    Icon(name: "spark", size: 16).foregroundStyle(Tok.indigo)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(s.name ?? s.slug ?? s.id).font(TokFont.text(TokFont.subhead, .semibold)).foregroundStyle(Tok.ink)
                        if let d = s.description { Text(d).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1) }
                    }
                    Spacer()
                    MSwitch(on: Binding(get: { s.enabled ?? true }, set: { v in Task { await setEnabled(s, v) } }))
                    Button("Remove") { Task { await remove(s) } }
                        .buttonStyle(.plain).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.inkTertiary)
                }
            }
        }
    }

    private var builtinSection: some View {
        GroupedList(header: "Built-in capabilities") {
            ForEach(Array(builtins.enumerated()), id: \.element.id) { i, c in
                capabilityRow(c, icon: "spark", last: i == builtins.count - 1)
            }
        }
    }

    private var mcpSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                Icon(name: "shield", size: 18).foregroundStyle(Tok.orange)
                (Text("Deny by default. ").font(TokFont.text(TokFont.footnote, .semibold)) +
                 Text("Agents can only reach the MCP servers you enable here.").font(TokFont.text(TokFont.footnote)))
                    .foregroundStyle(Tok.ink)
            }
            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
            .background(Tok.orange.opacity(0.10))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Tok.orange.opacity(0.3), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

            GroupedList(header: "Allowed MCP servers",
                        footer: "Manage servers in Settings → MCP servers — agents reach only what you allow.") {
                if mcps.isEmpty {
                    Text("No MCP servers connected yet.").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                        .padding(.horizontal, 14).padding(.vertical, 16).frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ForEach(Array(mcps.enumerated()), id: \.element.id) { i, c in
                        capabilityRow(c, icon: "cpu", last: i == mcps.count - 1)
                    }
                }
            }
        }
    }

    private func capabilityRow(_ c: Capability, icon: String, last: Bool) -> some View {
        GLRow(last: last) {
            Icon(name: icon, size: 18).foregroundStyle(Tok.blue)
                .frame(width: 34, height: 34).background(Tok.fillTertiary)
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 8) {
                    Text(c.name).font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                    if let v = c.version { Text("v\(v)").font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkSecondary).padding(.horizontal, 7).background(Tok.fillSecondary).clipShape(Capsule()) }
                }
                if let d = c.description { Text(d).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary).lineLimit(1) }
            }
            Spacer()
            MSwitch(on: Binding(get: { c.enabled ?? false }, set: { _ in Task { await toggle(c) } }))
        }
    }

    // MARK: data
    private func loadAll() async {
        async let inst = env.client.call("listProjectSkills", ["id": project.id], as: InstalledSkillsResult.self)
        async let caps = env.client.call("listSkills", as: [Capability].self)
        async let meta = env.client.call("skillRegistryMeta", as: RegistryMeta.self)
        installed = (try? await inst)?.skills ?? []
        let c = (try? await caps) ?? []
        builtins = c.filter { $0.kind != "mcp" }
        mcps = c.filter { $0.kind == "mcp" }
        registryCount = (try? await meta)?.count ?? 0
    }

    private func runSearch() async {
        let q = query.trimmed
        guard !q.isEmpty else { results = []; return }
        searching = true
        results = (try? await env.client.call("searchSkills", ["q": q, "limit": 24], as: SkillSearchResult.self))?.results ?? []
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
    private func toggle(_ c: Capability) async {
        if let i = builtins.firstIndex(of: c) { builtins[i].enabled = !(c.enabled ?? false) }
        if let i = mcps.firstIndex(of: c) { mcps[i].enabled = !(c.enabled ?? false) }
        try? await env.client.callVoid("toggleSkill", ["id": c.id])
    }
    private func reloadInstalled() async {
        installed = (try? await env.client.call("listProjectSkills", ["id": project.id], as: InstalledSkillsResult.self))?.skills ?? []
    }

    private func riskTint(_ risk: String?) -> Color {
        switch risk?.uppercased() {
        case "MEDIUM", "HIGH": return Tok.orange
        case "LOW", "SAFE", "NONE": return Tok.green
        default: return Tok.inkTertiary
        }
    }
}
