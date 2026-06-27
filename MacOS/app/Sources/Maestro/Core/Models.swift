import Foundation

// Lightweight, lenient decodes of the brain's JSON shapes. We only model the fields the
// scoped UI renders; unknown keys are ignored. Field names mirror the TS types in
// apps/desktop/electron + src/lib/api.ts.

struct Project: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var kind: String?        // "coding" | "design" | ...
    var template: String?
    var color: String?
    var path: String?
    var repoUrl: String?
    var hidden: Bool?
    var instructions: String?
    var defaultBaseBranch: String?
    var setupScript: String?
    var runMode: String?     // "concurrent" | "nonconcurrent"
    var spent: Double?
    var sessionIds: [String]?

    enum CodingKeys: String, CodingKey {
        case id, name, kind, template, color, path, repoUrl, hidden
        case instructions, defaultBaseBranch, setupScript, runMode, spent, sessionIds
    }
}

// MARK: - Skills & capabilities (project settings)

/// A skill installed into a project's .claude/skills (from listProjectSkills `{skills:[...]}`).
struct InstalledSkill: Codable, Identifiable, Hashable {
    let id: String
    var slug: String?
    var name: String?
    var description: String?
    var enabled: Bool?
    var sha256: String?
    var addedBy: String?
}
struct InstalledSkillsResult: Codable { var skills: [InstalledSkill] }

/// A host capability from listSkills() — built-in or MCP-backed.
struct Capability: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var description: String?
    var version: String?
    var kind: String?        // "mcp" for MCP servers
    var enabled: Bool?
    var category: String?
}

/// A registry search result (searchSkills).
struct RegistrySkill: Codable, Hashable {
    var id: String?
    var skillId: String?
    var name: String?
    var description: String?
    var risk: String?
    var sourceRepo: String?
    var mirrorRepo: String?
    var version: String?
    var resolvedId: String { skillId ?? id ?? "" }
}
struct RegistryMeta: Codable { var count: Int? }
struct SkillSearchResult: Codable { var count: Int?; var results: [RegistrySkill] }

// MARK: - Design comments

struct DesignComment: Codable, Identifiable, Hashable {
    let id: String
    var selector: String
    var label: String
    var note: String
    var status: String      // "open" | "resolved"
    var createdAt: Double?
    var isResolved: Bool { status == "resolved" }
}
struct DesignCommentsResult: Codable { var comments: [DesignComment] }
struct AddCommentResult: Codable { var comment: DesignComment }

// MARK: - WhatsApp

struct WaChat: Codable, Identifiable, Hashable {
    var chatId: String
    var name: String
    var kind: String        // dm | group | channel
    var avatarUrl: String?
    var lastMessageAt: Double?
    var lastMessageText: String?
    var lastMessageFromMe: Bool?
    var unreadCount: Int?
    var pinned: Bool?
    var muted: Bool?
    var id: String { chatId }
}

struct WaReaction: Codable, Hashable { var emoji: String; var fromMe: Bool }

struct WaMedia: Codable, Hashable {
    var kind: String        // image | video | audio | document | sticker
    var mimetype: String?
    var fileName: String?
    var seconds: Double?
    var sizeBytes: Double?
    var thumbBase64: String?
}

struct WaMessage: Codable, Identifiable, Hashable {
    var id: String
    var msgId: String?
    var chatId: String
    var fromMe: Bool
    var senderId: String?
    var senderName: String?
    var text: String
    var kind: String
    var ts: Double
    var quotedText: String?
    var reactions: [WaReaction]?
    var media: WaMedia?
    var status: String?     // sent | delivered | read
}

struct WaMediaDownload: Codable { var dataUrl: String?; var mimetype: String?; var fileName: String? }

struct WhatsAppStatus: Codable {
    var connected: Bool?
    var name: String?
    var jid: String?
    var sendApproved: Bool?
    var agentSendToOthers: Bool?
    var notifyJid: String?
}
struct WaAvatarResult: Codable { var url: String? }
struct WaQrResult: Codable { var dataUrl: String? }

// MARK: - Comms gateway

