import SwiftUI
import AppKit

// MARK: - Interaction feedback (hover + press) — the "click feel" the plain style lacks.

/// A small "Copy"→"Copied ✓" chip (caption 600, inkTertiary → green for 1.3s). Used by code-card
/// headers and the per-turn copy button. Mirrors the web `CopyButton`.
struct CopyChip: View {
    let text: String
    var label: String = "Copy"
    var hoverOnly: Bool = false
    @State private var copied = false
    @State private var hovering = false
    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.3) { copied = false }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.system(size: 10, weight: .semibold))
                Text(copied ? "Copied" : label).font(TokFont.text(TokFont.caption, .semibold))
            }
            .foregroundStyle(copied ? Tok.green : Tok.inkTertiary)
            .padding(.horizontal, 7).frame(height: 22)
            .background(hovering ? Tok.fillTertiary : .clear, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            .opacity(hoverOnly && !hovering && !copied ? 0 : 1)
        }
        .buttonStyle(.plain).pressable(scale: 0.95)
        .onHover { hovering = $0 }
    }
}

/// A blinking purple caret appended after live-streaming text (mirrors `.chat-caret`).
struct StreamCaret: View {
    var height: CGFloat = 15
    @State private var on = true
    var body: some View {
        RoundedRectangle(cornerRadius: 1.5, style: .continuous)
            .fill(Tok.purple)
            .frame(width: 7, height: height)
            .opacity(on ? 1 : 0)
            .onAppear { withAnimation(.linear(duration: 0.53).repeatForever(autoreverses: true)) { on = false } }
    }
}

/// Shimmering single-line text used for the live-activity heartbeat (mirrors `.think-shimmer`).
struct ShimmerText: View {
    let text: String
    var size: CGFloat = 13.5
    @State private var phase: CGFloat = -1
    var body: some View {
        Text(text)
            .font(.system(size: size, weight: .medium))
            .foregroundStyle(Tok.inkSecondary)
            // Single-line, vertically-locked: the heartbeat string changes on every streaming
            // tick — if it can wrap, its height wobbles, and at the bottom of a transcript that
            // re-triggers `.defaultScrollAnchor(.bottom)` re-pinning → a visible scroll shake.
            .lineLimit(1)
            .truncationMode(.tail)
            .fixedSize(horizontal: false, vertical: true)
            .overlay(
                GeometryReader { geo in
                    LinearGradient(colors: [.clear, Tok.ink.opacity(0.9), .clear],
                                   startPoint: .leading, endPoint: .trailing)
                        .frame(width: geo.size.width * 0.5)
                        .offset(x: phase * geo.size.width * 1.5)
                        .blendMode(.plusLighter)
                }
                .mask(Text(text).font(.system(size: size, weight: .medium)).lineLimit(1))
                .allowsHitTesting(false)
                .clipped()
            )
            .onAppear { withAnimation(.linear(duration: 1.5).repeatForever(autoreverses: false)) { phase = 1 } }
    }
}

/// Press = quick scale + dim, spring-animated. Apply with `.pressable()`.
struct PressableButtonStyle: ButtonStyle {
    var scale: CGFloat = 0.96
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .opacity(configuration.isPressed ? 0.78 : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.55), value: configuration.isPressed)
            .contentShape(Rectangle())
    }
}

extension View {
    func pressable(scale: CGFloat = 0.96) -> some View { buttonStyle(PressableButtonStyle(scale: scale)) }

    /// Animated hover background fill (e.g. nav items, tabs, rows).
    func hoverFill(_ color: Color = Tok.fillTertiary, radius: CGFloat = 8) -> some View {
        modifier(HoverFill(color: color, radius: radius))
    }
}

struct HoverFill: ViewModifier {
    let color: Color; let radius: CGFloat
    @State private var hovering = false
    func body(content: Content) -> some View {
        content
            .background(hovering ? color : .clear, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .animation(.easeOut(duration: 0.12), value: hovering)
            .onHover { hovering = $0 }
    }
}

// Shared SwiftUI primitives ported from src/lib/ui.tsx. Reused across every screen.

/// Primary/quiet/plain pill button.
struct PillButton: View {
    enum Kind { case primary, quiet, plain }
    let title: String
    var icon: String? = nil
    var kind: Kind = .primary
    var disabled: Bool = false
    var busy: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if busy { Spinner(size: 12).foregroundStyle(fg) }
                else if let icon { Icon(name: icon, size: 14, weight: .semibold) }
                Text(title).font(TokFont.text(TokFont.subhead, .semibold))
            }
            .foregroundStyle(fg)
            .padding(.horizontal, kind == .quiet ? 11 : 14)
            .frame(height: kind == .quiet ? 30 : 34)
            .background(bg)
            .clipShape(RoundedRectangle(cornerRadius: Tok.Radius.pill, style: .continuous))
        }
        .pressable()
        .disabled(disabled || busy)
        .opacity(disabled ? 0.6 : 1)
    }

    private var fg: Color {
        switch kind {
        case .primary: return .white
        case .quiet: return Tok.blue
        case .plain: return Tok.ink
        }
    }
    private var bg: Color {
        switch kind {
        case .primary: return disabled ? Tok.fillSecondary : Tok.blue
        case .quiet: return .clear
        case .plain: return Tok.fillSecondary
        }
    }
}

