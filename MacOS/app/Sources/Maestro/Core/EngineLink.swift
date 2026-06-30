import Foundation

/// The single source of truth for the Mac app ⇄ Node-brain connection. Owned and published by
/// `SidecarSupervisor`, observed by the UI (`EngineGate`), and awaited by `MaestroClient` before
/// every RPC. The whole point of the "one unit" design: a startup race or a crash is a *transient*
/// state here, never a dead "Not connected" error. RPCs park on `.starting`/`.connecting`/
/// `.recovering` and only fail on the terminal `.down`.
enum EngineLink: Equatable {
    case starting              // sidecar process spawned, brain booting; no socket yet
    case connecting            // ready handshake seen, WS connecting + verifying a round-trip
    case ready                 // verified live; RPCs flow
    case recovering(String)    // was up, socket/process dropped; auto-recovering (reason = hint)
    case down(String)          // recovery exhausted / fatal boot; reason carries the stderr tail

    var isReady: Bool { if case .ready = self { return true }; return false }

    /// While waiting (not ready, not terminally down), RPCs should suspend rather than fail.
    var isWaiting: Bool {
        switch self {
        case .starting, .connecting, .recovering: return true
        case .ready, .down: return false
        }
    }

    /// Short status label for the connection banner.
    var label: String {
        switch self {
        case .starting:   return "Starting the engine…"
        case .connecting: return "Connecting…"
        case .ready:      return "Connected"
        case .recovering: return "Reconnecting…"
        case .down(let r): return r.isEmpty ? "Engine unavailable" : r
        }
    }
}