struct CommsStatus: Codable {
    struct Tg: Codable { var connected: Bool?; var botUsername: String?; var messagesToday: Int?; var bindings: Int?; var pending: Int? }
    struct Wa: Codable { var connected: Bool?; var name: String?; var tracked: Int?; var sendApproved: Bool? }
    var telegram: Tg
    var whatsapp: Wa
}
struct ChatBinding: Codable, Identifiable, Hashable {
    var chatId: String; var name: String; var kind: String; var provider: String?
    var projectId: String?; var sessionId: String?
    var id: String { chatId }
}
struct PendingChat: Codable, Identifiable, Hashable {
    var chatId: String; var name: String; var kind: String; var firstText: String?; var at: Double?
    var id: String { chatId }
    /// '@' in the id ⇒ WhatsApp; numeric ⇒ Telegram (matches the web heuristic).
    var provider: String { chatId.contains("@") ? "whatsapp" : "telegram" }
}
struct CommEvent: Codable, Identifiable, Hashable {
    var id: String; var dir: String; var chatId: String; var chatName: String; var payload: String; var status: String; var at: Double?
}

// MARK: - Settings (engines / providers / MCP / extension / devices)

struct EngineStatus: Codable, Hashable {
    var engine: String?; var available: Bool?; var method: String?; var detail: String?; var reason: String?
}
struct EngineState: Codable, Hashable {
    var id: String?; var installed: Bool?; var source: String?; var version: String?; var path: String?; var supported: Bool?
}
struct McpServer: Codable, Identifiable, Hashable {
    var id: String; var name: String; var enabled: Bool; var transport: String
    var command: String?; var args: [String]?; var url: String?
}
struct ProviderConn: Codable, Hashable {
    var provider: String; var method: String; var status: String; var detail: String; var keyLast4: String?
}
struct RemoteDevice: Codable, Identifiable, Hashable {
    var id: String; var name: String?; var live: Bool?; var lastSeen: Double?
}
struct PairingResult: Codable { var token: String?; var relayUrl: String?; var devices: [RemoteDevice]? }
struct ExtensionPeer: Codable, Identifiable, Hashable {
    var clientId: String?; var name: String?; var active: Bool?
    var id: String { clientId ?? name ?? UUID().uuidString }
}
struct ExtensionStatus: Codable {
    var running: Bool?; var port: Int?; var token: String?; var path: String?; var peers: [ExtensionPeer]?
}
struct GitHubDevice: Codable { var stage: String?; var pct: Int?; var userCode: String?; var verificationUri: String? }

struct ChatSession: Codable, Identifiable, Hashable {
    let id: String
    var title: String?
    var projectId: String?
    var codename: String?
    var archived: Double?    // timestamp when archived; nil = active
    var pinned: Bool?
    var branch: String?
    var updatedAt: Double?
    var source: String?      // imported-from origin (claude/codex/conductor)
    var worktreePath: String?  // absolute path of this session's git worktree (the run cwd)

    var isArchived: Bool { archived != nil }
    var displayTitle: String { (title?.isEmpty == false ? title : nil) ?? "New chat" }
}

// MARK: - Schedules

/// A scheduled job — mirrors `Schedule` in apps/desktop/electron/store.ts. Covers both the
/// one-shot "queued message" (fireAt + sessionId + prompt) and recurring tasks (time + cadence,
/// or everyMinutes). System kinds (auto-continue / auto-answer / keep-going / retry-run /
/// whatsapp-analyze) also flow through here; the UI renders them read-only. We model only the
/// fields the UI needs; presentation helpers live in `ScheduleFormat.swift`.
struct Schedule: Codable, Identifiable, Hashable {
    let id: String
    var projectId: String?
    var title: String
    var time: String?         // "HH:MM" for recurring clock schedules
    var cadence: String?      // "daily" | "weekdays" | "weekend" | "Mon, Wed, Fri" | …
    var enabled: Bool
    var nextRun: Double?
    var lastRun: Double?
    var createdAt: Double
    var fireAt: Double?       // one-shot absolute fire time (ms)
    var sessionId: String?
    var prompt: String?
    var kind: String?         // nil/"message" = user; others are system-created
    var effort: String?
    var browser: Bool?
    var plan: Bool?
    var goal: Bool?
    var everyMinutes: Int?    // interval recurrence
    var catchUp: Bool?
    var paused: Bool?
}

/// A server-pushed event (`maestro:event` → our WS `{t:"event"}`).
struct MaestroEvent {
    let name: String
    let data: Any?
}
