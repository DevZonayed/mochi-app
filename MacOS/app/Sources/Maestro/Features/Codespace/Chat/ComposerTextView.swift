import SwiftUI
import AppKit
import UniformTypeIdentifiers

// An editable, paste-intercepting composer editor. SwiftUI's TextField gives no paste hook, so
// pasted images/files were silently dropped and long text flooded the field. This AppKit-backed
// editor classifies the pasteboard (image → file → long-text) into inline attachment CHIPS and
// only inserts genuine short text, matching the Electron RichComposer.

// MARK: - Attachment model

/// A composer attachment before send — an image (vision), a text blob (pasted text / a text file,
/// read by the agent), or any other file (saved + read). Serialized into sendChat `images`/`files`.
struct ComposerAttachment: Identifiable, Equatable {
    enum Kind: Equatable { case image, text, file }
    let id: String
    var kind: Kind
    var name: String
    var mime: String = ""
    var dataB64: String = ""   // image / file payload
    var content: String = ""   // text payload

    /// Placeholder-safe id: digits + `-` + alnum, matching the brain's `«attach:([A-Za-z0-9_-]+)»`.
    static func newId() -> String { "att-\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(10))" }

    /// Display label — the sentinel pasted-text name reads nicer as "Pasted text".
    var label: String { (kind == .text && name == "Pasted text.txt") ? "Pasted text" : name }

    static func image(_ data: Data, name: String = "pasted.png", mime: String = "image/png") -> ComposerAttachment {
        ComposerAttachment(id: newId(), kind: .image, name: name, mime: mime, dataB64: data.base64EncodedString())
    }
    static func text(_ content: String, name: String = "Pasted text.txt") -> ComposerAttachment {
        ComposerAttachment(id: newId(), kind: .text, name: name, content: content)
    }
    static func file(_ data: Data, name: String, mime: String) -> ComposerAttachment {
        ComposerAttachment(id: newId(), kind: .file, name: name, mime: mime, dataB64: data.base64EncodedString())
    }
}

let kMaxComposerAttachments = 8
private let kMaxAttachmentBytes = 30 * 1024 * 1024
/// The brain drops images whose decoded buffer exceeds 16MB (localApi.ts sendChat), so cap on the
/// Swift side too — never make a chip the server will silently discard.
private let kMaxImageBytes = 16 * 1024 * 1024

/// True for files the agent should read as UTF-8 text (so they round-trip as an editable `.text`
/// attachment rather than an opaque base64 blob). Mirrors the Electron `isTextFile` heuristic.
private func looksLikeText(name: String, data: Data) -> Bool {
    let ext = (name as NSString).pathExtension.lowercased()
    let textExt: Set<String> = ["txt","md","markdown","mdx","rst","json","jsonc","yaml","yml","toml","ini","cfg","conf",
        "csv","tsv","log","xml","html","htm","svg","css","scss","sass","less","js","jsx","ts","tsx","mjs","cjs","py",
        "rb","go","rs","java","kt","kts","c","h","cc","cpp","hpp","cs","php","swift","m","mm","sh","bash","zsh","fish",
        "sql","graphql","gql","env","gitignore","dockerfile","makefile","gradle","properties","vue","svelte","astro",
        "r","lua","pl","pm","dart","ex","exs","erl","clj","scala","tf","proto"]
    if textExt.contains(ext) { return true }
    if ext.isEmpty, data.count <= 512 * 1024 { return true }   // small extensionless → probably text
    return false
}

/// Turn a pasted/dropped file URL into a `ComposerAttachment` (text when readable as UTF-8, else a
/// base64 file). Returns nil for unreadable / oversized files.
func composerAttachment(forFileURL url: URL) -> ComposerAttachment? {
    guard let data = try? Data(contentsOf: url), !data.isEmpty, data.count <= kMaxAttachmentBytes else { return nil }
    let name = url.lastPathComponent
    if looksLikeText(name: name, data: data), let s = String(data: data, encoding: .utf8) {
        return ComposerAttachment.text(s, name: name)
    }
    let mime = UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    // An image over the brain's 16MB image cap rides as a generic file (saved + readable) rather
    // than an image the server would drop.
    if mime.hasPrefix("image/"), data.count <= kMaxImageBytes { return ComposerAttachment.image(data, name: name, mime: mime) }
    return ComposerAttachment.file(data, name: name, mime: mime)
}

private extension NSImage {
    func pngData() -> Data? {
        guard let tiff = tiffRepresentation, let rep = NSBitmapImageRep(data: tiff) else { return nil }
        return rep.representation(using: .png, properties: [:])
    }
}

// MARK: - NSTextView subclass (Return-to-send + paste interception)

