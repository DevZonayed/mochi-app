import SwiftUI

/// The list mode of the Schedule screen: schedules grouped by project, each row with a live
/// countdown, enable toggle (recurring user schedules), edit, and delete.
struct ScheduleListView: View {
    let store: ScheduleStore
    let projectNames: [String: String]
    let onEdit: (Schedule) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                ForEach(store.byProject, id: \.projectId) { group in
                    VStack(alignment: .leading, spacing: 0) {
                        Text((group.projectId.flatMap { projectNames[$0] } ?? "No project").uppercased())
                            .font(TokFont.text(TokFont.caption, .semibold)).tracking(0.5)
                            .foregroundStyle(Tok.inkTertiary)
                            .padding(.horizontal, 14).padding(.bottom, 7)
                        VStack(spacing: 0) {
                            ForEach(Array(group.items.enumerated()), id: \.element.id) { i, s in
                                ScheduleRow(schedule: s, store: store, onEdit: onEdit, last: i == group.items.count - 1)
                            }
                        }
                        .background(Tok.bgGrouped)
                        .clipShape(RoundedRectangle(cornerRadius: Tok.Radius.group, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Tok.Radius.group, style: .continuous)
                            .strokeBorder(Tok.separator, lineWidth: Tok.hairline))
                    }
                }
            }
            .frame(maxWidth: 920).frame(maxWidth: .infinity)
            .padding(.horizontal, 24).padding(.vertical, 22)
        }
    }
}

/// A single schedule row — its countdown ticks once a second via `TimelineView`.
struct ScheduleRow: View {
    let schedule: Schedule
    let store: ScheduleStore
    let onEdit: (Schedule) -> Void
    var last: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            TimelineView(.periodic(from: .now, by: 1)) { ctx in
                row(now: ctx.date.timeIntervalSince1970 * 1000)
            }
            if !last { Tok.separator.frame(height: Tok.hairline).padding(.leading, 14) }
        }
    }

    private func row(now: Double) -> some View {
        let next = schedule.nextFireAt
        let left = (next ?? 0) - now
        let soon = next != nil && schedule.enabled && left <= 60_000 && left > -90_000
        return HStack(spacing: 12) {
            BreathingDot(color: schedule.kindTint, active: soon)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if let badge = schedule.kindBadge { KindBadge(text: badge, tint: schedule.kindTint) }
                    Text(schedule.title.isEmpty ? "Untitled" : schedule.title)
                        .font(TokFont.text(TokFont.footnote, .medium)).foregroundStyle(Tok.ink).lineLimit(1)
                }
                Text(detailLine).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).lineLimit(1)
            }
            Spacer(minLength: 8)
            countdown(next: next, left: left, soon: soon)
            if schedule.isEditable && schedule.isRecurring {
                MSwitch(on: Binding(get: { schedule.enabled },
                                    set: { v in Task { await store.setEnabled(schedule, v) } }))
                    .scaleEffect(0.78)
            }
            if schedule.isEditable { rowButton("pencil") { onEdit(schedule) } }
            rowButton("trash", tint: Tok.red) { Task { await store.delete(schedule.id) } }
        }
        .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 56)
    }

    @ViewBuilder private func countdown(next: Double?, left: Double, soon: Bool) -> some View {
        if next != nil && schedule.enabled {
            Text(fmtCountdown(left)).font(TokFont.mono(TokFont.footnote, .semibold))
                .foregroundStyle(soon ? Tok.orange : schedule.kindTint)
                .frame(minWidth: 74, alignment: .trailing)
        } else {
            Text(schedule.paused == true ? "Paused" : "Off")
                .font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.inkTertiary)
                .frame(minWidth: 74, alignment: .trailing)
        }
    }

    private var detailLine: String {
        if schedule.isOneShot, let f = schedule.fireAt { return fmtWhen(f) }
        var s = schedule.recurrenceLabel
        if let n = schedule.nextRun, schedule.enabled { s += " · next \(fmtWhen(n))" }
        return s
    }

    private func rowButton(_ icon: String, tint: Color = Tok.inkSecondary, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name: icon, size: 14).foregroundStyle(tint)
                .frame(width: 26, height: 26).hoverFill(Tok.fillSecondary, radius: 7).contentShape(Rectangle())
        }.pressable()
    }
}

/// A small status dot that gently breathes when its schedule is about to fire.
struct BreathingDot: View {
    let color: Color
    var active: Bool = false
    var size: CGFloat = 7
    @State private var pulse = false

    var body: some View {
        Circle().fill(color).frame(width: size, height: size)
            .scaleEffect(active && pulse ? 1.4 : 1)
            .opacity(active && pulse ? 0.45 : 1)
            .animation(active ? .easeInOut(duration: 0.9).repeatForever(autoreverses: true) : .default, value: pulse)
            .onAppear { pulse = true }
    }
}

/// Uppercase pill badge for system schedule kinds (auto-continue, etc.).
struct KindBadge: View {
    let text: String
    let tint: Color
    var body: some View {
        Text(text).font(TokFont.text(9, .bold)).tracking(0.4).foregroundStyle(tint)
            .padding(.horizontal, 6).frame(height: 16)
            .background(tint.opacity(0.15)).clipShape(RoundedRectangle(cornerRadius: 5, style: .continuous))
    }
}
