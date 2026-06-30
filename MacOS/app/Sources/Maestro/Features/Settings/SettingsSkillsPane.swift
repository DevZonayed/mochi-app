import SwiftUI

/// Global skills & tools: the secure-skills registry (search) + the host capability catalog with
/// enable toggles. A compact native take on the embedded SkillsRegistry.
struct SettingsSkillsPane: View {
    @Environment(AppEnv.self) private var env
    @State private var query = ""
    @State private var results: [RegistrySkill] = []
    @State private var searching = false
    @State private var caps: [Capability] = []
    @State private var registryCount = 0
    @State private var loaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            PaneHead(title: "Skills & tools", sub: "\(registryCount) secure skills in the registry.")
            HStack(spacing: 8) {
                Icon(name: "search", size: 15).foregroundStyle(Tok.inkTertiary)
                TextField("Search skills — pdf, stripe, figma…", text: $query)
                    .textFieldStyle(.plain).font(TokFont.text(TokFont.subhead)).onSubmit { Task { await search() } }
            }
            .padding(.horizontal, 12).frame(height: 40).background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tok.separator, lineWidth: Tok.hairline)).frame(maxWidth: 560)

            if searching { Text("Searching…").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary) }
            if !results.isEmpty {
                GroupedList(header: "Registry results") {
                    ForEach(Array(results.enumerated()), id: \.element.resolvedId) { i, s in
                        GLRow(last: i == results.count - 1) {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(s.name ?? s.resolvedId).font(TokFont.text(TokFont.subhead, .semibold)).foregroundStyle(Tok.ink)
                                if let d = s.description { Text(d).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1) }
                            }
                            Spacer()
                            if let src = s.sourceRepo ?? s.mirrorRepo { Text(src).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1) }
                        }
                    }
                }
            }
            GroupedList(header: "Host capabilities", footer: "Toggle the built-in tools available to every run.") {
                ForEach(Array(caps.enumerated()), id: \.element.id) { i, c in
                    GLRow(last: i == caps.count - 1) {
                        Icon(name: c.kind == "mcp" ? "cpu" : "spark", size: 18).foregroundStyle(c.kind == "mcp" ? Tok.teal : Tok.indigo)
                            .frame(width: 34, height: 34).background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 9))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(c.name).font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                            if let d = c.description { Text(d).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary).lineLimit(1) }
                        }
                        Spacer()
                        MSwitch(on: Binding(get: { c.enabled ?? false }, set: { _ in Task { await toggle(c) } }))
                    }
                }
            }
        }
        .frame(maxWidth: 720, alignment: .leading)
        .task {
            if !loaded {
                caps = (try? await env.client.call("listSkills", as: [Capability].self)) ?? []
                registryCount = (try? await env.client.call("skillRegistryMeta", as: RegistryMeta.self))?.count ?? 0
                loaded = true
            }
        }
    }

    private func search() async {
        let q = query.trimmed; guard !q.isEmpty else { results = []; return }
        searching = true
        results = (try? await env.client.call("searchSkills", ["q": q, "limit": 20], as: SkillSearchResult.self))?.results ?? []
        searching = false
    }
    private func toggle(_ c: Capability) async {
        if let i = caps.firstIndex(of: c) { caps[i].enabled = !(c.enabled ?? false) }
        try? await env.client.callVoid("toggleSkill", ["id": c.id])
    }
}
