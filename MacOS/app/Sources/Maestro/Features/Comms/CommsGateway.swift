import SwiftUI
import AppKit

/// The Comms gateway: connect Telegram + WhatsApp, manage chat bindings, and view activity.
struct CommsGateway: View {
    @Environment(AppEnv.self) private var env
    @State private var store: CommsStore?
    @State private var tab: Tab = .channels
    @State private var tgToken = ""
    @State private var recipient = ""
    @State private var recipientSaved = false
    @State private var waPhone = ""
    @State private var bindTarget: PendingChat?

    enum Tab: String, CaseIterable { case channels = "Channels", bindings = "Bindings", activity = "Activity" }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("Comms").font(TokFont.display(TokFont.largeTitle, .bold)).foregroundStyle(Tok.ink)
                Text("Drive Maestro from Telegram, and let WhatsApp chats summarize themselves to your number when they go quiet — all on this Mac.")
                    .font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary).padding(.top, 4).padding(.bottom, 20)

                SegmentedControl(options: Tab.allCases.map { ($0, tabLabel($0), nil) },
                                 value: Binding(get: { tab }, set: { tab = $0 }), segWidth: 116)
                    .fixedSize().padding(.bottom, 22)

                if let store {
                    switch tab {
                    case .channels: channels(store)
                    case .bindings: bindingsTab(store)
                    case .activity: activityTab(store)
                    }
                } else { Spinner(size: 18).tint(Tok.inkTertiary).frame(maxWidth: .infinity).padding(40) }
            }
            .padding(.horizontal, 28).padding(.top, 24).padding(.bottom, 36)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task { if store == nil { let s = CommsStore(client: env.client); store = s; await s.start(); recipient = digits(s.wa?.notifyJid) } }
        .onDisappear { store?.stop() }
        .sheet(item: $bindTarget) { chat in if let store { BindSheet(store: store, chat: chat) } }
    }

    private func tabLabel(_ t: Tab) -> String {
        if t == .bindings, let n = store?.pending.count, n > 0 { return "Bindings · \(n)" }
        return t.rawValue
    }

    // MARK: channels
    private func channels(_ store: CommsStore) -> some View {
        VStack(spacing: 16) {
            telegramCard(store)
            whatsappCard(store)
        }.frame(maxWidth: 720)
    }

    private func telegramCard(_ store: CommsStore) -> some View {
        let tg = store.status?.telegram
        return card {
            cardHeader(icon: "send", tint: Tok.blue, title: "Telegram",
                       subtitle: tg?.connected == true ? "Connected as @\(tg?.botUsername ?? "") · \(tg?.messagesToday ?? 0) msg today" : "Run jobs and approve gates from a Telegram chat.",
                       live: tg?.connected == true)
            if tg?.connected == true {
                HStack {
                    Text("\(tg?.bindings ?? 0) bound · \(tg?.pending ?? 0) pending").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                    Spacer()
                    Button("Disconnect") { Task { await store.disconnectTelegram() } }.buttonStyle(.plain)
                        .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.red)
                        .padding(.horizontal, 14).frame(height: 36).overlay(Capsule().strokeBorder(Tok.separator, lineWidth: Tok.hairline))
                }
            } else {
                HStack(spacing: 10) {
                    SecureField("Bot token from @BotFather", text: $tgToken)
                        .textFieldStyle(.plain).font(TokFont.mono(TokFont.footnote)).inputBox()
                    PillButton(title: "Connect", disabled: tgToken.trimmed.isEmpty, busy: store.busy) { Task { await store.connectTelegram(tgToken.trimmed) } }
                }
                if let e = store.error { Text(e).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.red) }
            }
        }
    }

    private func whatsappCard(_ store: CommsStore) -> some View {
        let w = store.status?.whatsapp
        return card {
            cardHeader(icon: "whatsapp", tint: Tok.green, title: "WhatsApp",
                       subtitle: w?.connected == true ? "Linked as \(w?.name ?? "") · \(w?.tracked ?? 0) tracked chat(s)" : "Link your number to chat and summarize quiet chats.",
                       live: w?.connected == true)
            if w?.connected == true {
                if store.wa?.sendApproved == false {
                    HStack(spacing: 10) {
                        Icon(name: "shield", size: 18).foregroundStyle(Tok.orange)
                        Text(approvalText(store)).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.ink)
                        Spacer()
                        Button("Allow") { Task { await store.approveSend() } }.buttonStyle(.plain)
                            .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(.white).padding(.horizontal, 14).frame(height: 34).background(Tok.green).clipShape(Capsule())
                    }
                    .padding(12).background(Tok.orange.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius: 12))
                }
                recipientSection(store)
                agentSendCard(store)
                HStack(alignment: .center, spacing: 12) {
                    Text("Open the WhatsApp space to read and reply to every chat. Assign chats to a project under Bindings; a chat that goes quiet for 15 min is summarized to you.")
                        .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    actionPill("Open WhatsApp", bg: Tok.green, fg: .white) { env.route = .whatsapp }
                    actionPill("Pause", bordered: true) { Task { await store.disconnectWhatsApp() } }
                    actionPill("Unlink", fg: Tok.red, bordered: true) { Task { await store.unlinkWhatsApp() } }
                }
            } else if store.linking {
                VStack(spacing: 10) {
                    if let code = store.pairingCode {
                        Text("Pairing code").font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                        Text(code).font(.system(size: TokFont.title2, weight: .semibold, design: .monospaced)).tracking(3).foregroundStyle(Tok.ink)
                        Text("Enter it in WhatsApp → Linked Devices → Link with phone number.")
                            .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).multilineTextAlignment(.center)
                    } else if let img = qrImage(store.qrImageData) {
                        Image(nsImage: img).resizable().interpolation(.none).frame(width: 180, height: 180)
                            .padding(8).background(.white).clipShape(RoundedRectangle(cornerRadius: 12))
                        Text("Scan to link your number").font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                        VStack(alignment: .leading, spacing: 3) {
                            qrStep(1, "Open WhatsApp on your phone")
                            qrStep(2, "Settings → Linked Devices → Link a Device")
                            qrStep(3, "Point it at this code")
                        }
                    } else {
                        Spinner(size: 20).tint(Tok.green); Text("Starting…").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                    }
                    Button("Cancel") { Task { await store.cancelLink() } }.buttonStyle(.plain).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.inkSecondary)
                }.frame(maxWidth: .infinity)
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .top, spacing: 10) {
                        Icon(name: "alert", size: 16).foregroundStyle(Tok.red).padding(.top, 1)
                        Text("This links your **personal** number via an unofficial connection. WhatsApp may ban numbers that automate — this is your own informed choice. Your chats are read and stored only on this Mac (never sent to the relay).")
                            .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.ink).fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Tok.red.opacity(0.09)).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    HStack(spacing: 8) {
                        TextField("Phone for a pairing code (optional)", text: $waPhone).textFieldStyle(.plain).font(TokFont.mono(TokFont.footnote)).inputBox()
                        PillButton(title: (store.wa?.linkedAt != nil) ? "Re-link number" : "Link your number", kind: .primary) {
                            Task { await store.linkWhatsApp(phone: waPhone.trimmed.isEmpty ? nil : waPhone.trimmed) }
                        }
                    }
                }
            }
        }
    }

    /// "Your number — where summaries & confirmations go" — the personal-number recipient field.
    private func recipientSection(_ store: CommsStore) -> some View {
        let pa = digits(store.wa?.jid)
        let typed = digits(recipient)
        return VStack(alignment: .leading, spacing: 8) {
            Text("Your number — where summaries & confirmations go").font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
            Text(Self.recipientHelp(pa))
                .font(TokFont.text(TokFont.caption)).lineSpacing(2).fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                TextField("e.g. 8801604123482", text: $recipient).textFieldStyle(.plain).font(TokFont.mono(TokFont.footnote)).inputBox()
                    .onSubmit { saveRecipient(store) }
                Button { saveRecipient(store) } label: {
                    Text(recipientSaved ? "Saved ✓" : "Save").font(TokFont.text(TokFont.footnote, .semibold))
                        .foregroundStyle(.white).padding(.horizontal, 16).frame(height: 38)
                        .background(Tok.green).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }.buttonStyle(.plain)
            }
            if !typed.isEmpty { Text("Will message: +\(typed)").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary) }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(Tok.bgGrouped).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    /// The recipient help line as a markdown AttributedString (bold parts in `--ink`, rest secondary).
    private static func recipientHelp(_ pa: String) -> AttributedString {
        let md = "The linked account above is your “PA” number\(pa.isEmpty ? "" : " (\(pa))"). Enter the **personal** number you want to receive on — full international format, **country code, no “+” and no leading 0**. Leave blank to use the linked number."
        var a = (try? AttributedString(markdown: md)) ?? AttributedString(md)
        a.foregroundColor = Tok.inkSecondary
        for run in a.runs where run.inlinePresentationIntent?.contains(.stronglyEmphasized) == true {
            a[run.range].foregroundColor = Tok.ink
        }
        return a
    }

    private func saveRecipient(_ store: CommsStore) {
        Task { await store.setRecipient(recipient.trimmed); recipientSaved = true; try? await Task.sleep(for: .seconds(1.5)); recipientSaved = false }
    }

    /// "Let the agent message contacts" card row.
    private func agentSendCard(_ store: CommsStore) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text("Let the agent message contacts").font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                Text("The agent can always message your own number. Turn this on to let it message other people too.")
                    .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary)
            }
            Spacer(minLength: 8)
            Toggle("", isOn: Binding(get: { store.wa?.agentSendToOthers ?? false }, set: { v in Task { await store.setAgentSend(v) } }))
                .labelsHidden().toggleStyle(.switch).tint(Tok.green)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(Tok.bgGrouped).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private func actionPill(_ title: String, bg: Color = .clear, fg: Color = Tok.ink, bordered: Bool = false, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(fg)
                .padding(.horizontal, 16).frame(height: 38).background(bg).clipShape(Capsule())
                .overlay { if bordered { Capsule().strokeBorder(Tok.separator, lineWidth: Tok.hairline) } }
        }.buttonStyle(.plain)
    }

    private func approvalText(_ store: CommsStore) -> String {
        let base = "Before Maestro messages summaries to your own number, it needs your OK."
        let n = store.wa?.pendingSummaries?.count ?? 0
        return n > 0 ? base + " \(n) waiting." : base
    }

    private func qrStep(_ n: Int, _ text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Text("\(n).").font(TokFont.mono(TokFont.caption, .semibold)).foregroundStyle(Tok.inkTertiary)
            Text(text).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary)
        }
    }

    // MARK: bindings
    private func bindingsTab(_ store: CommsStore) -> some View {
        VStack(alignment: .leading, spacing: 22) {
            section("PENDING · \(store.pending.count)") {
                if store.pending.isEmpty { emptyHint("No pending chats. Message your bot or a tracked WhatsApp chat to see it here.") }
                else { ForEach(store.pending) { p in pendingRow(store, p) } }
            }
            section("BOUND CHATS · \(store.bindings.count)") {
                if store.bindings.isEmpty { emptyHint("No bound chats yet.") }
                else { ForEach(store.bindings) { b in boundRow(store, b) } }
            }
        }.frame(maxWidth: 760)
    }

    private func pendingRow(_ store: CommsStore, _ p: PendingChat) -> some View {
        rowCard {
            providerTile(p.provider)
            VStack(alignment: .leading, spacing: 1) {
                Text(p.name).font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                if let f = p.firstText, !f.isEmpty { Text("“\(f)”").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1) }
            }
            Spacer()
            Button(p.provider == "whatsapp" ? "Track" : "Bind") { bindTarget = p }.buttonStyle(.plain)
                .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(.white)
                .padding(.horizontal, 14).frame(height: 32).background(p.provider == "whatsapp" ? Tok.green : Tok.blue).clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private func boundRow(_ store: CommsStore, _ b: ChatBinding) -> some View {
        rowCard {
            providerTile(b.provider ?? (b.chatId.contains("@") ? "whatsapp" : "telegram"))
            VStack(alignment: .leading, spacing: 1) {
                Text(b.name).font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
                Text(projectName(store, b.projectId)).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
            }
            Spacer()
            Button("Unbind") { Task { await store.unbind(b.chatId) } }.buttonStyle(.plain)
                .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.red)
        }
    }

    // MARK: activity
    private func activityTab(_ store: CommsStore) -> some View {
        VStack(spacing: 0) {
            if store.events.isEmpty { emptyHint("No messages yet. Activity in and out of your bot shows here.").padding(.vertical, 30) }
            else {
                ForEach(store.events) { e in
                    HStack(spacing: 12) {
                        Icon(name: e.dir == "in" ? "enter" : "send", size: 14).foregroundStyle(e.dir == "in" ? Tok.blue : Tok.green)
                            .frame(width: 28, height: 28).background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 8))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(e.payload).font(TokFont.text(TokFont.footnote, .medium)).foregroundStyle(Tok.ink).lineLimit(1)
                            Text("\(e.chatName) · \(e.status)").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                        }
                        Spacer()
                        Text(WaFmt.msgTime(e.at ?? 0)).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                    }
                    .padding(.horizontal, 16).padding(.vertical, 12)
                    .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }
                }
            }
        }
        .frame(maxWidth: 760).background(Tok.bgGrouped).clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    // MARK: helpers
    private func card<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 14) { content() }
            .padding(22).frame(maxWidth: .infinity, alignment: .leading)
            .background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Tok.separator, lineWidth: Tok.hairline)).cardShadow()
    }
    private func cardHeader(icon: String, tint: Color, title: String, subtitle: String, live: Bool) -> some View {
        HStack(spacing: 14) {
            Icon(name: icon, size: 22).foregroundStyle(tint).frame(width: 44, height: 44).background(tint.opacity(0.16)).clipShape(RoundedRectangle(cornerRadius: 12))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
                Text(subtitle).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
            }
            Spacer()
            if live { HStack(spacing: 6) { Circle().fill(Tok.green).frame(width: 7, height: 7); Text("Live").font(TokFont.text(TokFont.caption, .semibold)) }
                .foregroundStyle(Tok.green).padding(.horizontal, 11).frame(height: 26).background(Tok.green.opacity(0.14)).clipShape(Capsule()) }
        }
    }
    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(TokFont.text(TokFont.footnote, .bold)).tracking(0.5).foregroundStyle(Tok.inkSecondary)
            content()
        }
    }
    private func rowCard<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        HStack(spacing: 12) { content() }
            .padding(12).background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }
    private func providerTile(_ provider: String) -> some View {
        let tint = provider == "whatsapp" ? Tok.green : Tok.blue
        return Icon(name: provider == "whatsapp" ? "whatsapp" : "send", size: 16).foregroundStyle(tint)
            .frame(width: 34, height: 34).background(tint.opacity(0.14)).clipShape(RoundedRectangle(cornerRadius: 9))
    }
    private func emptyHint(_ t: String) -> some View {
        Text(t).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary).frame(maxWidth: .infinity, alignment: .leading)
    }
    private func projectName(_ store: CommsStore, _ id: String?) -> String {
        guard let id else { return "Unassigned" }
        return store.projects.first { $0.id == id }?.name ?? "Project"
    }
    private func digits(_ jid: String?) -> String { (jid ?? "").filter(\.isNumber) }
    private func qrImage(_ dataUrl: String?) -> NSImage? {
        guard let dataUrl, let comma = dataUrl.firstIndex(of: ","), let data = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...])) else { return nil }
        return NSImage(data: data)
    }
}

