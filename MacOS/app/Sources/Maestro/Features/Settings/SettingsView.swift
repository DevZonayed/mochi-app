import SwiftUI

/// The System-Settings-style screen: 232px section nav + a right pane. Scoped to six sections.
struct SettingsView: View {
    @Environment(AppEnv.self) private var env
    @State private var section: Section = .engines

    enum Section: String, CaseIterable, Identifiable {
        case notifications = "Notifications", engines = "Engines", skills = "Skills & tools", mcp = "MCP servers"
        case accounts = "Accounts & keys", ext = "Browser extension", devices = "Devices"
        var id: String { rawValue }
        var icon: String {
            switch self { case .notifications: "bell"; case .engines: "cpu"; case .skills: "spark"; case .mcp: "terminal"
            case .accounts: "key"; case .ext: "globe"; case .devices: "smartphone" }
        }
        var tint: Color {
            switch self { case .notifications: Tok.orange; case .engines: Tok.purple; case .skills: Tok.indigo; case .mcp: Tok.teal
            case .accounts: Tok.blue; case .ext: Tok.blue; case .devices: Tok.teal }
        }
    }

    var body: some View {
        HStack(spacing: 0) {
            nav
            ScrollView {
                pane
                    .id(section)
                    .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 8)), removal: .opacity))
                    .frame(maxWidth: paneMaxWidth, alignment: .leading)
                    .padding(.horizontal, 32).padding(.vertical, 28).frame(maxWidth: .infinity, alignment: .leading)
            }
            .animation(.smooth(duration: 0.24), value: section)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var paneMaxWidth: CGFloat {
        switch section {
        case .skills: return 1100
        case .devices: return 940
        case .mcp, .accounts, .ext: return 860
        default: return 760
        }
    }

    private var nav: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("Settings").font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
                .padding(.horizontal, 10).padding(.bottom, 14)
            ForEach(Section.allCases) { s in
                Button { withAnimation(.smooth(duration: 0.22)) { section = s } } label: {
                    HStack(spacing: 11) {
                        Icon(name: s.icon, size: 15)
                            .foregroundStyle(section == s ? .white : s.tint)
                            .frame(width: 26, height: 26)
                            .background(section == s ? Color.white.opacity(0.2) : s.tint.opacity(0.14))
                            .clipShape(RoundedRectangle(cornerRadius: 7))
                        Text(s.rawValue).font(TokFont.text(TokFont.subhead, section == s ? .semibold : .medium))
                            .foregroundStyle(section == s ? .white : Tok.ink)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 10).frame(height: 38)
                    .background(section == s ? Tok.blue : .clear).clipShape(RoundedRectangle(cornerRadius: 8))
                }.buttonStyle(.plain)
            }
            Spacer()
        }
        .padding(20).frame(width: 232)
        .background(Tok.bgGrouped).overlay(alignment: .trailing) { Tok.separator.frame(width: Tok.hairline) }
    }

    @ViewBuilder private var pane: some View {
        switch section {
        case .notifications: NotificationsPane()
        case .engines: EnginesPane()
        case .skills: SettingsSkillsPane()
        case .mcp: McpPane()
        case .accounts: AccountsPane()
        case .ext: ExtensionPane()
        case .devices: DevicesPane()
        }
    }
}

/// Pane title + optional subtitle.
struct PaneHead: View {
    let title: String
    var sub: String? = nil
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(TokFont.display(TokFont.title1, .bold)).foregroundStyle(Tok.ink)
            if let sub { Text(sub).font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary) }
        }.padding(.bottom, 18)
    }
}

