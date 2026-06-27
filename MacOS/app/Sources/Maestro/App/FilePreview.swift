import SwiftUI
import AppKit
import Quartz        // vends QuickLookUI → QLPreviewView / QLPreviewItem
import QuickLookUI   // explicit (Quartz re-exports it; both resolve)

/// Wraps `QLPreviewView`, which natively renders virtually every file type — PDF, PNG/JPG/HEIC,
/// plain text, JSON, Markdown, and source code (shown as syntax-less text). Unknown/code types
/// fall back to a text view. This is exactly what a file chip opens on click.
struct QuickLookPreview: NSViewRepresentable {
    let url: URL

    func makeNSView(context: Context) -> QLPreviewView {
        let v = QLPreviewView(frame: .zero, style: .normal) ?? QLPreviewView()
        v.autostarts = true
        v.previewItem = url as QLPreviewItem
        return v
    }

    func updateNSView(_ nsView: QLPreviewView, context: Context) {
        if (nsView.previewItem as? URL) != url { nsView.previewItem = url as QLPreviewItem }
    }

    static func dismantleNSView(_ nsView: QLPreviewView, coordinator: ()) { nsView.close() }
}

/// File status so a folder / missing path renders a graceful message instead of an empty preview.
enum FileStatus: Equatable {
    case file, directory, missing
    init(url: URL) {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { self = .missing; return }
        self = isDir.boolValue ? .directory : .file
    }
}

/// The body of a file-preview window: a QuickLook view + a slim header (filename, reveal/open).
struct FilePreviewWindow: View {
    let url: URL
    private var status: FileStatus { FileStatus(url: url) }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Group {
                switch status {
                case .file:
                    QuickLookPreview(url: url).frame(maxWidth: .infinity, maxHeight: .infinity)
                case .directory:
                    message("This is a folder", "“\(url.lastPathComponent)” is a directory, not a file.", icon: "folder")
                case .missing:
                    message("File not found", url.path, icon: "questionmark.folder")
                }
            }
        }
        .frame(minWidth: 480, minHeight: 360)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Image(systemName: ToolViz.fileSymbol(url.lastPathComponent))
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(ToolViz.extColor(url.lastPathComponent))
            VStack(alignment: .leading, spacing: 1) {
                Text(url.lastPathComponent).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Text(url.deletingLastPathComponent().path).font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            }
            Spacer(minLength: 8)
            Button { NSWorkspace.shared.activateFileViewerSelecting([url]) } label: {
                Image(systemName: "magnifyingglass")
            }.help("Reveal in Finder").disabled(status == .missing)
            Button { NSWorkspace.shared.open(url) } label: {
                Image(systemName: "arrow.up.forward.app")
            }.help("Open with default app").disabled(status == .missing)
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 14).padding(.vertical, 9)
    }

    @ViewBuilder private func message(_ title: String, _ detail: String, icon: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 42)).foregroundStyle(.secondary)
            Text(title).font(.title3.weight(.semibold))
            Text(detail).font(.callout).foregroundStyle(.secondary)
                .textSelection(.enabled).multilineTextAlignment(.center).lineLimit(4).padding(.horizontal, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Opens (and dedups) native file-preview windows. Call `.shared.open(url)` from any view —
/// no SwiftUI scene plumbing required. Reuses the existing window when the same file is reopened.
@MainActor
final class FilePreviewWindowController {
    static let shared = FilePreviewWindowController()
    private var windows: [URL: NSWindow] = [:]

    /// Open `path` (absolute) in a preview window. Non-absolute paths are rejected (nothing to load).
    func open(path: String) {
        guard path.hasPrefix("/") else { return }
        open(URL(fileURLWithPath: path))
    }

    func open(_ url: URL) {
        if let existing = windows[url] {
            existing.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); return
        }
        let hosting = NSHostingController(rootView: FilePreviewWindow(url: url))
        let win = NSWindow(contentViewController: hosting)
        win.title = url.lastPathComponent
        win.setContentSize(NSSize(width: 920, height: 720))
        win.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        win.isReleasedWhenClosed = false
        win.center()
        windows[url] = win
        var token: NSObjectProtocol?
        token = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: win, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.windows[url] = nil }
            if let token { NotificationCenter.default.removeObserver(token) }
        }
        win.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
}
