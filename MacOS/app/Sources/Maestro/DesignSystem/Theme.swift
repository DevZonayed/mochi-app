import SwiftUI
import Observation

/// App-wide appearance + genre. Mirrors the web `useTheme`/`usePurpose` stores
/// (localStorage `maestro.theme` / `maestro.purpose`).
@Observable
@MainActor
final class Theme {
    enum Pref: String { case light, dark, auto }
    enum Purpose: String { case general, coding, design, video }

    var pref: Pref {
        didSet { UserDefaults.standard.set(pref.rawValue, forKey: "maestro.theme") }
    }
    var purpose: Purpose {
        didSet { UserDefaults.standard.set(purpose.rawValue, forKey: "maestro.purpose") }
    }

    init() {
        pref = Pref(rawValue: UserDefaults.standard.string(forKey: "maestro.theme") ?? "auto") ?? .auto
        purpose = Purpose(rawValue: UserDefaults.standard.string(forKey: "maestro.purpose") ?? "coding") ?? .coding
    }

    /// nil = follow the OS (auto).
    var resolved: ColorScheme? {
        switch pref {
        case .light: return .light
        case .dark: return .dark
        case .auto: return nil
        }
    }

    /// Toggle flips light<->dark (does not cycle through auto — matches the web toolbar toggle).
    func toggle(current: ColorScheme) {
        pref = current == .dark ? .light : .dark
    }
}
