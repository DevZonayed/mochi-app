import SwiftUI

/// Chat composer: input + a controls row (model · effort · Plan/Goal) + send FAB (red stop while
/// streaming). Enter sends, Shift+Enter newlines, ⌘↵ sends.
struct Composer: View {
    @Binding var text: String
    @Binding var attachments: [ComposerAttachment]
    @Binding var model: String
    @Binding var effort: String
    @Binding var plan: Bool
    @Binding var goal: Bool
    @Binding var autopilot: Bool
    @Binding var review: Bool
    /// Reviewer model picker key ("<provider>:<model>"). Shown next to the Review pill when
    /// Review is on — the Review toggle owns whether the reviewer runs, this owns which model.
    @Binding var reviewerKey: String
    var sessionActive: Bool = false
    var streaming: Bool
    var disabled: Bool
    let onSend: () -> Void
    let onStop: () -> Void
    /// ⌘↩ while a turn is running — interrupt and steer (set by Issue 4). Falls back to a normal send.
    var onSendNow: (() -> Void)? = nil
    /// When set, the composer shows a clock button that schedules the typed message for later.
    var onSchedule: ((ScheduleRequest) -> Void)? = nil
    /// Number of messages queued behind the running turn (Issue 4) — shown in the footer hint.
    var queuedCount: Int = 0
    /// Fired ONLY on a user tap of the Review / Autopilot pills (never on programmatic restore),
    /// so switching sessions can sync the toggles to the session without writing back to the brain.
    var onReviewChanged: (Bool) -> Void = { _ in }
    var onAutopilotChanged: (Bool) -> Void = { _ in }

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
                    ComposerTextView(text: $text, disabled: disabled,
                                     attachmentsById: Dictionary(attachments.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }),
                                     onReturn: { send() }, onCommandReturn: { sendNow() },
                                     onAttach: addAttachments)
                        .frame(minHeight: 22)
                        .padding(.horizontal, 4).padding(.vertical, 6)
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
            togglePill("Autopilot", "bolt", Tok.green, on: autopilot, disabled: !sessionActive) { autopilot.toggle(); onAutopilotChanged(autopilot) }
            togglePill("Review", "check", Tok.orange, on: review, disabled: !sessionActive) { review.toggle(); onReviewChanged(review) }
            if review {
                ModelPicker(value: $reviewerKey, compact: true, triggerLabel: "Reviews:")
                    .help("Which model reviews this chat's changes while Review is on")
            }

            if onSchedule != nil { scheduleButton }

            Spacer()
            Text(footerHint).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
        }
    }

    private var footerHint: String {
        if streaming { return queuedCount > 0 ? "\(queuedCount) queued · ⏎ to queue · ⌘⏎ to steer" : "⏎ to queue · ⌘⏎ to steer" }
        return queuedCount > 0 ? "\(queuedCount) queued" : "⏎ to send"
    }

    /// Register pasted attachments (honoring the cap) and return the accepted slice so the editor
    /// inserts an inline chip only for those.
    private func addAttachments(_ atts: [ComposerAttachment]) -> [ComposerAttachment] {
        let room = kMaxComposerAttachments - attachments.count
        guard room > 0 else { return [] }
        let accepted = Array(atts.prefix(room))
        attachments.append(contentsOf: accepted)
        return accepted
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
    private var canSend: Bool { !disabled && (!text.trimmed.isEmpty || !attachments.isEmpty) }
    private func send() { guard canSend else { return }; onSend() }
    private func sendNow() { guard canSend else { return }; (onSendNow ?? onSend)() }

    private func fab(icon: String, color: Color, fg: Color = .white, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name: icon, size: 15, weight: .semibold).foregroundStyle(fg)
                .frame(width: 34, height: 34).background(color).clipShape(Circle())
        }.pressable(scale: 0.9)
    }
}
