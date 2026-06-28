import SwiftUI

/// One entry in the turn navigator.
struct MiniTurn: Identifiable, Equatable {
    let id: String
    let title: String
    let running: Bool
}

/// A right-edge turn navigator: a thin bar per turn; hovering the rail reveals a scrollable list of
/// turn titles; clicking a bar or row jumps to that turn (the host expands its window as needed).
/// Cheap — it only holds id + title per turn, never renders the heavy turn views.
struct TurnMinimap: View {
    let turns: [MiniTurn]
    let onJump: (String) -> Void

    @State private var expanded = false
    @State private var hoveredId: String?

    var body: some View {
        if turns.count >= 2 {
            HStack(alignment: .center, spacing: 8) {
                if expanded { listPanel.transition(.opacity.combined(with: .offset(x: 10))) }
                rail
            }
            .animation(.smooth(duration: 0.16), value: expanded)
            .onHover { expanded = $0 }
        }
    }

    // The always-visible thin bars.
    private var rail: some View {
        VStack(spacing: 3) {
            ForEach(turns) { t in
                Capsule()
                    .fill(barColor(t))
                    .frame(width: t.id == hoveredId ? 20 : (t.running ? 18 : 14), height: 2.5)
                    .contentShape(Rectangle().inset(by: -3))
                    .onHover { if $0 { hoveredId = t.id } }
                    .onTapGesture { onJump(t.id) }
                    .animation(.smooth(duration: 0.12), value: hoveredId)
            }
        }
        .padding(.vertical, 8).padding(.horizontal, 6)
        .background(expanded ? Tok.bgElevated.opacity(0.0) : .clear)
    }

    // The hover-revealed list of turn titles.
    private var listPanel: some View {
        ScrollView(showsIndicators: false) {
            VStack(spacing: 1) {
                ForEach(turns) { t in
                    Button { onJump(t.id) } label: {
                        HStack(spacing: 7) {
                            if t.running { Circle().fill(Tok.purple).frame(width: 5, height: 5) }
                            Text(t.title.isEmpty ? "Untitled" : t.title)
                                .font(TokFont.text(TokFont.caption, .medium))
                                .foregroundStyle(t.id == hoveredId ? Tok.ink : Tok.inkSecondary)
                                .lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 9).frame(height: 28)
                        .background(t.id == hoveredId ? Tok.fillSecondary : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .onHover { if $0 { hoveredId = t.id } }
                }
            }
            .padding(6)
        }
        .frame(width: 232).frame(maxHeight: 360)
        .background(Tok.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        .cardShadow()
    }

    private func barColor(_ t: MiniTurn) -> Color {
        if t.running { return Tok.purple }
        if t.id == hoveredId { return Tok.blue }
        return Tok.inkTertiary
    }
}
