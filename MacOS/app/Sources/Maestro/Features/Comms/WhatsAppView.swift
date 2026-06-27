import SwiftUI
import AppKit

/// WhatsApp-app-style two-pane messenger: 360px chat list + the conversation. All data Mac-local.
struct WhatsAppView: View {
    @Environment(AppEnv.self) private var env
    @State private var store: WhatsAppStore?
    @State private var search = ""
    @State private var draft = ""

    var body: some View {
        Group {
            if let store {
                if !store.connected {
                    notLinked
                } else {
                    HStack(spacing: 0) {
                        chatList(store)
                        Tok.separator.frame(width: Tok.hairline)
                        conversation(store)
                    }
                }
            } else {
                Spinner(size: 20).tint(Tok.inkTertiary).frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task {
            if store == nil { let s = WhatsAppStore(client: env.client); store = s; await s.start() }
        }
        .onDisappear { store?.stop() }
    }

    private var notLinked: some View {
        VStack(spacing: 14) {
            Icon(name: "whatsapp", size: 32).foregroundStyle(Tok.green)
                .frame(width: 64, height: 64).background(Tok.green.opacity(0.16))
                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            Text("WhatsApp isn't linked yet").font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
            Text("Link your number in Comms, then your chats appear here.")
                .font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary)
            Button { env.route = .comms } label: {
                Text("Go to Comms").font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(.white)
                    .padding(.horizontal, 18).frame(height: 40).background(Tok.green).clipShape(RoundedRectangle(cornerRadius: 11))
            }.buttonStyle(.plain)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: chat list
    private func chatList(_ store: WhatsAppStore) -> some View {
        let filtered = store.sortedChats.filter { search.isEmpty || $0.name.localizedCaseInsensitiveContains(search) }
        return VStack(spacing: 0) {
            VStack(spacing: 12) {
                HStack(spacing: 8) {
                    Icon(name: "whatsapp", size: 18).foregroundStyle(Tok.green)
                        .frame(width: 30, height: 30).background(Tok.green.opacity(0.16)).clipShape(RoundedRectangle(cornerRadius: 9))
                    Text("WhatsApp").font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
                    Spacer()
                }
                HStack(spacing: 8) {
                    Icon(name: "search", size: 15).foregroundStyle(Tok.inkTertiary)
                    TextField("Search chats", text: $search).textFieldStyle(.plain).font(TokFont.text(TokFont.footnote))
                }
                .padding(.horizontal, 12).frame(height: 36).background(Tok.bgElevated).clipShape(Capsule())
                .overlay(Capsule().strokeBorder(Tok.separator, lineWidth: Tok.hairline))
            }
            .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 10)

            if store.loadingChats {
                Spinner(size: 18).tint(Tok.inkTertiary).frame(maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(filtered) { chat in
                            chatRow(store, chat)
                            Tok.separator.frame(height: Tok.hairline).padding(.leading, 74).opacity(0.5)
                        }
                    }
                }
            }
        }
        .frame(width: 360).background(Tok.bg)
    }

    private func chatRow(_ store: WhatsAppStore, _ chat: WaChat) -> some View {
        Button { Task { await store.select(chat.chatId) } } label: {
            HStack(spacing: 12) {
                WaAvatar(chat: chat, url: store.avatarURL(chat), size: 46)
                VStack(alignment: .leading, spacing: 3) {
                    HStack {
                        Text(chat.name + ((chat.pinned ?? false) ? "  📌" : "")).font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink).lineLimit(1)
                        Spacer()
                        Text(WaFmt.listTime(chat.lastMessageAt)).font(TokFont.text(TokFont.caption))
                            .foregroundStyle((chat.unreadCount ?? 0) > 0 ? Tok.green : Tok.inkTertiary)
                    }
                    HStack(spacing: 6) {
                        Text((chat.lastMessageFromMe == true ? "You: " : "") + (chat.lastMessageText ?? ""))
                            .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).lineLimit(1)
                        Spacer()
                        if let n = chat.unreadCount, n > 0 {
                            Text(n > 99 ? "99+" : "\(n)").font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(.white)
                                .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18).background(Tok.green).clipShape(Capsule())
                        }
                    }
                }
            }
            .padding(.horizontal, 16).padding(.vertical, 10)
            .background(store.selectedId == chat.chatId ? Tok.fillSecondary : .clear)
            .contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    // MARK: conversation
    @ViewBuilder private func conversation(_ store: WhatsAppStore) -> some View {
        if let chat = store.selected {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    WaAvatar(chat: chat, url: store.avatarURL(chat), size: 40)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(chat.name).font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink).lineLimit(1)
                        Text(chat.kind == "group" ? "Group" : (chat.kind == "channel" ? "Channel" : chatSubtitle(chat)))
                            .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                    }
                    Spacer()
                }
                .padding(.horizontal, 18).padding(.vertical, 12).background(Tok.bgElevated)
                .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }

                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 2) {
                            if store.hasMore {
                                Button("Load earlier messages") { Task { await store.loadEarlier() } }
                                    .buttonStyle(.plain).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.inkSecondary)
                                    .padding(.horizontal, 14).frame(height: 30).background(Tok.bgElevated).clipShape(Capsule())
                                    .overlay(Capsule().strokeBorder(Tok.separator, lineWidth: Tok.hairline)).padding(.bottom, 8)
                            }
                            ForEach(Array(store.messages.enumerated()), id: \.element.id) { i, m in
                                if daySeparator(store.messages, i) { daySeparatorView(m.ts) }
                                WaBubble(message: m, isGroup: chat.kind == "group", onReact: { emoji in Task { await store.react(m, emoji) } })
                            }
                            Color.clear.frame(height: 1).id("wa-bottom")
                        }
                        .padding(.horizontal, 18).padding(.vertical, 14)
                    }
                    .background(Tok.bgGrouped)
                    .onChange(of: store.messages.count) { proxy.scrollTo("wa-bottom", anchor: .bottom) }
                }

                composer(store)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 8) {
                Icon(name: "chat", size: 28).foregroundStyle(Tok.inkTertiary)
                Text("Select a chat").font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
                Text("Pick a conversation on the left to read and reply.").font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity).background(Tok.bgGrouped)
        }
    }

    private func composer(_ store: WhatsAppStore) -> some View {
        HStack(alignment: .bottom, spacing: 8) {
            Button {
                let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.allowsMultipleSelection = false
                if panel.runModal() == .OK, let url = panel.url { Task { await store.sendMedia(url) } }
            } label: {
                Icon(name: "paperclip", size: 18).foregroundStyle(Tok.inkSecondary)
                    .frame(width: 38, height: 38).background(Tok.fillSecondary).clipShape(Circle())
            }.buttonStyle(.plain)
            TextField("Type a message", text: $draft, axis: .vertical)
                .textFieldStyle(.plain).font(TokFont.text(14)).lineLimit(1...6)
                .padding(.horizontal, 14).padding(.vertical, 9).background(Tok.bg)
                .clipShape(RoundedRectangle(cornerRadius: 19, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 19).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
                .onSubmit { sendDraft(store) }
            Button { sendDraft(store) } label: {
                Icon(name: "send", size: 16).foregroundStyle(draft.trimmed.isEmpty ? Tok.inkTertiary : .white)
                    .frame(width: 38, height: 38).background(draft.trimmed.isEmpty ? Tok.fillSecondary : Tok.green).clipShape(Circle())
            }.buttonStyle(.plain).disabled(draft.trimmed.isEmpty)
        }
        .padding(.horizontal, 16).padding(.vertical, 10).background(Tok.bgElevated)
        .overlay(alignment: .top) { Tok.separator.frame(height: Tok.hairline) }
    }

    private func sendDraft(_ store: WhatsAppStore) {
        let t = draft.trimmed; guard !t.isEmpty else { return }
        draft = ""
        Task { await store.send(t) }
    }

    private func chatSubtitle(_ chat: WaChat) -> String { String(chat.chatId.split(separator: "@").first ?? "") }
    private func daySeparator(_ msgs: [WaMessage], _ i: Int) -> Bool {
        guard i > 0 else { return true }
        return !Calendar.current.isDate(WaFmt.date(msgs[i].ts), inSameDayAs: WaFmt.date(msgs[i - 1].ts))
    }
    private func daySeparatorView(_ ts: Double) -> some View {
        Text(WaFmt.daySeparator(ts)).font(TokFont.text(TokFont.caption, .medium)).foregroundStyle(Tok.inkSecondary)
            .padding(.horizontal, 12).padding(.vertical, 4).background(Tok.bgElevated).clipShape(Capsule())
            .overlay(Capsule().strokeBorder(Tok.separator, lineWidth: Tok.hairline)).padding(.vertical, 8)
    }
}