// MARK: - Engines
struct EnginesPane: View {
    @Environment(AppEnv.self) private var env
    @State private var statuses: [String: EngineStatus] = [:]
    @State private var routing: [String: String] = [:]
    // Default worker / reviewer model (the brain's `roles`). New chats start on the worker model;
    // each chat then remembers its own pick. Empty reviewerKey "off" = no reviewer.
    @State private var workerKey = ""
    @State private var reviewerKey = ""
    @State private var rolesLoaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            PaneHead(title: "Engines", sub: "Which agents run, and what reviews them.")
            GroupedList(header: "Engine status") {
                engineRow("Claude Code", statuses["claude"], last: false)
                engineRow("Codex", statuses["codex"], last: true)
            }
            GroupedList(header: "Default models",
                        footer: "The worker runs your tasks; the reviewer double-checks the result. New chats start on the worker model, then each chat remembers its own pick.") {
                GLRow(last: false) {
                    Text("Worker").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                    Spacer()
                    ModelPicker(value: $workerKey, compact: true)
                }
                GLRow(last: true) {
                    Text("Reviewer").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                    Spacer()
                    reviewerControl
                }
            }
            GroupedList(header: "Media generation", footer: "Which engine renders generated images.") {
                GLRow(last: true) {
                    Text("Image").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                    Spacer()
                    SegmentedControl(options: [("claude", "Claude", nil), ("codex", "Codex", nil)],
                                     value: Binding(get: { routing["image"] ?? "codex" }, set: { setRouting("image", $0) }))
                }
            }
        }
        .task {
            statuses = (try? await env.client.call("engineStatus", as: [String: EngineStatus].self)) ?? [:]
            routing = (try? await env.client.call("getRouting", as: [String: String].self)) ?? [:]
            if let roles = try? await env.client.call("getRoles", as: Roles.self) {
                workerKey = roles.primary.key
                reviewerKey = roles.reviewer.key
            }
            rolesLoaded = true
        }
        // Persist role defaults when the user changes them (skip the initial seed).
        .onChange(of: workerKey) { _, v in
            guard rolesLoaded, !v.isEmpty, v != "auto" else { return }
            Task { try? await env.client.callVoid("setRoles", ["primaryKey": v]) }
        }
        .onChange(of: reviewerKey) { _, v in
            guard rolesLoaded, !v.isEmpty else { return }
            Task { try? await env.client.callVoid("setRoles", ["reviewerKey": v]) }
        }
    }

    @ViewBuilder private var reviewerControl: some View {
        HStack(spacing: 8) {
            Button { reviewerKey = "off" } label: {
                Text("Off").font(TokFont.text(TokFont.caption, .semibold))
                    .foregroundStyle(reviewerKey == "off" ? .white : Tok.inkSecondary)
                    .padding(.horizontal, 11).frame(height: 28)
                    .background(reviewerKey == "off" ? Tok.blue : Tok.fillSecondary)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }.buttonStyle(.plain)
            if reviewerKey == "off" {
                Button {
                    // Seed a concrete key (the worker default, else "" for ModelPicker to fill) so the
                    // picker shows a real selection even when the model catalog is already cached.
                    reviewerKey = workerKey.isEmpty ? "" : workerKey
                } label: {
                    HStack(spacing: 5) {
                        Icon(name: "cpu", size: 13)
                        Text("Pick a model").font(TokFont.text(TokFont.footnote, .semibold))
                    }
                    .foregroundStyle(Tok.inkSecondary).padding(.horizontal, 11).frame(height: 28)
                    .background(Tok.fillSecondary).clipShape(RoundedRectangle(cornerRadius: 8))
                }.buttonStyle(.plain)
            } else {
                ModelPicker(value: $reviewerKey, compact: true)
            }
        }
    }

    private func engineRow(_ name: String, _ s: EngineStatus?, last: Bool) -> some View {
        GLRow(last: last) {
            Text(name).font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
            Spacer()
            if let s {
                HStack(spacing: 6) {
                    Circle().fill(s.available == true ? Tok.green : Tok.red).frame(width: 7, height: 7)
                    Text(s.available == true ? "Ready" : (s.reason?.isEmpty == false ? s.reason! : "Not signed in"))
                        .font(TokFont.text(TokFont.footnote)).foregroundStyle(s.available == true ? Tok.green : Tok.red)
                }
            } else { Text("…").foregroundStyle(Tok.inkTertiary) }
        }
    }

    private func setRouting(_ key: String, _ val: String) {
        routing[key] = val
        Task { try? await env.client.callVoid("setRouting", [key: val]) }
    }
}

