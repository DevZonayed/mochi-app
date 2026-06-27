import SwiftUI

/// The calendar mode of the Schedule screen: a Monday-first week grid with hour rows, schedule
/// chips placed at their fire time, a live red now-line, and an interval banner (recurring
/// every-N-hours schedules have no single time slot, so they ride above the grid).
struct ScheduleCalendarView: View {
    let store: ScheduleStore
    let onEdit: (Schedule) -> Void
    @State private var weekOffset = 0

    private let rowH: CGFloat = 46
    private let gutterW: CGFloat = 46

    var body: some View {
        let cal = Calendar.current
        let days = weekDays(offset: weekOffset, cal: cal)
        let (minH, maxH) = hourRange(days: days, cal: cal)
        VStack(spacing: 0) {
            header(days: days, cal: cal)
            Divider().overlay(Tok.separator)
            ScrollView {
                HStack(alignment: .top, spacing: 0) {
                    gutter(minH: minH, maxH: maxH)
                    ForEach(days, id: \.self) { day in
                        dayColumn(day: day, minH: minH, maxH: maxH, cal: cal)
                    }
                }
                .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 24)
            }
        }
    }

    // MARK: Header

    private func header(days: [Date], cal: Calendar) -> some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                navBtn(flip: true) { weekOffset -= 1 }
                Text(rangeLabel(days)).font(TokFont.text(TokFont.subhead, .semibold)).foregroundStyle(Tok.ink)
                navBtn(flip: false) { weekOffset += 1 }
                if weekOffset != 0 {
                    Button("Today") { weekOffset = 0 }
                        .buttonStyle(.plain).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.blue)
                }
                Spacer()
                intervalBanner
            }
            HStack(spacing: 0) {
                Color.clear.frame(width: gutterW)
                ForEach(days, id: \.self) { day in dayHeader(day, cal: cal) }
            }
        }
        .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 8)
    }

    private func navBtn(flip: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name: "chevronRight", size: 13).rotationEffect(.degrees(flip ? 180 : 0))
                .foregroundStyle(Tok.inkSecondary).frame(width: 26, height: 26)
                .hoverFill(Tok.fillSecondary, radius: 7).contentShape(Rectangle())
        }.pressable()
    }

    private func dayHeader(_ day: Date, cal: Calendar) -> some View {
        let isToday = cal.isDateInToday(day)
        return VStack(spacing: 2) {
            Text(day.formatted(.dateTime.weekday(.abbreviated)))
                .font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.inkTertiary)
            Text(day.formatted(.dateTime.day()))
                .font(TokFont.text(TokFont.subhead, isToday ? .bold : .regular))
                .foregroundStyle(isToday ? .white : Tok.ink)
                .frame(width: 26, height: 26).background(isToday ? Tok.blue : .clear).clipShape(Circle())
        }.frame(maxWidth: .infinity)
    }

    @ViewBuilder private var intervalBanner: some View {
        let intervals = store.schedules.filter { $0.isInterval && $0.enabled }
        if !intervals.isEmpty {
            HStack(spacing: 6) {
                ForEach(intervals.prefix(4)) { s in
                    Button { onEdit(s) } label: {
                        HStack(spacing: 4) {
                            Icon(name: "refresh", size: 9)
                            Text(s.recurrenceLabel).font(TokFont.text(10, .semibold))
                        }
                        .foregroundStyle(s.kindTint).padding(.horizontal, 8).frame(height: 22)
                        .background(s.kindTint.opacity(0.14)).clipShape(Capsule())
                    }.buttonStyle(.plain).help(s.title)
                }
            }
        }
    }

    // MARK: Grid

    private func gutter(minH: Int, maxH: Int) -> some View {
        let rows = maxH - minH + 1
        return VStack(spacing: 0) {
            ForEach(0..<rows, id: \.self) { i in
                Text(hourLabel(minH + i)).font(TokFont.text(9)).foregroundStyle(Tok.inkTertiary)
                    .frame(width: gutterW, height: rowH, alignment: .topTrailing)
                    .padding(.trailing, 6).offset(y: -5)
            }
        }
    }

    private func dayColumn(day: Date, minH: Int, maxH: Int, cal: Calendar) -> some View {
        let rows = maxH - minH + 1
        let height = CGFloat(rows) * rowH
        let occ: [(s: Schedule, at: Date)] = store.schedules.compactMap { s in
            guard let d = scheduleOccurrence(s, on: day, cal: cal) else { return nil }
            return (s, d)
        }
        return ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                ForEach(0..<rows, id: \.self) { _ in
                    VStack(spacing: 0) {
                        Tok.separator.frame(height: Tok.hairline)
                        Spacer(minLength: 0)
                    }.frame(height: rowH)
                }
            }
            ForEach(Array(occ.enumerated()), id: \.offset) { _, item in
                let c = cal.dateComponents([.hour, .minute], from: item.at)
                let y = (CGFloat((c.hour ?? 0) - minH) + CGFloat(c.minute ?? 0) / 60) * rowH
                CalChip(schedule: item.s, at: item.at) { onEdit(item.s) }
                    .padding(.horizontal, 3).offset(y: y + 1)
            }
            if cal.isDateInToday(day) {
                TimelineView(.periodic(from: .now, by: 30)) { ctx in
                    let c = cal.dateComponents([.hour, .minute], from: ctx.date)
                    let y = (CGFloat((c.hour ?? 0) - minH) + CGFloat(c.minute ?? 0) / 60) * rowH
                    NowLine().offset(y: y - 0.75)
                }
            }
        }
        .frame(height: height).frame(maxWidth: .infinity)
        .overlay(alignment: .leading) { Tok.separator.frame(width: Tok.hairline) }
    }

    // MARK: Date helpers

    private func weekDays(offset: Int, cal: Calendar) -> [Date] {
        let today = cal.startOfDay(for: .now)
        let backToMon = (cal.component(.weekday, from: today) + 5) % 7   // days since Monday
        guard let monday = cal.date(byAdding: .day, value: -backToMon + offset * 7, to: today) else { return [] }
        return (0..<7).compactMap { cal.date(byAdding: .day, value: $0, to: monday) }
    }

    private func hourRange(days: [Date], cal: Calendar) -> (Int, Int) {
        var minH = 6, maxH = 22
        for s in store.schedules {
            for day in days {
                guard let occ = scheduleOccurrence(s, on: day, cal: cal) else { continue }
                let h = cal.component(.hour, from: occ)
                minH = min(minH, h); maxH = max(maxH, h)
            }
        }
        return (max(0, minH), min(23, maxH))
    }

    private func rangeLabel(_ days: [Date]) -> String {
        guard let a = days.first, let b = days.last else { return "" }
        let m1 = a.formatted(.dateTime.month(.abbreviated)), d1 = a.formatted(.dateTime.day())
        let m2 = b.formatted(.dateTime.month(.abbreviated)), d2 = b.formatted(.dateTime.day())
        return m1 == m2 ? "\(m1) \(d1) – \(d2)" : "\(m1) \(d1) – \(m2) \(d2)"
    }

    private func hourLabel(_ h: Int) -> String {
        let hr = h % 12 == 0 ? 12 : h % 12
        return "\(hr) \(h < 12 ? "AM" : "PM")"
    }
}