// MARK: - Avatar
struct WaAvatar: View {
    let chat: WaChat
    let url: URL?
    var size: CGFloat = 46
    private var tint: Color { chat.kind == "group" ? Tok.blue : (chat.kind == "channel" ? Tok.purple : Tok.green) }
    var body: some View {
        ZStack {
            Circle().fill(tint.opacity(0.18))
            if let url {
                AsyncImage(url: url) { img in img.resizable().scaledToFill() } placeholder: { initials }
                    .frame(width: size, height: size).clipShape(Circle())
            } else { initials }
        }
        .frame(width: size, height: size)
    }
    private var initials: some View {
        Text(WaFmt.initials(chat.name)).font(.system(size: size * 0.36, weight: .semibold)).foregroundStyle(tint)
    }
}

// MARK: - Formatting helpers
enum WaFmt {
    static func date(_ ms: Double) -> Date { Date(timeIntervalSince1970: ms / 1000) }
    static func initials(_ name: String) -> String {
        let parts = name.split(separator: " ").prefix(2).compactMap { $0.first }
        return parts.isEmpty ? "?" : String(parts).uppercased()
    }
    static func listTime(_ ms: Double?) -> String {
        guard let ms, ms > 0 else { return "" }
        let d = date(ms), cal = Calendar.current
        if cal.isDateInToday(d) { return d.formatted(.dateTime.hour().minute()) }
        if cal.isDateInYesterday(d) { return "Yesterday" }
        return d.formatted(.dateTime.month(.abbreviated).day())
    }
    static func msgTime(_ ms: Double) -> String { date(ms).formatted(.dateTime.hour().minute()) }
    static func daySeparator(_ ms: Double) -> String {
        let d = date(ms), cal = Calendar.current
        if cal.isDateInToday(d) { return "Today" }
        if cal.isDateInYesterday(d) { return "Yesterday" }
        return d.formatted(.dateTime.weekday(.wide).month(.abbreviated).day())
    }
}
