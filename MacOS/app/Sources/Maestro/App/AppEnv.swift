import SwiftUI
import Observation

enum Route: String, CaseIterable, Identifiable {
    case codespace, design, comms, whatsapp, schedule, settings
    var id: String { rawValue }
    var label: String {
        switch self {
        case .codespace: return "CodeSpace"
        case .design: return "Design"
        case .comms: return "Comms"
        case .whatsapp: return "WhatsApp"
        case .schedule: return "Schedule"
        case .settings: return "Settings"
        }
    }
    var icon: String {
        switch self {
        case .codespace: return "terminal"
        case .design: return "brush"
        case .comms: return "chat"
        case .whatsapp: return "whatsapp"
        case .schedule: return "clock"
        case .settings: return "settings"
        }
    }
    /// The genre top-nav shows these; Settings is the trailing gear.
    static let navBar: [Route] = [.codespace, .design, .comms, .whatsapp, .schedule]
}

/// Root container for app-wide singletons. Injected via `.environment`.
@Observable
@MainActor
final class AppEnv {
    let theme = Theme()
    let client: MaestroClient
    let supervisor: SidecarSupervisor
    var route: Route = .codespace
    /// The CodeSpace workspace lives at app scope so its tree/tabs persist across route switches
    /// (each route is its own view that gets rebuilt on navigation).
    var workspace: WorkspaceStore?

    init() {
        let c = MaestroClient()
        client = c
        supervisor = SidecarSupervisor(client: c)
    }

    func boot() {
        supervisor.start()
        let w = WorkspaceStore(client: client)
        workspace = w
        Task { await w.start() }
    }
}
