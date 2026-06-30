import SwiftUI
import Observation

/// All WhatsApp data is Mac-local (the relay never sees it). Chats + the open conversation, kept
/// live via the wa-message / wa-chats / wa-message-update event streams.
@Observable
@MainActor
final class WhatsAppStore {
    var connected = false
    var chats: [WaChat] = []
    var loadingChats = true
    var selectedId: String?
    var messages: [WaMessage] = []
    var loadingMessages = false
    var hasMore = false
    var avatars: [String: String] = [:]

    private let client: MaestroClient
    private var tokens: [Int] = []
    init(client: MaestroClient) { self.client = client }

    var selected: WaChat? { chats.first { $0.chatId == selectedId } }

    var sortedChats: [WaChat] {
        chats.sorted {
            if ($0.pinned ?? false) != ($1.pinned ?? false) { return ($0.pinned ?? false) }
            return ($0.lastMessageAt ?? 0) > ($1.lastMessageAt ?? 0)
        }
    }

    func start() async {
        if tokens.isEmpty {
            tokens.append(client.onEvent { [weak self] ev in
                Task { @MainActor in self?.handle(ev) }
            })
        }
        await loadStatus()
        if connected { await loadChats() } else { loadingChats = false }
    }
    func stop() { for t in tokens { client.removeHandler(t) }; tokens = [] }

    private func handle(_ ev: MaestroEvent) {
        switch ev.name {
        case "wa-chats": Task { await loadChats() }
        case "wa-message":
            guard let d = asDict(ev.data) else { return }
            if let chatId = d["chatId"] as? String {
                if chatId == selectedId, let m = decodeJSON(d["message"], as: WaMessage.self) {
                    if !messages.contains(where: { $0.id == m.id }) { messages.append(m) }
                }
                Task { await loadChats() }
            }
        case "wa-message-update":
            if let d = asDict(ev.data), d["chatId"] as? String == selectedId { Task { await reloadMessages() } }
        case "whatsapp-qr", "comms": Task { await loadStatus() }
        default: break
        }
    }

    func loadStatus() async {
        connected = (try? await client.call("whatsappStatus", as: WhatsAppStatus.self))?.connected ?? false
    }

    func loadChats() async {
        guard connected else { loadingChats = false; return }
        chats = (try? await client.call("waListChats", as: [WaChat].self)) ?? chats
        loadingChats = false
    }

    func select(_ chatId: String) async {
        selectedId = chatId
        messages = []
        await reloadMessages()
        try? await client.callVoid("waMarkRead", ["chatId": chatId])
        if avatars[chatId] == nil, selected?.avatarUrl == nil {
            if let url = (try? await client.call("waFetchAvatar", ["chatId": chatId], as: WaAvatarResult.self))?.url {
                avatars[chatId] = url
            }
        }
    }

    func reloadMessages() async {
        guard let chatId = selectedId else { return }
        loadingMessages = true
        let page = ((try? await client.call("waGetMessages", ["chatId": chatId, "limit": 200], as: [WaMessage].self)) ?? [])
            .sorted { $0.ts < $1.ts }
        messages = page
        hasMore = page.count >= 200
        loadingMessages = false
    }

    /// Prepend an older page (pagination).
    func loadEarlier() async {
        guard let chatId = selectedId, let oldest = messages.first?.ts else { return }
        let older = ((try? await client.call("waGetMessages", ["chatId": chatId, "before": oldest, "limit": 200], as: [WaMessage].self)) ?? [])
            .sorted { $0.ts < $1.ts }
        let existing = Set(messages.map(\.id))
        messages = older.filter { !existing.contains($0.id) } + messages
        hasMore = older.count >= 200
    }

    func send(_ text: String) async {
        guard let chatId = selectedId else { return }
        try? await client.callVoid("waSendText", ["chatId": chatId, "text": text])
        await reloadMessages()
    }

    /// Attach + send a media file (kind inferred from extension).
    func sendMedia(_ url: URL) async {
        guard let chatId = selectedId, let data = try? Data(contentsOf: url) else { return }
        let ext = url.pathExtension.lowercased()
        let kind: String
        switch ext {
        case "jpg", "jpeg", "png", "gif", "webp", "heic": kind = "image"
        case "mp4", "mov", "webm", "m4v": kind = "video"
        case "mp3", "m4a", "ogg", "wav", "aac": kind = "audio"
        default: kind = "document"
        }
        try? await client.callVoid("waSendMedia", [
            "chatId": chatId, "kind": kind, "dataB64": data.base64EncodedString(),
            "fileName": url.lastPathComponent,
        ])
        await reloadMessages()
    }

    func react(_ msg: WaMessage, _ emoji: String) async {
        guard let chatId = selectedId, let mid = msg.msgId else { return }
        try? await client.callVoid("waReact", ["chatId": chatId, "msgId": mid, "emoji": emoji])
    }

    /// Download the full media bytes for a message → a base64 data URL (image/video/audio/document).
    func downloadMedia(_ msg: WaMessage) async -> WaMediaDownload? {
        guard let chatId = selectedId, let mid = msg.msgId else { return nil }
        return try? await client.call("waDownloadMedia", ["chatId": chatId, "msgId": mid], as: WaMediaDownload.self)
    }

    func avatarURL(_ chat: WaChat) -> URL? {
        URL(string: avatars[chat.chatId] ?? chat.avatarUrl ?? "")
    }
}