/// A 34×34 (configurable) frosted icon button (top-bar / panel actions).
struct IconButton: View {
    let icon: String
    var size: CGFloat = 34
    var iconSize: CGFloat = 18
    var tint: Color = Tok.inkSecondary
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Icon(name: icon, size: iconSize).foregroundStyle(tint)
                .frame(width: size, height: size)
                .hoverFill(Tok.fillSecondary, radius: 8)
                .contentShape(Rectangle())
        }
        .pressable()
    }
}

/// iOS-style segmented control with a sliding indicator.
struct SegmentedControl<T: Hashable>: View {
    let options: [(value: T, label: String, icon: String?)]
    @Binding var value: T
    var segWidth: CGFloat = 0 // 0 = content width

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options.indices, id: \.self) { i in
                let opt = options[i]
                let active = opt.value == value
                Button { value = opt.value } label: {
                    HStack(spacing: 6) {
                        if let i = opt.icon { Icon(name: i, size: 14) }
                        Text(opt.label).font(TokFont.text(TokFont.subhead, .semibold))
                    }
                    .foregroundStyle(active ? Tok.ink : Tok.inkSecondary)
                    .padding(.horizontal, 14).padding(.vertical, 6)
                    .frame(width: segWidth > 0 ? segWidth : nil)
                    .background(
                        active
                        ? RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Tok.bgElevated)
                            .shadow(color: .black.opacity(0.14), radius: 1.5, y: 1)
                        : nil
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(2)
        .background(Tok.fillSecondary)
        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .animation(.spring(response: 0.32, dampingFraction: 0.85), value: value)
    }
}

/// iOS toggle.
struct MSwitch: View {
    @Binding var on: Bool
    var body: some View {
        Button { on.toggle() } label: {
            ZStack(alignment: on ? .trailing : .leading) {
                Capsule().fill(on ? Tok.green : Tok.fillSecondary).frame(width: 51, height: 31)
                Circle().fill(.white).frame(width: 27, height: 27)
                    .shadow(color: .black.opacity(0.25), radius: 2, y: 1).padding(2)
            }
        }
        .buttonStyle(.plain)
        .animation(.spring(response: 0.3, dampingFraction: 0.7), value: on)
    }
}

/// Indeterminate spinner.
struct Spinner: View {
    var size: CGFloat = 16
    @State private var spin = false
    var body: some View {
        Circle()
            .trim(from: 0, to: 0.75)
            .stroke(.tint, style: StrokeStyle(lineWidth: max(1.5, size / 9), lineCap: .round))
            .frame(width: size, height: size)
            .rotationEffect(.degrees(spin ? 360 : 0))
            .onAppear { withAnimation(.linear(duration: 0.7).repeatForever(autoreverses: false)) { spin = true } }
    }
}

/// iOS grouped-inset list container.
struct GroupedList<Content: View>: View {
    var header: String? = nil
    var footer: String? = nil
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let header {
                Text(header.uppercased())
                    .font(TokFont.text(TokFont.caption, .semibold))
                    .tracking(0.5).foregroundStyle(Tok.inkTertiary)
                    .padding(.horizontal, 14).padding(.bottom, 7)
            }
            VStack(spacing: 0) { content }
                .background(Tok.bgGrouped)
                .clipShape(RoundedRectangle(cornerRadius: Tok.Radius.group, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Tok.Radius.group, style: .continuous)
                    .strokeBorder(Tok.separator, lineWidth: Tok.hairline))
            if let footer {
                Text(footer).font(TokFont.text(TokFont.footnote))
                    .foregroundStyle(Tok.inkSecondary).padding(.horizontal, 14).padding(.top, 8)
            }
        }
    }
}

/// One row inside a GroupedList (56pt min height + hairline divider handled by caller).
struct GLRow<Content: View>: View {
    var last: Bool = false
    @ViewBuilder var content: Content
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) { content }
                .padding(.horizontal, 14).padding(.vertical, 10)
                .frame(minHeight: 56)
            if !last { Tok.separator.frame(height: Tok.hairline).padding(.leading, 14) }
        }
    }
}
