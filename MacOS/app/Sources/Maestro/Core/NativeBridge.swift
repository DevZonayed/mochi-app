import AppKit

/// Native macOS affordances that the web app reached through Electron's main process
/// (`pickFolder`, `revealPath`). On native these are done directly with AppKit — more native
/// than the Electron equivalents, and they don't need the sidecar.
@MainActor
enum NativeBridge {
    /// Folder picker (replaces Electron `dialog.showOpenDialog` / `maestro:pickFolder`).
    static func pickFolder(prompt: String = "Choose") -> String? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = prompt
        return panel.runModal() == .OK ? panel.url?.path : nil
    }

    /// Reveal a path in Finder (replaces `maestro:revealPath`).
    static func reveal(_ path: String) {
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
    }

    /// Copy text to the pasteboard.
    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
