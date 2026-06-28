import SwiftUI

/// One model in the catalog (from `listModels`).
struct ModelDescriptor: Codable, Hashable, Identifiable {
    var key: String
    var id: String?
    var label: String
    var provider: String        // "claude" | "codex" | "cursor"
    var badge: String?          // "NEW"
    var external: Bool?
    var pickerId: String { key }
}

/// A provider group in the catalog (from `listModels`), runnable iff the engine is signed in.
struct ModelGroup: Codable, Hashable, Identifiable {
    var provider: String
    var label: String
    var runnable: Bool
    var reason: String?
    var models: [ModelDescriptor]
    var id: String { provider }
}

/// Process-wide cache so every composer/picker shares one fetch of the catalog.
@MainActor enum ModelCatalogCache { static var groups: [ModelGroup] = [] }

/// The grouped model picker — the full live catalog from the providers (Claude Code / Codex / …),
/// each runnable or greyed with a reason, with a ✓ on the current pick, a ★ favorite, a NEW badge,
/// an ↗ for external models, and a 1–9 shortcut number. Mirrors the web `ModelPicker`.
struct ModelPicker: View {
    @Environment(AppEnv.self) private var env
    @Binding var value: String          // picker key, e.g. "claude:claude-opus-4-8"
    var compact: Bool = false
    var triggerLabel: String? = nil

    @State private var groups: [ModelGroup] = ModelCatalogCache.groups
    @State private var open = false
    @AppStorage("maestro.favoriteModels") private var favCSV = ""

    private var favorites: Set<String> { Set(favCSV.split(separator: ",").map(String.init)) }
    private var current: ModelDescriptor? { groups.flatMap(\.models).first { $0.key == value } }

    var body: some View {
        Button { open.toggle() } label: { trigger }
            .buttonStyle(.plain)
            .popover(isPresented: $open, arrowEdge: .top) { popover }
            .task { await load(force: false) }
            .onChange(of: open) { _, o in if o { Task { await load(force: true) } } }
    }

    private var trigger: some View {
        HStack(spacing: 6) {
            if let t = triggerLabel { Text(t).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.inkTertiary) }
            glyph(current?.provider, size: compact ? 14 : 15)
            Text(current?.label ?? "Model").font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink).lineLimit(1)
            Icon(name: "chevronDown", size: 11).foregroundStyle(Tok.inkTertiary).rotationEffect(.degrees(open ? 180 : 0))
        }
        .padding(.horizontal, compact ? 9 : 11).frame(height: compact ? 28 : 32)
        .background(Tok.fillSecondary).clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    private var popover: some View {
        ScrollView(showsIndicators: false) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(groups) { g in groupView(g) }
                if groups.isEmpty {
                    Text("Loading models…").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary).padding(12)
                }
            }
            .padding(5)
        }
        .frame(width: 272).frame(maxHeight: 420)
        .background(Tok.bgElevated)
    }

    @ViewBuilder private func groupView(_ g: ModelGroup) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(spacing: 6) {
                Text(g.label).font(TokFont.text(TokFont.caption, .bold)).tracking(0.3).foregroundStyle(Tok.inkTertiary)
                if !g.runnable { Text("· not signed in").font(TokFont.text(TokFont.caption, .medium)).foregroundStyle(Tok.orange) }
            }
            .padding(.horizontal, 8).padding(.top, 8).padding(.bottom, 4)
            ForEach(Array(g.models.enumerated()), id: \.element.key) { _, d in modelRow(d, group: g) }
        }
    }

    private func modelRow(_ d: ModelDescriptor, group g: ModelGroup) -> some View {
        let on = d.key == value
        let n = shortcutNumber(for: d)
        let starred = favorites.contains(d.key)
        return Button {
            guard g.runnable else { return }
            value = d.key; open = false
        } label: {
            HStack(spacing: 9) {
                glyph(d.provider, size: 17).frame(width: 22)
                HStack(spacing: 7) {
                    Text(d.label).font(TokFont.text(TokFont.subhead, on ? .semibold : .medium)).foregroundStyle(Tok.ink).lineLimit(1)
                    if d.badge == "NEW" {
                        Text("NEW").font(TokFont.text(9, .bold)).tracking(0.3).foregroundStyle(Tok.purple)
                            .padding(.horizontal, 5).padding(.vertical, 2).background(Tok.purple.opacity(0.16)).clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
                    }
                    if d.external == true { Text("↗").font(.system(size: 11, weight: .semibold)).foregroundStyle(Tok.inkTertiary) }
                }
                Spacer(minLength: 0)
                if on { Icon(name: "check", size: 15).foregroundStyle(Tok.blue) }
                Button { toggleFavorite(d.key) } label: {
                    Image(systemName: starred ? "star.fill" : "star").font(.system(size: 11))
                        .foregroundStyle(starred ? Color(nsColor: NSColor(hex: "#E6B800")) : Tok.inkTertiary)
                        .opacity(starred ? 1 : 0.55)
                }.buttonStyle(.plain)
                if n > 0 { Text("\(n)").font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary).frame(width: 14, alignment: .trailing) }
            }
            .padding(.horizontal, 8).padding(.vertical, 7)
            .background(on ? Tok.blue.opacity(0.12) : .clear).clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            .opacity(g.runnable ? 1 : 0.42).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!g.runnable).help(g.runnable ? "" : (g.reason ?? "Not signed in"))
    }

    @ViewBuilder private func glyph(_ provider: String?, size: CGFloat) -> some View {
        switch provider {
        case "claude": ProviderGlyph(provider: "anthropic", size: size, color: Tok.ink)
        case "codex": ProviderGlyph(provider: "openai", size: size, color: Tok.ink)
        default: Icon(name: "cpu", size: size).foregroundStyle(Tok.ink)
        }
    }

    /// 1-based index across all runnable models (for the shortcut number column).
    private func shortcutNumber(for d: ModelDescriptor) -> Int {
        var i = 0
        for g in groups where g.runnable {
            for m in g.models { i += 1; if m.key == d.key { return i <= 9 ? i : 0 } }
        }
        return 0
    }

    private func toggleFavorite(_ key: String) {
        var s = favorites
        if s.contains(key) { s.remove(key) } else { s.insert(key) }
        favCSV = s.sorted().joined(separator: ",")
    }

    private func load(force: Bool) async {
        if !force && !groups.isEmpty { return }
        let params: [String: Any] = force ? ["refresh": true] : [:]
        if let g = try? await env.client.call("listModels", params, as: [ModelGroup].self) {
            groups = g; ModelCatalogCache.groups = g
            seedDefaultIfNeeded()
        }
    }

    /// Seed a real default key (favorite → first runnable) when the binding is empty / "auto" / stale.
    private func seedDefaultIfNeeded() {
        let known = groups.contains { $0.models.contains { $0.key == value } }
        guard !known || value.isEmpty || value == "auto" else { return }
        let runnable = groups.filter(\.runnable).flatMap(\.models)
        if let fav = runnable.first(where: { favorites.contains($0.key) }) { value = fav.key }
        else if let first = runnable.first { value = first.key }
    }
}
