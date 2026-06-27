import SwiftUI
import Observation

enum Route: String, CaseIterable, Identifiable {
    case codespace, design, comms, whatsapp, settings
    var id: String { rawValue }
    var label: String {
        switch self {
        case .codespace: return "CodeSpace"
        case .design: return "Design"
        case .comms: return "Comms"
        case .whatsapp: return "WhatsApp"
        case .settings: return "Settings"
        }
    }
    var icon: String {
        switch self {
        case .codespace: return "terminal"
        case .design: return "brush"
        case .comms: return "chat"
        case .whatsapp: return "whatsapp"
        case .settings: return "settings"
        }
    }
    /// The genre top-nav shows these four; Settings is the trailing gear.
    static let navBar: [Route] = [.codespace, .design, .comms, .whatsapp]
}

/// Root container for app-wide singletons. Injected via `.environment`.
@Observable
@MainActor
final class AppEnv {
    let theme = Theme()
    let client: MaestroClient
    let supervisor: SidecarSupervisor
    var route: Route = .codespace

    init() {
        let c = MaestroClient()
        client = c
        supervisor = SidecarSupervisor(client: c)
    }

    func boot() { supervisor.start() }
}
