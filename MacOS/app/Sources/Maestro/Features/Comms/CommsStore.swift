import SwiftUI
import Observation

/// Drives the Comms gateway: Telegram + WhatsApp connection state, the QR link flow, chat
/// bindings, pending chats, and the activity log. All Mac-local.
@Observable
@MainActor
final class CommsStore {
    var status: CommsStatus?
    var wa: WhatsAppStatus?
    var bindings: [ChatBinding] = []
    var pending: [PendingChat] = []
    var events: [CommEvent] = []
    var projects: [Project] = []

    var qrImageData: String?   // base64 data-url while linking
    var pairingCode: String?   // shown when linking via phone number instead of QR
    var linking = false
    var busy = false
    var error: String?

    private let client: MaestroClient
    private var token: Int?
    private var qrTask: Task<Void, Never>?
    init(client: MaestroClient) { self.client = client }

    func start() async {
        if token == nil {
            token = client.onEvent { [weak self] ev in
                if ev.name == "comms" || ev.name == "whatsapp-qr" { Task { @MainActor in await self?.refresh() } }
            }
        }
        await refresh()
    }
    func stop() { qrTask?.cancel(); if let t = token { client.removeHandler(t); token = nil } }

    func refresh() async {
        status = try? await client.call("commsStatus", as: CommsStatus.self)
        wa = try? await client.call("whatsappStatus", as: WhatsAppStatus.self)
        bindings = (try? await client.call("listChatBindings", as: [ChatBinding].self)) ?? bindings
        pending = (try? await client.call("listPendingChats", as: [PendingChat].self)) ?? pending
        events = (try? await client.call("listCommEvents", as: [CommEvent].self)) ?? events
        if projects.isEmpty { projects = (try? await client.call("listProjects", as: [Project].self)) ?? [] }
        if wa?.connected == true { stopLinking() }
    }

    // MARK: telegram
    func connectTelegram(_ tokenStr: String) async {
        busy = true; error = nil; defer { busy = false }
        do { _ = try await client.callRaw("connectTelegram", ["token": tokenStr]); await refresh() }
        catch { self.error = (error as? RPCError)?.errorDescription ?? error.localizedDescription }
    }
    func disconnectTelegram() async { try? await client.callVoid("disconnectTelegram"); await refresh() }

    // MARK: whatsapp link / QR
    /// Link the number. With no `phone` → QR flow; with a `phone` → request a pairing code that the
    /// operator types into WhatsApp → Linked Devices → "Link with phone number".
    func linkWhatsApp(phone: String? = nil) async {
        error = nil; linking = true; pairingCode = nil; qrImageData = nil
        var params: [String: Any] = [:]
        if let phone, !phone.isEmpty { params["phone"] = phone }
        let link = try? await client.call("whatsappLink", params, as: WhatsAppLink.self)
        if link?.method == "pairing" { pairingCode = link?.code }
        qrTask?.cancel()
        qrTask = Task { [weak self] in
            for _ in 0..<120 { // ~5 min
                if Task.isCancelled { return }
                guard let self else { return }
                if self.pairingCode == nil {
                    self.qrImageData = (try? await self.client.call("whatsappQr", as: WaQrResult.self))?.dataUrl
                }
                let st = try? await self.client.call("whatsappStatus", as: WhatsAppStatus.self)
                if st?.connected == true { await self.refresh(); return }
                try? await Task.sleep(for: .milliseconds(2500))
            }
        }
    }
    func cancelLink() async { stopLinking(); try? await client.callVoid("unlinkWhatsApp"); await refresh() }
    private func stopLinking() { linking = false; qrImageData = nil; pairingCode = nil; qrTask?.cancel(); qrTask = nil }

    func disconnectWhatsApp() async { try? await client.callVoid("disconnectWhatsApp"); await refresh() }
    func unlinkWhatsApp() async { stopLinking(); try? await client.callVoid("unlinkWhatsApp"); await refresh() }
    func approveSend() async { try? await client.callVoid("approveWhatsappSend"); await refresh() }
    func setRecipient(_ number: String) async { try? await client.callVoid("setWhatsappRecipient", ["number": number]); await refresh() }
    func setAgentSend(_ on: Bool) async { try? await client.callVoid("setWhatsappAgentSend", ["on": on]); await refresh() }

    // MARK: bindings
    func bind(_ chat: PendingChat, projectId: String?, sessionId: String?) async {
        var params: [String: Any] = ["chatId": chat.chatId, "provider": chat.provider]
        if let projectId { params["projectId"] = projectId }
        if let sessionId { params["sessionId"] = sessionId }
        try? await client.callRaw("bindChat", params)
        await refresh()
    }
    func unbind(_ chatId: String) async { try? await client.callVoid("unbindChat", ["chatId": chatId]); await refresh() }
    func sessions(for projectId: String) async -> [ChatSession] {
        ((try? await client.call("listSessions", ["projectId": projectId], as: [ChatSession].self)) ?? []).filter { !$0.isArchived }
    }
}
