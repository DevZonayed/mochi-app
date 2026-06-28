import SwiftUI

/// The list mode of the Scheduler: schedules grouped by project (colored dot + name + count),
/// each row a grid of [name + system badge | cron | next | delete + switch]. Mirrors Scheduler.tsx.
struct ScheduleListView: View {
    let store: ScheduleStore
    let projMeta: [String: SchedProjMeta]
    let onEdit: (Schedule) -> Void

    private var groups: [(projectId: String?, items: [Schedule])] {
        // Drop 'auto-continue' (the usage-reset resume — not usefully cancelable), like the web.
        store.byProject.compactMap { g in
            let items = g.items.filter { $0.kind != "auto-continue" }
            return items.isEmpty ? nil : (g.projectId, items)
        }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                if groups.isEmpty {
                    Text("Nothing scheduled yet. Create one with “New schedule”.")
                        .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                        .frame(maxWidth: .infinity).padding(.vertical, 40)
                }
                ForEach(groups, id: \.projectId) { group in
                    let meta = group.projectId.flatMap { projMeta[$0] }
                    let color = meta?.color ?? Tok.inkTertiary
                    VStack(alignment: .leading, spacing: 11) {
                        HStack(spacing: 8) {
                            Circle().fill(color).frame(width: 9, height: 9)
                            Text((meta?.name ?? "Workspace").uppercased())
                                .font(TokFont.text(TokFont.footnote, .bold)).tracking(0.4).foregroundStyle(Tok.inkSecondary)
                            Text("· \(group.items.count)").font(TokFont.text(TokFont.footnote, .medium)).foregroundStyle(Tok.inkTertiary)
                        }
                        .padding(.horizontal, 2)
                        VStack(spacing: 0) {
                            ForEach(Array(group.items.enumerated()), id: \.element.id) { i, s in
                                ScheduleRow(schedule: s, store: store, color: color, onEdit: onEdit, last: i == group.items.count - 1)
                            }
                        }
                        .background(Tok.bgGrouped)
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
                    }
                }
            }
            .frame(maxWidth: 920).frame(maxWidth: .infinity)
            .padding(.horizontal, 28).padding(.top, 4).padding(.bottom, 28)
        }
    }
}

/// One schedule row — countdown ticks once a second via TimelineView.
struct ScheduleRow: View {
    let schedule: Schedule
    let store: ScheduleStore
    let color: Color
    let onEdit: (Schedule) -> Void
    var last: Bool = false
    @State private var hover = false

    private var paused: Bool { !schedule.enabled }

    var body: some View {
        VStack(spacing: 0) {
            row
            if !last { Tok.separator.frame(height: Tok.hairline) }
        }
    }

    private var row: some View {
        HStack(spacing: 14) {
            // name + system badge
            HStack(spacing: 10) {
                Circle().fill(color).frame(width: 9, height: 9)
                Text(schedule.title.isEmpty ? "Untitled" : schedule.title)
                    .font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink).lineLimit(1)
                if let badge = schedule.systemBadge {
                    HStack(spacing: 4) {
                        Icon(name: badge.icon, size: 10)
                        Text(badge.label.uppercased()).font(TokFont.text(9, .bold)).tracking(0.4)
                    }
                    .foregroundStyle(Tok.purple).padding(.horizontal, 7).frame(height: 18)
                    .background(Tok.purple.opacity(0.12)).clipShape(Capsule())
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading).layoutPriority(2)

            Text(schedule.cronLine).font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary)
                .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading).layoutPriority(1)

            TimelineView(.periodic(from: .now, by: 1)) { _ in
                Text(nextDisplay).font(TokFont.mono(TokFont.footnote, .semibold))
                    .foregroundStyle(paused ? Tok.inkTertiary : Tok.ink).frame(width: 92, alignment: .trailing)
            }

            HStack(spacing: 8) {
                Button { Task { await store.delete(schedule.id) } } label: {
                    Icon(name: "x", size: 14).foregroundStyle(hover ? Tok.red : Tok.inkTertiary)
                        .frame(width: 24, height: 24).background(hover ? Tok.red.opacity(0.12) : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                }.buttonStyle(.plain).opacity(hover ? 1 : 0.55).help("Remove schedule")
                MSwitch(on: Binding(get: { schedule.enabled }, set: { v in Task { await store.setEnabled(schedule, v) } })).scaleEffect(0.7)
            }
            .frame(width: 96, alignment: .trailing)
        }
        .padding(.horizontal, 16).padding(.vertical, 13)
        .opacity(paused ? 0.6 : 1)
        .background(hover ? Tok.fillTertiary : .clear)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .onTapGesture { if schedule.isEditable { onEdit(schedule) } }
    }

    /// Live "next" — "—" / "due now" / "in 5m".
    private var nextDisplay: String {
        guard schedule.enabled else { return "—" }
        let n = nextLine(schedule.nextFireAt)
        return n == "—" || n == "due now" ? n : "in \(n)"
    }
}

/// A small status dot that gently breathes when its schedule is about to fire (used by the inline
/// composer queue panel too).
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
