import SwiftUI

/// Chat composer: input + a controls row (model · effort · Plan/Goal) + send FAB (red stop while
/// streaming). Enter sends, Shift+Enter newlines, ⌘↵ sends.
struct Composer: View {
    @Binding var text: String
    @Binding var model: String
    @Binding var effort: String
    @Binding var plan: Bool
    @Binding var goal: Bool
    var streaming: Bool
    var disabled: Bool
    let onSend: () -> Void
    let onStop: () -> Void

    @FocusState private var focused: Bool

    static let models: [(id: String, name: String)] = [
        ("auto", "Auto"), ("claude:opus", "Claude · Opus"), ("claude:sonnet", "Claude · Sonnet"),
        ("claude:haiku", "Claude · Haiku"), ("codex", "Codex"),
    ]
    static let efforts = ["fast", "balanced", "deep", "max"]

    var body: some View {
        VStack(spacing: 6) {
            HStack(alignment: .bottom, spacing: 10) {
                ZStack(alignment: .topLeading) {
                    if text.isEmpty {
                        Text(disabled ? "Open a project to chat" : "Send a message…")
                            .font(TokFont.text(14)).foregroundStyle(Tok.inkTertiary)
                            .padding(.horizontal, 4).padding(.vertical, 8).allowsHitTesting(false)
                    }
                    TextField("", text: $text, axis: .vertical)
                        .textFieldStyle(.plain).font(TokFont.text(14)).foregroundStyle(Tok.ink)
                        .lineLimit(1...10).padding(.horizontal, 4).padding(.vertical, 8)
                        .focused($focused).disabled(disabled)
                        .onKeyPress { press in
                            guard press.key == .return else { return .ignored }
                            if press.modifiers.contains(.shift) { return .ignored }
                            send(); return .handled
                        }
                }
                if streaming { fab(icon: "square", color: Tok.red, action: onStop) }
                fab(icon: "send", color: canSend ? Tok.blue : Tok.fillSecondary, fg: canSend ? .white : Tok.inkTertiary) { send() }
                    .disabled(!canSend)
            }
            controlsRow
        }
        .padding(EdgeInsets(top: 10, leading: 14, bottom: 8, trailing: 10))
        .background(Tok.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(effortAccent.opacity(0.5), lineWidth: 1))
        .cardShadow()
        .keyboardShortcut(.return, modifiers: .command)
    }

    private var controlsRow: some View {
        HStack(spacing: 6) {
            Menu {
                ForEach(Self.models, id: \.id) { m in Button(m.name) { model = m.id } }
            } label: {
                HStack(spacing: 5) {
                    Text(Self.models.first { $0.id == model }?.name ?? "Auto").font(TokFont.text(TokFont.caption, .semibold))
                    Icon(name: "chevronDown", size: 10)
                }
                .foregroundStyle(Tok.inkSecondary).padding(.horizontal, 9).frame(height: 28)
                .background(Tok.fillSecondary).clipShape(RoundedRectangle(cornerRadius: 8))
            }.menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()

            Button { cycleEffort() } label: {
                HStack(spacing: 5) {
                    Text(effort.uppercased()).font(TokFont.text(10, .bold)).tracking(0.5)
                    HStack(spacing: 2) { ForEach(0..<4) { i in Capsule().fill(i <= effortIndex ? effortAccent : Tok.inkTertiary.opacity(0.4)).frame(width: 3, height: 9) } }
                }
                .foregroundStyle(effortAccent).padding(.horizontal, 9).frame(height: 28)
                .background(effortAccent.opacity(0.12)).clipShape(RoundedRectangle(cornerRadius: 8))
            }.buttonStyle(.plain)

            togglePill("Plan", "spark", Tok.blue, on: plan) { plan.toggle(); if plan { goal = false } }
            togglePill("Goal", "target", Tok.purple, on: goal) { goal.toggle(); if goal { plan = false } }

            Spacer()
            Text(streaming ? "running…" : "⏎ to send").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
        }
    }

    private func togglePill(_ label: String, _ icon: String, _ tint: Color, on: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) { Icon(name: icon, size: 12); Text(label).font(TokFont.text(TokFont.caption, .semibold)) }
                .foregroundStyle(on ? tint : Tok.inkSecondary).padding(.horizontal, 9).frame(height: 28)
                .background(on ? tint.opacity(0.14) : Tok.fillSecondary).clipShape(RoundedRectangle(cornerRadius: 8))
        }.buttonStyle(.plain)
    }

    private var effortIndex: Int { Self.efforts.firstIndex(of: effort) ?? 1 }
    private var effortAccent: Color { [Tok.green, Tok.blue, Tok.orange, Tok.red][effortIndex] }
    private func cycleEffort() { effort = Self.efforts[(effortIndex + 1) % 4] }
    private var canSend: Bool { !disabled && !text.trimmed.isEmpty }
    private func send() { guard canSend else { return }; onSend() }

    private func fab(icon: String, color: Color, fg: Color = .white, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name: icon, size: 16, weight: .semibold).foregroundStyle(fg)
                .frame(width: 38, height: 38).background(color).clipShape(Circle())
        }.buttonStyle(.plain)
    }
}
