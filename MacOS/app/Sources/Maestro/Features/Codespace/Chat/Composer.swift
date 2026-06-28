import SwiftUI

/// Chat composer: input + a controls row (model · effort · Plan/Goal) + send FAB (red stop while
/// streaming). Enter sends, Shift+Enter newlines, ⌘↵ sends.
struct Composer: View {
    @Binding var text: String
    @Binding var model: String
    @Binding var effort: String
    @Binding var plan: Bool
    @Binding var goal: Bool
    @Binding var autopilot: Bool
    @Binding var review: Bool
    var sessionActive: Bool = false
    var streaming: Bool
    var disabled: Bool
    let onSend: () -> Void
    let onStop: () -> Void
    /// When set, the composer shows a clock button that schedules the typed message for later.
    var onSchedule: ((ScheduleRequest) -> Void)? = nil

    @FocusState private var focused: Bool
    @State private var schedOpen = false

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
                // Drag a file from the file tree → drop it here to add an @-reference.
                .dropDestination(for: String.self) { items, _ in
                    let refs = items.filter { $0.hasPrefix("/") || $0.hasPrefix("~") }.map { "@" + $0 }
                    guard !refs.isEmpty else { return false }
                    text += (text.isEmpty || text.hasSuffix(" ") ? "" : " ") + refs.joined(separator: " ") + " "
                    return true
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
            ModelPicker(value: $model, compact: true)

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
            togglePill("Autopilot", "bolt", Tok.green, on: autopilot, disabled: !sessionActive) { autopilot.toggle() }
            togglePill("Review", "check", Tok.orange, on: review, disabled: !sessionActive) { review.toggle() }

            if onSchedule != nil { scheduleButton }

            Spacer()
            Text(streaming ? "running…" : "⏎ to send").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
        }
    }

    private func togglePill(_ label: String, _ icon: String, _ tint: Color, on: Bool, disabled: Bool = false, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) { Icon(name: icon, size: 11); Text(label).font(TokFont.text(TokFont.caption, .semibold)) }
                .foregroundStyle(on ? tint : Tok.inkSecondary).padding(.horizontal, 8).frame(height: 26)
                .background(on ? tint.opacity(0.16) : Tok.fillSecondary).clipShape(RoundedRectangle(cornerRadius: 7))
        }.pressable().disabled(disabled).opacity(disabled ? 0.45 : 1)
        .help(disabled ? "Available once the chat has started" : label)
    }

    private var scheduleButton: some View {
        Button { schedOpen.toggle() } label: {
            HStack(spacing: 4) {
                Icon(name: "clock", size: 11)
                Text("Schedule").font(TokFont.text(TokFont.caption, .semibold))
            }
            .foregroundStyle(schedOpen ? Tok.blue : Tok.inkSecondary).padding(.horizontal, 8).frame(height: 26)
            .background(schedOpen ? Tok.blue.opacity(0.14) : Tok.fillSecondary)
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay(RoundedRectangle(cornerRadius: 7).strokeBorder(schedOpen ? Tok.blue.opacity(0.45) : .clear, lineWidth: 1))
        }
        .pressable().disabled(!canSend).opacity(canSend ? 1 : 0.45)
        .help(canSend ? "Schedule this message to send later" : "Type a message to schedule it")
        .popover(isPresented: $schedOpen, arrowEdge: .top) {
            SchedulePicker { req in schedOpen = false; onSchedule?(req) }
        }
    }

    private var effortIndex: Int { Self.efforts.firstIndex(of: effort) ?? 1 }
    private var effortAccent: Color { [Tok.green, Tok.blue, Tok.orange, Tok.red][effortIndex] }
    private func cycleEffort() { effort = Self.efforts[(effortIndex + 1) % 4] }
    private var canSend: Bool { !disabled && !text.trimmed.isEmpty }
    private func send() { guard canSend else { return }; onSend() }

    private func fab(icon: String, color: Color, fg: Color = .white, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name: icon, size: 15, weight: .semibold).foregroundStyle(fg)
                .frame(width: 34, height: 34).background(color).clipShape(Circle())
        }.pressable(scale: 0.9)
    }
}
