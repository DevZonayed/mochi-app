import SwiftUI
import AppKit

/// Settings → Browser: the agent-browser preferences (enable, headless, Chrome override, default
/// start URL, window size) plus per-project data actions. Reads/writes the `browser` field of the
/// app settings; sends only changed keys under `browser`.
struct BrowserPane: View {
    @Environment(AppEnv.self) private var env
    @State private var settings = BrowserSettings(enabled: true, headless: false, chromePath: nil, defaultStartUrl: nil, windowWidth: nil, windowHeight: nil)
    @State private var chromePath = ""
    @State private var startUrl = ""
    @State private var widthText = ""
    @State private var heightText = ""
    @State private var loaded = false
    @State private var clearedToast: String?

    @State private var chromeProfiles: [ChromeProfile] = []
    @State private var seedSelection: ChromeProfile?
    @State private var seedInfo: SeedInfo?
    @State private var seedImporting = false
    @State private var seedError: String?

    @State private var chrome: ChromeStatus?
    @State private var confirmQuitChrome = false

    private var activeProject: Project? {
        guard let id = env.workspace?.activeProjectId else { return nil }
        return env.workspace?.projects.first { $0.id == id }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            PaneHead(title: "Browser", sub: "How the agent's Chrome runs, and where its data lives.")

            if let c = chrome, !c.installed {
                chromeMissingBanner
            }

            GroupedList(footer: "When off, browser tools and the Browser screen are unavailable.") {
                toggleRow("Enable the agent browser", sub: "Let agents open Chrome to navigate, screenshot, and act on pages.",
                          Binding(get: { settings.enabled }, set: { settings.enabled = $0; persist(["enabled": $0]) }), last: false)
                toggleRow("Run headless", sub: "Hide the Chrome window. Turn off to watch the agent drive.",
                          Binding(get: { settings.headless }, set: { settings.headless = $0; persist(["headless": $0]) }), last: true)
            }

            GroupedList(header: "Chrome", footer: "Leave blank to use the bundled or system Chrome.") {
                GLRow(last: false) {
                    Text("Chrome path").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                    Spacer()
                    TextField("/Applications/Google Chrome.app", text: $chromePath)
                        .textFieldStyle(.plain).font(TokFont.text(TokFont.footnote)).inputBox().frame(maxWidth: 320)
                        .onSubmit { persist(["chromePath": chromePath.trimmed]) }
                    Button { if let p = NativeBridge.pickFolder(prompt: "Choose Chrome") { chromePath = p; persist(["chromePath": p]) } } label: {
                        Icon(name: "folder", size: 14).foregroundStyle(Tok.inkSecondary).frame(width: 28, height: 28)
                            .background(Tok.fillSecondary).clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    }.buttonStyle(.plain)
                }
                GLRow(last: true) {
                    Text("Default start URL").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                    Spacer()
                    TextField("https://example.com", text: $startUrl)
                        .textFieldStyle(.plain).font(TokFont.text(TokFont.footnote)).inputBox().frame(maxWidth: 320)
                        .onSubmit { persist(["defaultStartUrl": startUrl.trimmed]) }
                }
            }

            GroupedList(header: "Window size", footer: "The viewport Chrome opens with. Blank uses the default.") {
                GLRow(last: false) {
                    Text("Width").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                    Spacer()
                    TextField("1280", text: $widthText)
                        .textFieldStyle(.plain).font(TokFont.text(TokFont.footnote)).inputBox().frame(width: 120)
                        .onSubmit { commitSize() }
                }
                GLRow(last: true) {
                    Text("Height").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                    Spacer()
                    TextField("800", text: $heightText)
                        .textFieldStyle(.plain).font(TokFont.text(TokFont.footnote)).inputBox().frame(width: 120)
                        .onSubmit { commitSize() }
                }
            }

            GroupedList(header: "Profile data", footer: activeProject == nil ? "Open a project in CodeSpace to manage its browser data." : "Cookies, logins, and cache for \(activeProject!.name)'s browser profile.") {
                GLRow(last: false) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Reveal profile in Finder").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                        if let t = clearedToast { Text(t).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.green) }
                    }
                    Spacer()
                    PillButton(title: "Reveal", kind: .plain, disabled: activeProject == nil) { Task { await revealProfile() } }
                }
                GLRow(last: true) {
                    Text("Clear browser data").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                    Spacer()
                    PillButton(title: "Clear data", kind: .plain, disabled: activeProject == nil) { Task { await clearData() } }
                }
            }

            GroupedList(header: "Seed profile", footer: "New project browsers start signed in from this Chrome profile. Your real Chrome is only read — never changed.") {
                GLRow(last: false) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Sign in from").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                        if let c = chrome, c.installed, let v = c.version, !v.isEmpty {
                            Text("Google Chrome \(v) ✓").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.green)
                        } else {
                            Text("Chrome stays open — Mochi only asks to quit it when needed.").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary)
                        }
                    }
                    Spacer()
                    Menu {
                        if chromeProfiles.isEmpty {
                            Text("No Chrome profiles found")
                        } else {
                            ForEach(chromeProfiles) { p in Button(p.name) { seedSelection = p } }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Text(seedSelection?.name ?? "Choose a profile")
                                .font(TokFont.text(TokFont.footnote, .medium)).foregroundStyle(seedSelection == nil ? Tok.inkSecondary : Tok.ink)
                            Icon(name: "chevronDown", size: 10).foregroundStyle(Tok.inkSecondary)
                        }
                        .padding(.horizontal, 11).frame(height: 28)
                        .background(Tok.bgGrouped).clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
                    }
                    .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                    .disabled(chromeProfiles.isEmpty)
                    PillButton(title: seedImporting ? "Importing…" : "Import", kind: .plain, disabled: seedSelection == nil || chrome?.installed == false, busy: seedImporting) { Task { await startImport() } }
                }
                GLRow(last: true) {
                    VStack(alignment: .leading, spacing: 2) {
                        if let s = seedInfo, !s.sourceDir.isEmpty {
                            Text("Seeded from \(s.sourceName) · \(s.cookieCount) cookies")
                                .font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                            Text("Imported \(RelTime.ago(s.importedAt))").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                        } else {
                            Text("No seed profile set — new browsers start empty.")
                                .font(TokFont.text(TokFont.body)).foregroundStyle(Tok.inkSecondary)
                        }
                        if let e = seedError {
                            HStack(spacing: 6) {
                                Icon(name: "alert", size: 12).foregroundStyle(Tok.red)
                                Text(e).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.red).fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    Spacer()
                    if let s = seedInfo, !s.sourceDir.isEmpty {
                        PillButton(title: "Clear", kind: .plain) { Task { await clearSeed() } }
                    }
                }
            }
        }
        .task {
            if let env = try? await env.client.call("getSettings", as: SettingsEnvelope.self), let b = env.browser {
                settings = b
                chromePath = b.chromePath ?? ""
                startUrl = b.defaultStartUrl ?? ""
                widthText = b.windowWidth.map { String(Int($0)) } ?? ""
                heightText = b.windowHeight.map { String(Int($0)) } ?? ""
            }
            loaded = true
            chrome = try? await env.client.call("browserChromeStatus", as: ChromeStatus.self)
            await loadSeed()
        }
        .confirmationDialog("Quit Google Chrome to import?", isPresented: $confirmQuitChrome, titleVisibility: .visible) {
            Button("Quit & Import", role: .destructive) { Task { await importSeed(quitChrome: true) } }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("Mochi needs to close Chrome to copy '\(seedSelection?.name ?? "this profile")' cleanly. Chrome will reopen automatically when it's done.")
        }
    }

    /// The top-of-pane alert when Chrome isn't installed — without it the agent browser can't run.
    private var chromeMissingBanner: some View {
        HStack(alignment: .top, spacing: 10) {
            Icon(name: "alert", size: 16).foregroundStyle(Tok.orange).padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text("Google Chrome isn't installed — the browser needs it.")
                    .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Install it, then reopen this.")
                    .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary)
            }
            Spacer(minLength: 8)
            PillButton(title: "Download Chrome", kind: .primary) { Task { await installChrome() } }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Tok.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Tok.orange.opacity(0.3), lineWidth: Tok.hairline))
    }

    private func loadSeed() async {
        chromeProfiles = (try? await env.client.call("browserListChromeProfiles", as: ChromeProfileList.self))?.profiles ?? []
        seedInfo = try? await env.client.call("browserSeedInfo", as: SeedInfo.self)
        if seedSelection == nil {
            if let dir = seedInfo?.sourceDir, !dir.isEmpty { seedSelection = chromeProfiles.first { $0.dir == dir } }
            seedSelection = seedSelection ?? chromeProfiles.first
        }
    }

    private func toggleRow(_ label: String, sub: String? = nil, _ on: Binding<Bool>, last: Bool) -> some View {
        GLRow(last: last) {
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                if let sub { Text(sub).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer()
            MSwitch(on: on).scaleEffect(0.78)
        }
    }

    private func commitSize() {
        let w = Double(widthText.trimmed)
        let h = Double(heightText.trimmed)
        settings.windowWidth = w; settings.windowHeight = h
        persist(["windowWidth": w as Any, "windowHeight": h as Any])
    }

    /// Persist only the changed keys under `browser` (skip the initial seed load).
    private func persist(_ changed: [String: Any]) {
        guard loaded else { return }
        Task { try? await env.client.callVoid("setSettings", ["browser": changed]) }
    }

    private func revealProfile() async {
        guard let id = activeProject?.id else { return }
        guard let r = try? await env.client.call("browserRevealProfile", ["projectId": id], as: BrowserProfilePath.self) else { return }
        NativeBridge.reveal(r.path)
    }

    private func clearData() async {
        guard let id = activeProject?.id else { return }
        try? await env.client.callVoid("browserClearData", ["projectId": id])
        clearedToast = "Cleared ✓"
        try? await Task.sleep(for: .seconds(2)); clearedToast = nil
    }

    /// Re-check Chrome's live state, then either confirm-and-quit (Chrome running) or import directly.
    private func startImport() async {
        guard seedSelection != nil else { return }
        seedError = nil
        chrome = (try? await env.client.call("browserChromeStatus", as: ChromeStatus.self)) ?? chrome
        if chrome?.running == true {
            confirmQuitChrome = true
        } else {
            await importSeed(quitChrome: false)
        }
    }

    /// Copy the selected profile into the golden seed. With `quitChrome`, the sidecar gracefully
    /// closes Chrome, imports, then reopens it — a few seconds, so keep the spinner up throughout.
    private func importSeed(quitChrome: Bool) async {
        guard let sel = seedSelection else { return }
        seedImporting = true; seedError = nil; defer { seedImporting = false }
        do {
            seedInfo = try await env.client.call("browserImportSeed", ["profileDir": sel.dir, "sourceName": sel.name, "quitChrome": quitChrome], as: SeedInfo.self)
        } catch {
            seedError = error.localizedDescription
        }
    }

    private func installChrome() async {
        try? await env.client.callVoid("browserInstallChrome")
    }

    private func clearSeed() async {
        seedError = nil
        try? await env.client.callVoid("browserClearSeed")
        await loadSeed()
    }
}
