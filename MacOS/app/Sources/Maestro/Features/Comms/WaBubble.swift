import SwiftUI
import AppKit

/// One WhatsApp message bubble. Outgoing = pale-green, right, tail top-right; incoming = elevated,
/// left, tail top-left. Group incoming shows the sender name. Ticks for outgoing delivery status.
struct WaBubble: View {
    let message: WaMessage
    var isGroup: Bool = false
    var onReact: (String) -> Void = { _ in }
    var onDownload: (() async -> WaMediaDownload?)? = nil

    @State private var hovering = false
    @State private var pickerOpen = false
    private static let quickEmoji = ["👍", "❤️", "😂", "😮", "😢", "🙏"]

    var body: some View {
        HStack(spacing: 6) {
            if message.fromMe { Spacer(minLength: 60); reactButton }
            VStack(alignment: message.fromMe ? .trailing : .leading, spacing: 2) {
                bubble
                if let rx = message.reactions, !rx.isEmpty { reactions(rx) }
            }
            if !message.fromMe { reactButton; Spacer(minLength: 60) }
        }
        .onHover { hovering = $0; if !$0 { pickerOpen = false } }
    }

    @ViewBuilder private var reactButton: some View {
        if message.msgId != nil {
            Button { pickerOpen.toggle() } label: {
                Icon(name: "spark", size: 13).foregroundStyle(Tok.inkTertiary)
                    .frame(width: 24, height: 24).background(Tok.fillSecondary).clipShape(Circle())
            }
            .buttonStyle(.plain).opacity(hovering ? 1 : 0)
            .popover(isPresented: $pickerOpen, arrowEdge: .bottom) {
                HStack(spacing: 4) {
                    ForEach(Self.quickEmoji, id: \.self) { e in
                        Button { onReact(e); pickerOpen = false } label: { Text(e).font(.system(size: 18)) }.buttonStyle(.plain)
                    }
                }.padding(8)
            }
        }
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            if isGroup && !message.fromMe, let s = message.senderName, !s.isEmpty {
                Text(s).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.blue)
            }
            if let q = message.quotedText, !q.isEmpty {
                Text(q).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary).lineLimit(2)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .overlay(alignment: .leading) { Tok.green.frame(width: 3) }
                    .background(Tok.fillSecondary).clipShape(RoundedRectangle(cornerRadius: 4))
                    .frame(maxWidth: 240, alignment: .leading)
            }
            if let media = message.media { MediaThumb(media: media, onDownload: onDownload) }
            if !message.text.isEmpty {
                Text(message.text).font(TokFont.text(14)).foregroundStyle(Tok.ink).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 4) {
                Spacer(minLength: 12)
                Text(WaFmt.msgTime(message.ts)).font(TokFont.text(10)).foregroundStyle(Tok.inkTertiary)
                if message.fromMe { ticks }
            }
        }
        .padding(EdgeInsets(top: 7, leading: 10, bottom: 5, trailing: 10))
        .background(message.fromMe ? Color.green.opacity(0.18) : Tok.bgElevated)
        .clipShape(BubbleShape(fromMe: message.fromMe))
        .overlay(BubbleShape(fromMe: message.fromMe).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        .frame(maxWidth: 460, alignment: message.fromMe ? .trailing : .leading)
    }

    @ViewBuilder private var ticks: some View {
        switch message.status {
        case "read": Text("✓✓").font(TokFont.text(10)).foregroundStyle(Tok.blue)
        case "delivered": Text("✓✓").font(TokFont.text(10)).foregroundStyle(Tok.inkTertiary)
        default: Text("✓").font(TokFont.text(10)).foregroundStyle(Tok.inkTertiary)
        }
    }

    private func reactions(_ rx: [WaReaction]) -> some View {
        HStack(spacing: 4) {
            ForEach(Array(rx.enumerated()), id: \.offset) { _, r in
                Text(r.emoji).font(.system(size: 12))
                    .padding(.horizontal, 5).padding(.vertical, 2).background(Tok.fillSecondary).clipShape(Capsule())
            }
        }
    }
}

/// Asymmetric bubble with a flat tail corner (top-right for mine, top-left for theirs).
struct BubbleShape: InsettableShape {
    var fromMe: Bool
    var inset: CGFloat = 0
    func inset(by amount: CGFloat) -> some InsettableShape { var s = self; s.inset += amount; return s }
    func path(in rect: CGRect) -> Path {
        let r = rect.insetBy(dx: inset, dy: inset)
        let big: CGFloat = 12, tail: CGFloat = 3
        return Path(roundedRect: r, cornerRadii: .init(
            topLeading: fromMe ? big : tail,
            bottomLeading: big,
            bottomTrailing: big,
            topTrailing: fromMe ? tail : big), style: .continuous)
    }
}

/// Inline media: image/sticker thumbnail (tap → full download); video/audio/document open externally.
struct MediaThumb: View {
    let media: WaMedia
    var onDownload: (() async -> WaMediaDownload?)? = nil
    @State private var fullImage: NSImage?
    @State private var busy = false

    var body: some View {
        switch media.kind {
        case "image", "sticker":
            Button { Task { await tapImage() } } label: {
                ZStack {
                    if let img = fullImage ?? decoded {
                        Image(nsImage: img).resizable().scaledToFill()
                            .frame(maxWidth: 260, maxHeight: 260).clipShape(RoundedRectangle(cornerRadius: 8))
                    } else { chip(icon: "spark", label: "Photo") }
                    if busy { Spinner(size: 18).tint(.white) }
                }
            }.buttonStyle(.plain)
        case "video": openable(icon: "play", label: media.seconds.map { "Video · \(dur($0))" } ?? "Video")
        case "audio": openable(icon: "play", label: "Voice message" + (media.seconds.map { " · \(dur($0))" } ?? ""))
        default: openable(icon: "folder", label: media.fileName ?? "Document")
        }
    }

    private func tapImage() async {
        guard fullImage == nil, let onDownload else { return }
        busy = true; defer { busy = false }
        if let dataUrl = (await onDownload())?.dataUrl, let img = MediaThumb.image(fromDataUrl: dataUrl) { fullImage = img }
    }

    private func openable(icon: String, label: String) -> some View {
        Button { Task { await openExternally() } } label: { chip(icon: busy ? "refresh" : icon, label: label) }.buttonStyle(.plain)
    }

    private func openExternally() async {
        guard let onDownload else { return }
        busy = true; defer { busy = false }
        guard let d = await onDownload(), let dataUrl = d.dataUrl, let comma = dataUrl.firstIndex(of: ","),
              let bytes = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...])) else { return }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(d.fileName ?? "wa-media-\(Int(Date().timeIntervalSince1970))")
        try? bytes.write(to: url)
        NSWorkspace.shared.open(url)
    }

    static func image(fromDataUrl s: String) -> NSImage? {
        guard let comma = s.firstIndex(of: ","), let data = Data(base64Encoded: String(s[s.index(after: comma)...])) else { return nil }
        return NSImage(data: data)
    }
    private var decoded: NSImage? {
        guard let b64 = media.thumbBase64, let data = Data(base64Encoded: b64) else { return nil }
        return NSImage(data: data)
    }
    private func chip(icon: String, label: String) -> some View {
        HStack(spacing: 8) {
            Icon(name: icon, size: 14).foregroundStyle(Tok.green)
            Text(label).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).lineLimit(1)
        }
        .padding(8).background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 8))
    }
    private func dur(_ s: Double) -> String { String(format: "%d:%02d", Int(s) / 60, Int(s) % 60) }
}
