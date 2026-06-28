import SwiftUI

/// The calendar mode of the Scheduler: the current Mon–Sun week with an hour grid, schedule chips
/// placed at their fire time (colored by project), a live red now-line, and an honest empty state.
/// Mirrors Scheduler.tsx CalendarView (no week navigation — always the current week).
struct ScheduleCalendarView: View {
    let store: ScheduleStore
    let projMeta: [String: SchedProjMeta]
    let onEdit: (Schedule) -> Void

    private let rowH: CGFloat = 48
    private let gutterW: CGFloat = 56

    private struct Occ: Identifiable { let id: String; let schedule: Schedule; let col: Int; let hour: Double }

    var body: some View {
        let cal = Calendar.current
        let (days, todayIdx, _) = week(cal)
        let occ = occurrences(days: days, cal: cal)
        let (gridStart, gridEnd) = hourRange(occ)
        let hours = Array(gridStart...gridEnd)

        VStack(spacing: 0) {
            dayHeader(days: days, todayIdx: todayIdx, cal: cal)
            Divider().overlay(Tok.separator)
            ScrollView {
                TimelineView(.periodic(from: .now, by: 30)) { ctx in
                    grid(hours: hours, gridStart: gridStart, occ: occ, todayIdx: todayIdx, now: ctx.date, cal: cal)
                }
            }
            .overlay { if occ.isEmpty { emptyOverlay } }
        }
        .background(Tok.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        .padding(.bottom, 24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: Day header
    private func dayHeader(days: [Date], todayIdx: Int, cal: Calendar) -> some View {
        HStack(spacing: 0) {
            Color.clear.frame(width: gutterW)
            ForEach(Array(days.enumerated()), id: \.offset) { i, day in
                let today = i == todayIdx
                VStack(spacing: 6) {
                    Text(day.formatted(.dateTime.weekday(.abbreviated)).uppercased())
                        .font(TokFont.text(TokFont.caption, .semibold)).tracking(0.4)
                        .foregroundStyle(today ? Tok.red : Tok.inkTertiary)
                    Text(day.formatted(.dateTime.day()))
                        .font(TokFont.text(TokFont.callout, today ? .bold : .semibold))
                        .foregroundStyle(today ? .white : Tok.ink)
                        .frame(width: 28, height: 28).background(today ? Tok.red : .clear).clipShape(Circle())
                }
                .frame(maxWidth: .infinity).padding(.vertical, 10)
                .overlay(alignment: .leading) { Tok.separator.frame(width: Tok.hairline) }
            }
        }
    }

    // MARK: Grid
    private func grid(hours: [Int], gridStart: Int, occ: [Occ], todayIdx: Int, now: Date, cal: Calendar) -> some View {
        let nowHour = Double(cal.component(.hour, from: now)) + Double(cal.component(.minute, from: now)) / 60
        let nowVisible = nowHour >= Double(gridStart) && nowHour <= Double(hours.last ?? gridStart)
        let nowTop = (nowHour - Double(gridStart)) * rowH
        return HStack(alignment: .top, spacing: 0) {
            // hour gutter
            VStack(spacing: 0) {
                ForEach(hours, id: \.self) { h in
                    ZStack(alignment: .topTrailing) {
                        Color.clear.frame(height: rowH)
                        if h != gridStart {
                            Text(fmtHour(h)).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                                .offset(y: -7).padding(.trailing, 8)
                        }
                    }
                }
            }
            .frame(width: gutterW)
            .overlay(alignment: .trailing) { Tok.separator.frame(width: Tok.hairline) }

            // day columns
            ForEach(0..<7, id: \.self) { di in
                dayColumn(di: di, hours: hours, gridStart: gridStart, occ: occ.filter { $0.col == di }, today: di == todayIdx, nowTop: nowVisible && di == todayIdx ? nowTop : nil)
            }
        }
        .overlay(alignment: .topLeading) {
            if nowVisible {
                HStack(spacing: 0) {
                    Color.clear.frame(width: gutterW)
                    Tok.red.frame(height: 1.5).frame(maxWidth: .infinity)
                }
                .offset(y: nowTop).allowsHitTesting(false)
            }
        }
    }

    private func dayColumn(di: Int, hours: [Int], gridStart: Int, occ: [Occ], today: Bool, nowTop: CGFloat?) -> some View {
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                ForEach(hours, id: \.self) { _ in
                    Color.clear.frame(height: rowH)
                        .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }
                }
            }
            ForEach(occ) { o in
                CalChip(schedule: o.schedule, color: chipColor(o.schedule), onTap: { onEdit(o.schedule) })
                    .padding(.horizontal, 3)
                    .offset(y: (o.hour - Double(gridStart)) * rowH + 2)
            }
            if let nowTop {
                Circle().fill(Tok.red).frame(width: 9, height: 9).offset(x: -4.5, y: nowTop - 4.5)
            }
        }
        .frame(maxWidth: .infinity)
        .background(today ? Tok.red.opacity(0.03) : .clear)
        .overlay(alignment: .leading) { Tok.separator.frame(width: Tok.hairline) }
    }