final class ComposerNSTextView: NSTextView {
    var onReturn: (() -> Void)?
    var onCommandReturn: (() -> Void)?
    /// Return true if the paste was consumed as an attachment (so we don't insert it as text).
    var onPasteboard: (() -> Bool)?

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 36 || event.keyCode == 76 {   // Return / numpad Enter
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            if mods.contains(.command) { onCommandReturn?(); return }
            if mods.contains(.shift) { super.keyDown(with: event); return }   // Shift+Enter → newline
            onReturn?(); return
        }
        super.keyDown(with: event)
    }

    override func paste(_ sender: Any?) {
        if onPasteboard?() == true { return }
        super.pasteAsPlainText(sender)
    }
    override func pasteAsPlainText(_ sender: Any?) {
        if onPasteboard?() == true { return }
        super.pasteAsPlainText(sender)
    }
}

// MARK: - SwiftUI wrapper

struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    var disabled: Bool
    /// Payloads for the inline chips, keyed by id — used to render each `«attach:id»` marker as a chip.
    var attachmentsById: [String: ComposerAttachment] = [:]
    var minHeight: CGFloat = 22
    var maxHeight: CGFloat = 184
    var onReturn: () -> Void
    var onCommandReturn: () -> Void
    /// Register pasted attachments with the host; returns the ones it accepted (within the cap) so
    /// we insert a chip only for those.
    var onAttach: ([ComposerAttachment]) -> [ComposerAttachment]

    func makeCoordinator() -> Coord { Coord(self) }

    static let typingFont = NSFont.systemFont(ofSize: 14)
    static func typingAttributes() -> [NSAttributedString.Key: Any] { [.font: typingFont, .foregroundColor: TokNS.ink] }

    func makeNSView(context: Context) -> NSScrollView {
        let tv = ComposerNSTextView()
        tv.delegate = context.coordinator
        tv.isRichText = true                    // needed so inline attachment chips render
        tv.font = Self.typingFont
        tv.textColor = TokNS.ink
        tv.typingAttributes = Self.typingAttributes()
        tv.insertionPointColor = NSColor(Tok.blue)
        tv.drawsBackground = false
        tv.isEditable = !disabled
        tv.isSelectable = true
        tv.allowsUndo = true
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.isAutomaticSpellingCorrectionEnabled = false
        tv.textContainerInset = NSSize(width: 0, height: 3)
        tv.textContainer?.lineFragmentPadding = 0
        tv.textStorage?.setAttributedString(Self.attributed(from: text, attachmentsById: attachmentsById))
        tv.minSize = NSSize(width: 0, height: minHeight)
        tv.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        tv.isVerticallyResizable = true
        tv.isHorizontallyResizable = false
        tv.autoresizingMask = [.width]
        tv.textContainer?.widthTracksTextView = true
        tv.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        tv.onReturn = { context.coordinator.parent.onReturn() }
        tv.onCommandReturn = { context.coordinator.parent.onCommandReturn() }
        tv.onPasteboard = { [weak tv] in context.coordinator.handlePaste(tv) }

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = false
        scroll.hasHorizontalScroller = false
        scroll.documentView = tv
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        context.coordinator.parent = self
        guard let tv = scroll.documentView as? ComposerNSTextView else { return }
        tv.isEditable = !disabled
        // Rebuild only on an EXTERNAL change (clear-on-send, drop-append, queue refill). Live typing
        // already keeps the serialized text in sync, so serialize == text and we skip the rebuild —
        // which would otherwise reset the caret. We compare the SERIALIZED form (chips → markers).
        if Self.serialize(tv.textStorage) != text {
            tv.textStorage?.setAttributedString(Self.attributed(from: text, attachmentsById: attachmentsById))
            tv.typingAttributes = Self.typingAttributes()
            let end = tv.textStorage?.length ?? 0
            tv.setSelectedRange(NSRange(location: end, length: 0))
        }
    }

    // MARK: - Inline-chip serialization

    /// Flatten the editor's attributed content to the wire text: a chip → its `«attach:id»` marker,
    /// everything else → its characters. This is the `text` binding the rest of the app sends.
    static func serialize(_ storage: NSTextStorage?) -> String {
        guard let storage else { return "" }
        var out = ""
        storage.enumerateAttribute(.attachment, in: NSRange(location: 0, length: storage.length)) { value, range, _ in
            if let chip = value as? InlineChipAttachment {
                out += "«attach:\(chip.attachId)»"
            } else {
                out += (storage.string as NSString).substring(with: range)
            }
        }
        return out
    }

    /// Build the displayed attributed string from wire text: each `«attach:id»` whose payload we know
    /// becomes an inline chip; the rest is plain typed-style text.
    static func attributed(from text: String, attachmentsById: [String: ComposerAttachment]) -> NSAttributedString {
        let out = NSMutableAttributedString()
        let ns = text as NSString
        guard let re = try? NSRegularExpression(pattern: "«attach:([A-Za-z0-9_-]+)»") else {
            return NSAttributedString(string: text, attributes: typingAttributes())
        }
        var last = 0
        for m in re.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            if m.range.location > last {
                out.append(NSAttributedString(string: ns.substring(with: NSRange(location: last, length: m.range.location - last)), attributes: typingAttributes()))
            }
            let id = ns.substring(with: m.range(at: 1))
            if let att = attachmentsById[id] {
                out.append(chipAttributed(att))
            } else {
                // Unknown id (e.g. a restored queued message without its payload): keep the marker as
                // literal text so serialize() round-trips it — dropping it would make serialize != text
                // on every update and spin updateNSView into an infinite rebuild loop.
                out.append(NSAttributedString(string: ns.substring(with: m.range), attributes: typingAttributes()))
            }
            last = m.range.location + m.range.length
        }
        if last < ns.length { out.append(NSAttributedString(string: ns.substring(from: last), attributes: typingAttributes())) }
        return out
    }

    /// An inline chip as a one-character attributed run backed by an `InlineChipAttachment`.
    static func chipAttributed(_ att: ComposerAttachment) -> NSAttributedString {
        let attachment = InlineChipAttachment(attachId: att.id)
        let image = chipImage(for: att)
        attachment.image = image
        // Vertically center the chip on the text line.
        attachment.bounds = NSRect(x: 0, y: typingFont.descender - 4, width: image.size.width, height: image.size.height)
        return NSAttributedString(attachment: attachment)
    }

    /// Render a chip (thumbnail/glyph + filename) to an NSImage for the text attachment.
    static func chipImage(for att: ComposerAttachment) -> NSImage {
        let name = att.label
        let font = NSFont.systemFont(ofSize: 12, weight: .medium)
        let nameW = min(((name as NSString).size(withAttributes: [.font: font])).width, 150)
        let h: CGFloat = 22, pad: CGFloat = 5, gap: CGFloat = 5, thumb: CGFloat = 16
        let w = pad + thumb + gap + ceil(nameW) + pad + 2
        let img = NSImage(size: NSSize(width: w, height: h))
        img.lockFocus()
        let bg = NSBezierPath(roundedRect: NSRect(x: 0.5, y: 0.5, width: w - 1, height: h - 1), xRadius: 7, yRadius: 7)
        NSColor(Tok.fillTertiary).setFill(); bg.fill()
        NSColor(Tok.separator).setStroke(); bg.lineWidth = 1; bg.stroke()
        let thumbRect = NSRect(x: pad, y: (h - thumb) / 2, width: thumb, height: thumb)
        if att.kind == .image, let data = Data(base64Encoded: att.dataB64), let pic = NSImage(data: data) {
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(roundedRect: thumbRect, xRadius: 4, yRadius: 4).addClip()
            pic.draw(in: thumbRect, from: .zero, operation: .sourceOver, fraction: 1)
            NSGraphicsContext.restoreGraphicsState()
        } else if let glyph = NSImage(systemSymbolName: att.kind == .text ? "doc.text" : "doc", accessibilityDescription: nil) {
            glyph.isTemplate = true
            let tinted = NSImage(size: thumbRect.size)
            tinted.lockFocus()
            NSColor(att.kind == .text ? Tok.blue : Tok.purple).set()
            let gr = NSRect(origin: .zero, size: thumbRect.size).insetBy(dx: 1, dy: 1)
            glyph.draw(in: gr); gr.fill(using: .sourceAtop)
            tinted.unlockFocus()
            tinted.draw(in: thumbRect)
        }
        (name as NSString).draw(in: NSRect(x: pad + thumb + gap, y: (h - 15) / 2, width: nameW + 1, height: 15),
                                withAttributes: [.font: font, .foregroundColor: NSColor(Tok.ink)])
        img.unlockFocus()
        return img
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
        let width = proposal.width ?? 300
        // Measure with a THROWAWAY layout manager — never touch the live text view. Mutating its
        // container + forcing layout here invalidated layout, which made SwiftUI re-measure, which
        // mutated again → an infinite view-graph update loop (99% CPU hang).
        let inset = (scroll.documentView as? NSTextView)?.textContainerInset.height ?? 3
        let h = Self.measuredHeight(text, width: max(1, width)) + inset * 2
        return CGSize(width: width, height: min(max(h, minHeight), maxHeight))
    }

    /// Height of `s` laid out at `width`, using a standalone TextKit stack so the live editor's
    /// layout is never invalidated (which is what caused the infinite sizing loop).
    private static func measuredHeight(_ s: String, width: CGFloat) -> CGFloat {
        let storage = NSTextStorage(string: s.isEmpty ? " " : s,
                                    attributes: [.font: NSFont.systemFont(ofSize: 14)])
        let container = NSTextContainer(size: NSSize(width: width, height: CGFloat.greatestFiniteMagnitude))
        container.lineFragmentPadding = 0
        let layout = NSLayoutManager()
        layout.addTextContainer(container)
        storage.addLayoutManager(layout)
        layout.ensureLayout(for: container)
        return ceil(layout.usedRect(for: container).height)
    }

    final class Coord: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        init(_ p: ComposerTextView) { parent = p }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            parent.text = ComposerTextView.serialize(tv.textStorage)
        }

        /// Classify the general pasteboard (file URLs → files, raw image → image, long text → a text
        /// chip; short text → normal paste) and, when it's an attachment, insert an INLINE chip at the
        /// caret so the reference sits where the user pasted it.
        func handlePaste(_ tv: NSTextView?) -> Bool {
            let pb = NSPasteboard.general
            var atts: [ComposerAttachment] = []
            let urls = (pb.readObjects(forClasses: [NSURL.self],
                                       options: [.urlReadingFileURLsOnly: true]) as? [URL])?.filter { $0.isFileURL } ?? []
            if !urls.isEmpty {
                atts = urls.compactMap(composerAttachment(forFileURL:))
                if atts.isEmpty { return false }
            } else if let s = pb.string(forType: .string), !s.isEmpty {
                // Checked before image so rich text carrying an image flavor isn't misread as an image.
                if s.count > 1500 || s.components(separatedBy: "\n").count > 28 { atts = [.text(s)] }
                else { return false }   // short text → let the editor insert it normally
            } else if let img = NSImage(pasteboard: pb), let png = img.pngData(), png.count <= kMaxImageBytes {
                atts = [.image(png)]
            } else {
                return false
            }
            let accepted = parent.onAttach(atts)        // register payloads (honors the 8-cap)
            guard !accepted.isEmpty, let tv, let storage = tv.textStorage else { return true }
            let insertion = NSMutableAttributedString()
            for (i, att) in accepted.enumerated() {
                insertion.append(ComposerTextView.chipAttributed(att))
                insertion.append(NSAttributedString(string: i == accepted.count - 1 ? " " : "  ",
                                                    attributes: ComposerTextView.typingAttributes()))
            }
            let range = tv.selectedRange()
            storage.replaceCharacters(in: range, with: insertion)
            tv.setSelectedRange(NSRange(location: range.location + insertion.length, length: 0))
            tv.typingAttributes = ComposerTextView.typingAttributes()
            parent.text = ComposerTextView.serialize(storage)
            return true
        }
    }
}

