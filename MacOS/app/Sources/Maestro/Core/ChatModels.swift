import Foundation

/// One agent run = one chat turn (the user's prompt + the assistant's work). Mirrors the TS
/// `Job` in store.ts. We model the fields the transcript renders.
struct Job: Codable, Identifiable, Hashable {
    let id: String
    var projectId: String?
    var sessionId: String?
    var title: String?
    var status: String          // pending | running | done | failed | cancelled
    var phase: String?
    var input: String           // the user's message
    var output: String?
    var error: String?
    var effort: String?
    var cost: Double?
    var tokens: Double?
    var engine: String?
    var model: String?
    var goal: Bool?
    var transcript: [TranscriptItem]?
    var inputImages: [ChatImageRef]?
    var inputFiles: [ChatFileRef]?
    var pausedUntil: Double?
    var pausedReason: String?
    /// How full the context window was on the last request (input + cache-read + cache-creation
    /// tokens). Drives the composer's context-remaining gauge. nil for engines that don't report it.
    var contextTokens: Double?
    /// Epoch ms when the Claude usage limit lifts, set only when this turn was capped.
    var limitResetsAt: Double?
    var createdAt: Double
    var updatedAt: Double?

    var isRunning: Bool { status == "running" || status == "pending" }
    var isPaused: Bool { (pausedUntil ?? 0) > Date().timeIntervalSince1970 * 1000 }
}

/// One block of an assistant turn's work log. Mirrors TS `TranscriptItem`.
struct TranscriptItem: Codable, Hashable, Identifiable {
    var kind: String            // text | thinking | tool | result | ask | review | image
    var text: String
    var name: String?           // tool: tool name
    var cmd: String?            // tool: raw command behind a human label
    var toolStatus: String?     // running | done | error
    var verdict: String?        // review
    var resolved: Bool?
    var durMs: Double?
    var preview: String?        // file-write snapshot
    var ask: String?            // ask: JSON of the question
    var children: [TranscriptItem]?  // sub-agent transcript
    var result: String?         // sub-agent final text
    var assetId: String?        // image
    var imagePath: String?
    var alt: String?
    var width: Double?
    var height: Double?
    var ts: Double

    var id: String { "\(kind)-\(ts)-\(name ?? "")" }
}

/// An agent-spawned background process (dev server / watcher).
struct BgTask: Codable, Identifiable, Hashable {
    var id: String
    var command: String
    var status: String       // running | exited | stopped | failed
    var projectId: String?
    var sessionId: String?
    var pid: Int?
    var exitCode: Int?
    var isRunning: Bool { status == "running" }
}

/// AskUserQuestion payload (JSON in TranscriptItem.ask).
struct AskPayload: Codable {
    struct Q: Codable { var question: String?; var header: String?; var multiSelect: Bool?; var options: [Opt]? }
    struct Opt: Codable { var label: String?; var description: String? }
    var questions: [Q]?
}

/// An image attached to a user message (vision input).
struct ChatImageRef: Codable, Hashable {
    var id: String?
    var assetId: String?
    var imagePath: String?
    var mime: String?
    var name: String?
    var width: Double?
    var height: Double?
}

/// A non-image file/text attached to a user message. Mirrors `ChatFile` in store.ts.
struct ChatFileRef: Codable, Hashable {
    var id: String?
    var name: String
    var kind: String?       // "text" | "file"
    var mime: String?
    var bytes: Double?
    var path: String?
    var preview: String?
}