    private var emptyOverlay: some View {
        VStack(spacing: 4) {
            Text("Nothing scheduled this week").font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.inkSecondary)
            Text("Create a schedule and it appears here on its day & time.")
                .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: 320).padding(24).frame(maxWidth: .infinity, maxHeight: .infinity).allowsHitTesting(false)
    }

    // MARK: Data
    private func week(_ cal: Calendar) -> ([Date], Int, Date) {
        let today = cal.startOfDay(for: .now)
        let todayIdx = (cal.component(.weekday, from: today) + 5) % 7   // Mon=0…Sun=6
        let monday = cal.date(byAdding: .day, value: -todayIdx, to: today) ?? today
        let days = (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: monday) }
        return (days, todayIdx, monday)
    }

    /// Calendar-eligible occurrences: clock/one-shot schedules placed on their day(s). Intervals and
    /// short-lived autopilot followups are excluded (they live in the list).
    private func occurrences(days: [Date], cal: Calendar) -> [Occ] {
        var out: [Occ] = []
        for s in store.schedules {
            guard s.kind != "auto-answer", s.kind != "auto-continue", s.kind != "keep-going" else { continue }
            if s.isInterval { continue }
            for (col, day) in days.enumerated() {
                guard let at = scheduleOccurrence(s, on: day, cal: cal) else { continue }
                if s.isOneShot, !s.enabled { continue }
                let hour = Double(cal.component(.hour, from: at)) + Double(cal.component(.minute, from: at)) / 60
                out.append(Occ(id: "\(s.id):\(col)", schedule: s, col: col, hour: hour))
            }
        }
        return out
    }

    private func hourRange(_ occ: [Occ]) -> (Int, Int) {
        var minH = 6, maxH = 22
        for o in occ { minH = min(minH, Int(o.hour)); maxH = max(maxH, Int(ceil(o.hour))) }
        return (max(0, minH), min(23, maxH))
    }

    private func chipColor(_ s: Schedule) -> Color {
        s.projectId.flatMap { projMeta[$0]?.color } ?? Tok.inkTertiary
    }

    private func fmtHour(_ h: Int) -> String {
        let hr = h % 12 == 0 ? 12 : h % 12
        return "\(hr) \(h < 12 ? "AM" : "PM")"
    }
}

/// A schedule chip placed in a calendar day column (colored by project, clock glyph, dim if paused).
private struct CalChip: View {
    let schedule: Schedule
    let color: Color
    let onTap: () -> Void
    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 5) {
                Icon(name: "clock", size: 11).foregroundStyle(color)
                Text(schedule.title.isEmpty ? "Untitled" : schedule.title)
                    .font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.ink).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 7).frame(height: 30)
            .background(ZStack { Tok.bgElevated; color.opacity(0.14) })
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(color.opacity(0.35), lineWidth: 1))
            .overlay(alignment: .leading) { color.frame(width: 3).clipShape(RoundedRectangle(cornerRadius: 1.5)) }
            .opacity(schedule.enabled ? 1 : 0.45)
        }.buttonStyle(.plain)
    }
}