/// Assign a pending chat to a project (+ session for WhatsApp).
struct BindSheet: View {
    @Environment(\.dismiss) private var dismiss
    let store: CommsStore
    let chat: PendingChat
    @State private var projectId: String?
    @State private var sessionId: String?
    @State private var sessions: [ChatSession] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text((chat.provider == "whatsapp" ? "Track " : "Bind ") + "“\(chat.name)”")
                .font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
            picker("Project", selection: Binding(get: { projectId }, set: { projectId = $0; sessionId = nil; if let p = $0 { Task { sessions = await store.sessions(for: p) } } }),
                   options: store.projects.map { ($0.id, $0.name) })
            if chat.provider == "whatsapp" {
                picker("Session", selection: $sessionId, options: sessions.map { ($0.id, $0.displayTitle) }, disabled: projectId == nil)
            }
            HStack {
                Spacer()
                PillButton(title: "Cancel", kind: .plain) { dismiss() }
                PillButton(title: chat.provider == "whatsapp" ? "Track chat" : "Bind chat") {
                    Task { await store.bind(chat, projectId: projectId, sessionId: sessionId); dismiss() }
                }
            }
        }
        .padding(22).frame(width: 440).background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func picker(_ label: String, selection: Binding<String?>, options: [(String, String)], disabled: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.inkSecondary)
            Menu {
                Button("Default project") { selection.wrappedValue = nil }
                ForEach(options, id: \.0) { opt in Button(opt.1) { selection.wrappedValue = opt.0 } }
            } label: {
                HStack {
                    Text(options.first { $0.0 == selection.wrappedValue }?.1 ?? "First project").font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.ink)
                    Spacer(); Icon(name: "chevronDown", size: 13).foregroundStyle(Tok.inkTertiary)
                }.padding(.horizontal, 12).frame(height: 40).background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 10))
            }.menuStyle(.borderlessButton).disabled(disabled).opacity(disabled ? 0.5 : 1)
        }
    }
}