/// A schedule chip placed in a calendar day column.
private struct CalChip: View {
    let schedule: Schedule
    let at: Date
    let onTap: () -> Void
    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 4) {
                Text(at.formatted(.dateTime.hour(.defaultDigits(amPM: .narrow)).minute(.twoDigits)))
                    .font(TokFont.mono(9, .semibold))
                Text(schedule.title.isEmpty ? "Untitled" : schedule.title)
                    .font(TokFont.text(10, .medium)).lineLimit(1)
            }
            .foregroundStyle(schedule.kindTint)
            .padding(.horizontal, 6).padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(schedule.kindTint.opacity(0.16))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(schedule.kindTint.opacity(0.3), lineWidth: Tok.hairline))
        }.buttonStyle(.plain)
    }
}

/// The live "now" indicator drawn across today's column.
private struct NowLine: View {
    var body: some View {
        HStack(spacing: 0) {
            Circle().fill(Tok.red).frame(width: 7, height: 7)
            Tok.red.frame(height: 1.5)
        }
    }
}

/// The concrete fire time of `schedule` on `day`, or nil if it doesn't occur then. Interval
/// schedules return nil (they have no single time-of-day and ride the banner instead).
func scheduleOccurrence(_ s: Schedule, on day: Date, cal: Calendar = .current) -> Date? {
    if s.isOneShot, let f = s.fireAt {
        let d = Date(timeIntervalSince1970: f / 1000)
        return cal.isDate(d, inSameDayAs: day) ? d : nil
    }
    if s.isInterval { return nil }
    guard s.hasClock, let t = s.time else { return nil }
    let cadence = s.cadence?.lowercased() ?? ""
    let days = daysFromCadence(s.cadence)
    let isDaily = cadence.contains("daily") || days.count == 7 || (days.isEmpty && cadence.isEmpty)
    let wd = (cal.component(.weekday, from: day) + 5) % 7   // 0=Mon … 6=Sun
    if !isDaily && !days.contains(wd) { return nil }
    let parts = t.split(separator: ":")
    guard parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
    return cal.date(bySettingHour: h, minute: m, second: 0, of: day)
}