// MARK: - Devices
struct DevicesPane: View {
    @Environment(AppEnv.self) private var env
    @State private var status = AccountStatus(signedIn: false, deviceId: nil, serverUrl: nil, devices: [])
    @State private var email = ""
    @State private var password = ""
    @State private var name = ""
    @State private var register = false
    @State private var busy = false
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            PaneHead(title: "Devices", sub: "Sign in once, then use phones and web as remotes for this Mac.")
            if status.signedIn {
                signedInView
            } else {
                signInView
            }
        }
        .task { await refresh() }
    }

    private var signedInView: some View {
        let hosts = (status.devices ?? []).filter { $0.role == "host" }
        let remotes = (status.devices ?? []).filter { $0.role != "host" }
        let thisMac = hosts.first { $0.id == status.deviceId } ?? hosts.first
        return VStack(alignment: .leading, spacing: 20) {
            deviceOverview(signedIn: true, thisMac: thisMac, remoteCount: remotes.count)
            HStack(spacing: 10) {
                PillButton(title: loading ? "Refreshing..." : "Refresh", icon: "refresh", kind: .quiet, busy: loading) { Task { await refresh() } }
                PillButton(title: "Sign out", kind: .plain) { Task { await signOut() } }
                Spacer()
            }
            GroupedList(header: "This Mac", footer: status.serverUrl.map { "Account server: \($0)" }) {
                GLRow(last: true) {
                    let online = thisMac?.online == true
                    Icon(name: "cpu", size: 18).foregroundStyle(online ? Tok.green : Tok.red)
                        .frame(width: 36, height: 36).background((online ? Tok.green : Tok.red).opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: 9))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(thisMac?.name ?? Host.current().localizedName ?? "This Mac").font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                        Text(online ? "macOS · host · online on mobile" : "macOS · host · offline on mobile")
                            .font(TokFont.text(TokFont.caption)).foregroundStyle(online ? Tok.green : Tok.red)
                        if let id = status.deviceId {
                            Text(id).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    Spacer()
                }
            }
            GroupedList(header: "Your remotes") {
                if remotes.isEmpty {
                    emptyRemoteRow
                } else {
                    ForEach(Array(remotes.enumerated()), id: \.element.id) { i, d in
                        GLRow(last: i == remotes.count - 1) {
                            Icon(name: "smartphone", size: 18).foregroundStyle(d.online ? Tok.teal : Tok.inkTertiary)
                                .frame(width: 36, height: 36).background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 9))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(d.name ?? "Remote").font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                                Text(d.online ? "online now" : "last seen \(RelTime.ago(d.lastSeen))").font(TokFont.text(TokFont.caption)).foregroundStyle(d.online ? Tok.green : Tok.inkTertiary)
                            }
                            Spacer()
                        }
                    }
                }
            }
        }
    }

    private var signInView: some View {
        VStack(alignment: .leading, spacing: 20) {
            deviceOverview(signedIn: false, thisMac: nil, remoteCount: 0)
            HStack(alignment: .top, spacing: 18) {
                authPanel
                    .frame(minWidth: 420, maxWidth: 520, alignment: .leading)
                connectionPanel
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var authPanel: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(register ? "Create account" : "Sign in")
                        .font(TokFont.text(TokFont.headline, .bold)).foregroundStyle(Tok.ink)
                    Text(register ? "Start with an email and password." : "Use the same account on every remote.")
                        .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
                }
                Spacer()
                serverChip
            }

            VStack(spacing: 12) {
                if register {
                    authField(label: "Name") {
                        TextField("Your name", text: $name)
                            .textFieldStyle(.plain).font(TokFont.text(TokFont.footnote)).inputBox()
                            .onSubmit { Task { await submitAuth() } }
                    }
                }
                authField(label: "Email") {
                    TextField("you@example.com", text: $email)
                        .textFieldStyle(.plain).font(TokFont.text(TokFont.footnote)).inputBox()
                        .onSubmit { Task { await submitAuth() } }
                }
                authField(label: "Password") {
                    SecureField("Password", text: $password)
                        .textFieldStyle(.plain).font(TokFont.text(TokFont.footnote)).inputBox()
                        .onSubmit { Task { await submitAuth() } }
                }
            }

            if let error {
                HStack(alignment: .top, spacing: 9) {
                    Icon(name: "alert", size: 14).foregroundStyle(Tok.red).padding(.top, 1)
                    Text(error).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.red).fixedSize(horizontal: false, vertical: true)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Tok.red.opacity(0.1), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            HStack(spacing: 10) {
                PillButton(title: busy ? "Connecting..." : (register ? "Create account" : "Sign in"), icon: "enter", kind: .primary, disabled: !canSubmit, busy: busy) {
                    Task { await submitAuth() }
                }
                Button(register ? "Have an account?" : "Create account") {
                    register.toggle()
                    error = nil
                }
                .buttonStyle(.plain)
                .font(TokFont.text(TokFont.subhead, .semibold))
                .foregroundStyle(Tok.blue)
                Spacer(minLength: 0)
            }
        }
        .padding(18)
        .background(Tok.bgGrouped, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private var connectionPanel: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("After sign-in").font(TokFont.text(TokFont.callout, .bold)).foregroundStyle(Tok.ink)
            connectionRow(icon: "cpu", tint: Tok.blue, title: "This Mac becomes the host", detail: "Remote devices can see when this machine is online.")
            connectionRow(icon: "smartphone", tint: Tok.teal, title: "Mobile and web become remotes", detail: "Sign in there with this same account.")
            connectionRow(icon: "shield", tint: Tok.green, title: "Account session is stored locally", detail: "Signing out removes the local device session.")
        }
        .padding(18)
        .background(Tok.fillSecondary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private func deviceOverview(signedIn: Bool, thisMac: AccountDevice?, remoteCount: Int) -> some View {
        HStack(alignment: .center, spacing: 16) {
            Icon(name: signedIn ? "checkCircle" : "smartphone", size: 26, weight: .semibold)
                .foregroundStyle(signedIn ? Tok.green : Tok.teal)
                .frame(width: 54, height: 54)
                .background((signedIn ? Tok.green : Tok.teal).opacity(0.14), in: RoundedRectangle(cornerRadius: 13, style: .continuous))
            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 8) {
                    statusChip(title: signedIn ? "Signed in" : "Not signed in", tint: signedIn ? Tok.green : Tok.orange)
                    serverChip
                }
                Text(signedIn ? "This Mac is ready for remote devices." : "Connect this Mac to your Maestro account.")
                    .font(TokFont.text(TokFont.headline, .bold)).foregroundStyle(Tok.ink)
                Text(signedIn ? "\(thisMac?.name ?? Host.current().localizedName ?? "This Mac") · \(remoteCount) remote\(remoteCount == 1 ? "" : "s")" : "Use one account to make this machine available from phone and web.")
                    .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
            }
            Spacer(minLength: 0)
        }
        .padding(18)
        .background(Tok.bgElevated, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private var emptyRemoteRow: some View {
        HStack(spacing: 12) {
            Icon(name: "smartphone", size: 18).foregroundStyle(Tok.inkTertiary)
                .frame(width: 36, height: 36).background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 2) {
                Text("No remotes yet").font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                Text("Open the mobile or web app and sign in with this account.")
                    .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
            }
            Spacer()
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var serverChip: some View {
        statusChip(title: status.serverUrl ?? "Account server", tint: Tok.blue)
    }

    private var canSubmit: Bool {
        !busy && !email.trimmed.isEmpty && !password.isEmpty && (!register || !name.trimmed.isEmpty)
    }

    private func authField<Content: View>(label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.inkSecondary)
            content()
        }
    }

    private func connectionRow(icon: String, tint: Color, title: String, detail: String) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Icon(name: icon, size: 16).foregroundStyle(tint)
                .frame(width: 32, height: 32)
                .background(tint.opacity(0.14), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink)
                Text(detail).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
    }

    private func statusChip(title: String, tint: Color) -> some View {
        HStack(spacing: 5) {
            Circle().fill(tint).frame(width: 6, height: 6)
            Text(title).font(TokFont.text(TokFont.caption, .semibold)).lineLimit(1)
        }
        .foregroundStyle(tint)
        .padding(.horizontal, 8).frame(height: 24)
        .background(tint.opacity(0.12), in: Capsule())
    }

    private func refresh() async {
        loading = true; defer { loading = false }
        do { status = try await env.client.call("accountStatus", as: AccountStatus.self); error = nil }
        catch { self.error = readable(error) }
    }

    private func submitAuth() async {
        guard canSubmit else { return }
        busy = true; defer { busy = false }
        do {
            let method = register ? "accountSignUp" : "accountSignIn"
            let payload: [String: String] = ["name": name.trimmed, "email": email.trimmed, "password": password]
            status = try await env.client.call(method, payload, as: AccountStatus.self)
            password = ""; error = nil
            await refresh()
        } catch { self.error = readable(error) }
    }

    private func signOut() async {
        busy = true; defer { busy = false }
        do { status = try await env.client.call("accountSignOut", as: AccountStatus.self); error = nil }
        catch { self.error = readable(error) }
    }

    private func readable(_ error: Error) -> String {
        if let e = error as? LocalizedError, let description = e.errorDescription { return description }
        return error.localizedDescription
    }
}

enum RelTime {
    static func ago(_ ms: Double?) -> String {
        guard let ms, ms > 0 else { return "a while ago" }
        let secs = Int(Date().timeIntervalSince1970 - ms / 1000)
        if secs < 60 { return "\(max(secs, 1))s ago" }
        if secs < 3600 { return "\(secs / 60)m ago" }
        if secs < 86400 { return "\(secs / 3600)h ago" }
        return "\(secs / 86400)d ago"
    }
}