/// A text attachment that remembers which composer attachment it stands for (so it serializes back
/// to `«attach:id»`).
final class InlineChipAttachment: NSTextAttachment {
    let attachId: String
    init(attachId: String) { self.attachId = attachId; super.init(data: nil, ofType: nil) }
    required init?(coder: NSCoder) { self.attachId = ""; super.init(coder: coder) }
}

// MARK: - Inline chip

/// An inline composer attachment chip (image thumbnail / doc glyph + label + remove ✕).
struct ComposerChip: View {
    let attachment: ComposerAttachment
    let onRemove: () -> Void
    @State private var hovering = false

    private var thumb: NSImage? {
        guard attachment.kind == .image, let data = Data(base64Encoded: attachment.dataB64) else { return nil }
        return NSImage(data: data)
    }
    private var glyph: String {
        switch attachment.kind { case .image: "image"; case .text: "doc"; case .file: "file" }
    }
    private var tint: Color {
        switch attachment.kind { case .image: Tok.green; case .text: Tok.blue; case .file: Tok.purple }
    }

    var body: some View {
        HStack(spacing: 7) {
            if let thumb {
                Image(nsImage: thumb).resizable().scaledToFill().frame(width: 24, height: 24)
                    .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            } else {
                Icon(name: glyph, size: 13).foregroundStyle(tint)
                    .frame(width: 24, height: 24).background(tint.opacity(0.16))
                    .clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
            }
            Text(attachment.label).font(TokFont.text(TokFont.caption, .medium)).foregroundStyle(Tok.ink)
                .lineLimit(1).frame(maxWidth: 150)
            Button(action: onRemove) {
                Icon(name: "x", size: 10).foregroundStyle(Tok.inkSecondary)
                    .frame(width: 16, height: 16).background(hovering ? Tok.fillSecondary : .clear).clipShape(Circle())
            }.buttonStyle(.plain)
        }
        .padding(.leading, 4).padding(.trailing, 5).padding(.vertical, 4)
        .background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        .onHover { hovering = $0 }
        .help(attachment.name)
    }
}
