import SwiftUI

/// The collapsible "N scheduled message(s)" panel above the composer — the queued one-shot
/// messages waiting to fire into the current chat, each with a live countdown, edit (refill the
/// composer), and cancel.
struct ScheduledQueuePanel: View {
    let store: ScheduleStore
    let sessionId: String?
    /// Edit = bring the message back to the composer (host refills the text and drops the queued row).
    let onEdit: (Schedule) -> Void

    @State private var expanded = true

    var body: some View {
        let items = store.pending(forSession: sessionId)
        if !items.isEmpty {
            VStack(spacing: 0) {
                Button {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) { expanded.toggle() }
                } label: {
                    HStack(spacing: 8) {
                        Icon(name: "clock", size: 13).foregroundStyle(Tok.blue)
                        Text("\(items.count) scheduled message\(items.count == 1 ? "" : "s")")
                            .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink)
                        Spacer()
                        Icon(name: "chevronRight", size: 11).foregroundStyle(Tok.inkTertiary)
                            .rotationEffect(.degrees(expanded ? 90 : 0))
                    }
                    .padding(.horizontal, 12).padding(.vertical, 9).contentShape(Rectangle())
                }.buttonStyle(.plain)

                if expanded {
                    ForEach(items) { s in QueueRow(schedule: s, store: store, onEdit: onEdit) }
                }
            }
            .background(Tok.bgGrouped)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        }
    }
}

private struct QueueRow: View {
    let schedule: Schedule
    let store: ScheduleStore
    let onEdit: (Schedule) -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            let now = ctx.date.timeIntervalSince1970 * 1000
            let left = (schedule.fireAt ?? 0) - now
            let soon = left <= 60_000 && left > -90_000
            HStack(spacing: 10) {
                BreathingDot(color: schedule.kindTint, active: soon)
                VStack(alignment: .leading, spacing: 2) {
                    Text(schedule.title.isEmpty ? (schedule.prompt ?? "Scheduled") : schedule.title)
                        .font(TokFont.text(TokFont.footnote, .medium)).foregroundStyle(Tok.ink).lineLimit(1)
                    Text(fmtWhen(schedule.fireAt ?? 0)).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                }
                Spacer(minLength: 8)
                Text(fmtCountdown(left)).font(TokFont.mono(TokFont.caption, .semibold))
                    .foregroundStyle(soon ? Tok.orange : schedule.kindTint).frame(minWidth: 62, alignment: .trailing)
                qbtn("pencil") { onEdit(schedule) }
                qbtn("x") { Task { await store.delete(schedule.id) } }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .overlay(alignment: .top) { Tok.separator.frame(height: Tok.hairline).padding(.leading, 12) }
        }
    }

    private func qbtn(_ icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name: icon, size: 13).foregroundStyle(Tok.inkSecondary)
                .frame(width: 24, height: 24).hoverFill(Tok.fillSecondary, radius: 6).contentShape(Rectangle())
        }.pressable()
    }
}
