import SwiftUI
import AppKit

/// Settings → Notifications: device-local sound prefs (master switch, per-event sound + preview,
/// volume, focus gate). Mirrors the web Notifications pane; persisted in UserDefaults, sounds via
/// NSSound. (Notifications "play on this device", so they're local, not brain settings.)
struct NotificationsPane: View {
    @AppStorage("maestro.notif.enabled") private var enabled = true
    @AppStorage("maestro.notif.onComplete") private var onComplete = true
    @AppStorage("maestro.notif.completeSound") private var completeSound = "chime"
    @AppStorage("maestro.notif.onAttention") private var onAttention = true
    @AppStorage("maestro.notif.attentionSound") private var attentionSound = "ping"
    @AppStorage("maestro.notif.volume") private var volume = 0.7
    @AppStorage("maestro.notif.onlyWhenUnfocused") private var onlyWhenUnfocused = false

    static let soundOptions: [(value: String, label: String)] = [
        ("chime", "Chime"), ("ping", "Ping"), ("marimba", "Marimba"), ("glass", "Glass"), ("pop", "Pop"), ("none", "None (silent)"),
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            PaneHead(title: "Notifications", sub: "Hear a sound when an agent finishes a response or a chat needs your attention. Sounds play on this device.")

            GroupedList {
                toggleRow("Play notification sounds", sub: "The master switch for every chime below.", $enabled, last: true)
            }
            GroupedList(header: "When a response completes", footer: "Plays once an agent finishes its turn.") {
                toggleRow("Play a sound", $onComplete)
                soundRow($completeSound, disabled: !enabled || !onComplete, last: true)
            }
            GroupedList(header: "When a chat needs attention", footer: "An approval gate is waiting, or a job failed.") {
                toggleRow("Play a sound", $onAttention)
                soundRow($attentionSound, disabled: !enabled || !onAttention, last: true)
            }
            GroupedList(header: "Output") {
                GLRow {
                    Text("Volume").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                    Spacer()
                    Slider(value: $volume, in: 0...1).frame(width: 180).tint(Tok.blue)
                    Text("\(Int((volume * 100).rounded()))%").font(TokFont.mono(TokFont.footnote)).foregroundStyle(Tok.inkTertiary).frame(width: 40, alignment: .trailing)
                }
                toggleRow("Only when Maestro isn't focused",
                          sub: "Stay quiet while you're actively watching; chime only when the window is in the background.",
                          $onlyWhenUnfocused, last: true)
            }
        }
    }

    private func toggleRow(_ label: String, sub: String? = nil, _ on: Binding<Bool>, last: Bool = false) -> some View {
        GLRow(last: last) {
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                if let sub { Text(sub).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary).fixedSize(horizontal: false, vertical: true) }
            }
            Spacer()
            MSwitch(on: on).scaleEffect(0.78)
        }
    }

    private func soundRow(_ value: Binding<String>, disabled: Bool, last: Bool) -> some View {
        GLRow(last: last) {
            Text("Sound").font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
            Spacer()
            Menu {
                ForEach(Self.soundOptions, id: \.value) { o in Button(o.label) { value.wrappedValue = o.value } }
            } label: {
                HStack(spacing: 6) {
                    Text(Self.soundOptions.first { $0.value == value.wrappedValue }?.label ?? "Chime")
                        .font(TokFont.text(TokFont.footnote, .medium)).foregroundStyle(Tok.ink)
                    Icon(name: "chevronDown", size: 10).foregroundStyle(Tok.inkSecondary)
                }
                .padding(.horizontal, 11).frame(height: 28)
                .background(Tok.bgGrouped).clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            Button { Self.preview(value.wrappedValue, volume: volume) } label: {
                Icon(name: "play", size: 12).foregroundStyle(Tok.inkSecondary).frame(width: 28, height: 28)
                    .background(Tok.fillSecondary).clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            }.buttonStyle(.plain).help("Play test sound")
        }
        .opacity(disabled ? 0.5 : 1).disabled(disabled)
    }

    /// Map the app's sound names to the closest macOS system sounds for preview/notification.
    static func preview(_ sound: String, volume: Double) {
        guard sound != "none", volume > 0 else { return }
        let name: String
        switch sound {
        case "chime": name = "Glass"
        case "ping": name = "Ping"
        case "marimba": name = "Hero"
        case "glass": name = "Glass"
        case "pop": name = "Pop"
        default: name = "Glass"
        }
        if let s = NSSound(named: NSSound.Name(name)) { s.volume = Float(volume); s.play() }
    }
}
