import SwiftUI

/// The composer popover: schedule the typed message Once (quick presets + manual date/time) or as
/// a Repeat (daily / every-N-hours). Hands a `ScheduleRequest` back to the composer, which owns the
/// message text + effort and performs the actual RPC.
struct SchedulePicker: View {
    let onPick: (ScheduleRequest) -> Void

    enum Tab: Hashable { case once, repeating }
    enum RepeatMode: Hashable { case daily, interval }

    @State private var tab: Tab = .once
    @State private var date = Date().addingTimeInterval(900)
    @State private var repeatMode: RepeatMode = .daily
    @State private var timeDate = timeFromHHMM("09:00")
    @State private var everyHours = 3
    @State private var catchUp = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Schedule this message")
                .font(TokFont.text(TokFont.caption, .bold)).tracking(0.6).foregroundStyle(Tok.inkSecondary)
            SegmentedControl(options: [(Tab.once, "Once", nil), (Tab.repeating, "Repeat", nil)], value: $tab)
            if tab == .once { onceTab } else { repeatTab }
        }
        .padding(14).frame(width: 290)
    }

    // MARK: Once

    private var onceTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
                ForEach(Array(presets.enumerated()), id: \.offset) { _, p in
                    Button { onPick(.once(fireAt: p.1)) } label: {
                        Text(p.0).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.blue)
                            .frame(maxWidth: .infinity).frame(height: 28)
                            .background(Tok.blue.opacity(0.1)).clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                    }.buttonStyle(.plain)
                }
            }
            DatePicker("", selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                .datePickerStyle(.field).labelsHidden()
            statusLine(onceValid ? "Fires \(fmtWhen(date.timeIntervalSince1970 * 1000))" : "Pick a time at least 30s ahead",
                       ok: onceValid)
            confirm("Schedule", disabled: !onceValid) {
                onPick(.once(fireAt: date.timeIntervalSince1970 * 1000))
            }
        }
    }

    private var onceValid: Bool { date.timeIntervalSinceNow >= 30 }

    private var presets: [(String, Double)] {
        let now = Date(), cal = Calendar.current
        var out: [(String, Double)] = [
            ("In 15 min", now.addingTimeInterval(900).timeIntervalSince1970 * 1000),
            ("In 1 hour", now.addingTimeInterval(3600).timeIntervalSince1970 * 1000),
        ]
        if let eight = cal.date(bySettingHour: 20, minute: 0, second: 0, of: now), eight > now.addingTimeInterval(60) {
            out.append(("Tonight 8 PM", eight.timeIntervalSince1970 * 1000))
        }
        if let tom = cal.date(byAdding: .day, value: 1, to: now),
           let nine = cal.date(bySettingHour: 9, minute: 0, second: 0, of: tom) {
            out.append(("Tomorrow 9 AM", nine.timeIntervalSince1970 * 1000))
        }
        return out
    }

    // MARK: Repeat

    private var repeatTab: some View {
        VStack(alignment: .leading, spacing: 10) {
            SegmentedControl(options: [(RepeatMode.daily, "Daily at", nil), (RepeatMode.interval, "Every N hours", nil)],
                             value: $repeatMode)
            if repeatMode == .daily {
                DatePicker("", selection: $timeDate, displayedComponents: [.hourAndMinute])
                    .datePickerStyle(.field).labelsHidden()
                Toggle(isOn: $catchUp) {
                    Text("Catch up if missed (same day)").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary)
                }.toggleStyle(.checkbox)
            } else {
                HStack(spacing: 8) {
                    Text("Every").font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary)
                    Stepper(value: $everyHours, in: 1...168) {
                        Text("\(everyHours)").font(TokFont.text(TokFont.subhead, .semibold)).foregroundStyle(Tok.ink).frame(minWidth: 26)
                    }.fixedSize()
                    Text(everyHours == 1 ? "hour" : "hours").font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary)
                }
            }
            confirm("Schedule repeating", disabled: false) {
                let opts = repeatMode == .daily
                    ? RepeatOpts(everyMinutes: nil, time: hhmm(timeDate), cadence: "daily", catchUp: catchUp)
                    : RepeatOpts(everyMinutes: everyHours * 60, time: nil, cadence: nil, catchUp: false)
                onPick(.repeating(opts))
            }
        }
    }

    // MARK: Bits

    private func statusLine(_ text: String, ok: Bool) -> some View {
        Text(text).font(TokFont.text(TokFont.caption)).foregroundStyle(ok ? Tok.inkSecondary : Tok.red)
    }

    private func confirm(_ title: String, disabled: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(.white)
                .frame(maxWidth: .infinity).frame(height: 30)
                .background(disabled ? Tok.fillSecondary : Tok.blue)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }.buttonStyle(.plain).disabled(disabled)
    }
}
