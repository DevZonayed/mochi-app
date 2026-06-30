import SwiftUI
import AppKit

/// In-tab file viewer: reads via `readFile`, renders rendered-markdown / highlighted-source / an
/// edit textarea (⌘S → writeFile), with Copy + Reveal. Images get a Fit/1:1 viewer; PDFs and other
/// binaries fall back to native QuickLook (which the renderer can't do in-tab). Mirrors `CodeView.tsx`.
struct FileViewer: View {
    @Environment(AppEnv.self) private var env
    let projectId: String
    let path: String            // absolute

    enum Mode { case preview, source, edit }
    @State private var result: ReadFileResult?
    @State private var mode: Mode = .source
    @State private var editText = ""
    @State private var dirty = false
    @State private var loadError: String?
    @State private var binary = false
    @State private var toast: (msg: String, ok: Bool)?

    private var name: String { (path as NSString).lastPathComponent }
    private var ext: String { FileTreeIcon.ext(name) }
    private var isMarkdown: Bool { ["md", "mdx", "markdown"].contains(ext) }
    private var isImage: Bool { ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff", "ico"].contains(ext) }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Tok.separator)
            bodyContent
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tok.bgElevated)
        .task(id: path) { await load() }
        .overlay(alignment: .bottomTrailing) { if let t = toast { toastView(t) } }
    }

    private var header: some View {
        HStack(spacing: 10) {
            FileTreeIcon(name: name, size: 16)
            Text(name).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink)
            if dirty { Circle().fill(Tok.orange).frame(width: 6, height: 6) }
            Text(path).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 8)
            if !isImage && !binary {
                segmented
                CopyChip(text: editText.isEmpty ? (result?.text ?? "") : editText)
                if mode == .edit {
                    Button { Task { await save() } } label: {
                        HStack(spacing: 4) { Icon(name: dirty ? "check" : "refresh", size: 11); Text("Save").font(TokFont.text(TokFont.caption, .semibold)) }
                            .foregroundStyle(dirty ? .white : Tok.inkTertiary).padding(.horizontal, 9).frame(height: 24)
                            .background(dirty ? Tok.blue : Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                    }.buttonStyle(.plain).keyboardShortcut("s", modifiers: .command)
                }
            }
            Button { NativeBridge.reveal(path) } label: { Icon(name: "folder", size: 14).foregroundStyle(Tok.inkSecondary) }.buttonStyle(.plain).help("Reveal in Finder")
        }
        .padding(.horizontal, 14).padding(.vertical, 8)
    }

    private var segmented: some View {
        HStack(spacing: 2) {
            if isMarkdown { modeTab("Preview", "bookmark", .preview) }
            modeTab("Source", "terminal", .source)
            modeTab("Edit", "brush", .edit)
        }
        .padding(2).background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
    }
    private func modeTab(_ label: String, _ icon: String, _ m: Mode) -> some View {
        Button { mode = m } label: {
            HStack(spacing: 4) { Icon(name: icon, size: 11); Text(label).font(TokFont.text(TokFont.caption, .semibold)) }
                .foregroundStyle(mode == m ? Tok.ink : Tok.inkSecondary).padding(.horizontal, 8).frame(height: 22)
                .background(mode == m ? Tok.bgElevated : .clear).clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
        }.buttonStyle(.plain)
    }

    @ViewBuilder private var bodyContent: some View {
        if isImage {
            ImageFileView(path: path)
        } else if binary {
            QuickLookPreview(url: URL(fileURLWithPath: path))
        } else if let loadError {
            Text(loadError).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if result == nil {
            Spinner(size: 18).tint(Tok.inkTertiary).frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            if let r = result, r.truncated {
                Text("Large file — showing the first \(r.bytes / 1024) KB. Saving would overwrite with this slice.")
                    .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.orange)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 14).padding(.vertical, 6)
                    .background(Tok.orange.opacity(0.10))
            }
            switch mode {
            case .preview: ScrollView { MarkdownText(text: result?.text ?? "", projectRoot: (path as NSString).deletingLastPathComponent).frame(maxWidth: 820).padding(.horizontal, 28).padding(.vertical, 20).frame(maxWidth: .infinity) }
            case .source: sourceView
            case .edit: editView
            }
        }
    }

    private var sourceView: some View {
        ScrollView([.vertical, .horizontal]) {
            HStack(alignment: .top, spacing: 0) {
                Text(lineNumbers).font(.system(size: 12.5, design: .monospaced)).foregroundStyle(Tok.inkTertiary)
                    .lineSpacing(4).multilineTextAlignment(.trailing)
                    .padding(.horizontal, 10).padding(.vertical, 12).background(Tok.bgElevated)
                Text(SyntaxHighlighter.attributed(result?.text ?? "", name: name)).lineSpacing(4)
                    .textSelection(.enabled).padding(.horizontal, 13).padding(.vertical, 12)
                    .frame(minWidth: 0, alignment: .leading)
            }
        }
    }

    private var editView: some View {
        TextEditor(text: $editText)
            .font(.system(size: 13, design: .monospaced)).foregroundStyle(Tok.ink)
            .scrollContentBackground(.hidden).padding(8)
            .onChange(of: editText) { dirty = (editText != (result?.text ?? "")) }
    }

    private var lineNumbers: String {
        let n = max(1, (result?.text ?? "").components(separatedBy: "\n").count)
        return (1...n).map(String.init).joined(separator: "\n")
    }

    private func load() async {
        result = nil; loadError = nil; binary = false; dirty = false
        if isImage { return }
        do {
            let r = try await env.client.readFile(projectId, path)
            result = r; editText = r.text
            mode = isMarkdown ? .preview : .source
        } catch let e {
            // The brain rejects binaries ("binary file") → fall back to native QuickLook.
            if "\(e)".lowercased().contains("binary") { binary = true } else { loadError = "Couldn't open file. \(e)" }
        }
    }

    private func save() async {
        guard dirty else { return }
        do {
            _ = try await env.client.writeFile(projectId, path, editText)
            result?.text = editText; dirty = false
            flash("Saved", ok: true)
        } catch let e { flash("\(e)", ok: false) }
    }

    private func flash(_ msg: String, ok: Bool) {
        toast = (msg, ok)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { toast = nil }
    }
    private func toastView(_ t: (msg: String, ok: Bool)) -> some View {
        Text(t.msg).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(.white)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(t.ok ? Tok.green : Tok.red).clipShape(Capsule()).padding(16)
    }
}

/// A 1:1 / Fit image viewer for a file path (tree-opened images). Renderer parity for `ImageViewer`.
struct ImageFileView: View {
    let path: String
    @State private var fit = true
    var body: some View {
        let img = NSImage(contentsOfFile: path)
        return ScrollView([.vertical, .horizontal]) {
            ZStack {
                if let img {
                    Image(nsImage: img).resizable().aspectRatio(contentMode: fit ? .fit : .fill)
                        .frame(maxWidth: fit ? .infinity : nil)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .shadow(color: .black.opacity(0.2), radius: 12, y: 6)
                        .onTapGesture { fit.toggle() }
                        .padding(24)
                } else {
                    Text("Couldn't load image.").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary).padding(40)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .background(Tok.bgGrouped)
        .overlay(alignment: .topTrailing) {
            Button { fit.toggle() } label: {
                Text(fit ? "1:1" : "Fit").font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.inkSecondary)
                    .padding(.horizontal, 9).frame(height: 24).background(Tok.bgElevated).clipShape(Capsule())
                    .overlay(Capsule().strokeBorder(Tok.separator, lineWidth: Tok.hairline))
            }.buttonStyle(.plain).padding(12)
        }
    }
}
