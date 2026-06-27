import SwiftUI

/// Create/edit form for a schedule. Supports all four "when" modes — Once (one-shot message),
/// Daily, Every-N-hours, and Specific days. Once → `scheduleMessage`; the rest → create/update
/// recurring. Editing a one-shot reschedules (create-new + delete-old) since the brain can't
/// patch `fireAt`.
struct ScheduleSheet: View {
    @Environment(AppEnv.self) private var env
    let editing: Schedule?
    let projects: [Project]
    let store: ScheduleStore
    let onClose: () -> Void

    enum When: Hashable { case once, daily, interval, days }

    @State private var projectId: String?
    @State private var sessionId: String?
    @State private var sessions: [ChatSession] = []
    @State private var when: When
    @State private var date: Date
    @State private var timeDate: Date
    @State private var everyHours: Int
    @State private var selectedDays: Set<Int>
    @State private var catchUp: Bool
    @State private var prompt: String
    @State private var effort: String
    @State private var browser: Bool
    @State private var saving = false
    @State private var error: String?

    init(context: ScheduleSheetContext, projects: [Project], store: ScheduleStore, onClose: @escaping () -> Void) {
        let e = context.editing
        self.editing = e
        self.projects = projects
        self.store = store
        self.onClose = onClose

        _projectId = State(initialValue: e?.projectId ?? context.prefillProjectId)
        _sessionId = State(initialValue: e?.sessionId)
        _prompt = State(initialValue: e?.prompt ?? "")
        _effort = State(initialValue: e?.effort ?? "balanced")
        _browser = State(initialValue: e?.browser ?? false)
        _catchUp = State(initialValue: e?.catchUp ?? false)
        _everyHours = State(initialValue: max(1, (e?.everyMinutes ?? 180) / 60))
        _date = State(initialValue: e?.fireAt.map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date().addingTimeInterval(3600))

        let days = daysFromCadence(e?.cadence)
        _selectedDays = State(initialValue: Set(days.isEmpty ? [0, 1, 2, 3, 4] : days))
        _timeDate = State(initialValue: Self.parseTime(e?.time) ?? Self.parseTime("09:00")!)

        // Derive the mode from the schedule being edited.
        let mode: When
        if let e {
            if e.isInterval { mode = .interval }
            else if e.isOneShot { mode = .once }
            else if e.hasClock {
                let cad = e.cadence?.lowercased() ?? ""
                mode = (cad.contains("daily") || days.count == 7 || days.isEmpty) ? .daily : .days
            } else { mode = .daily }
        } else { mode = .daily }
        _when = State(initialValue: mode)
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(editing == nil ? "New schedule" : "Edit schedule")
                    .font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
                Spacer()
                IconButton(icon: "x", size: 28, iconSize: 14) { onClose() }
            }
            .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 12)
            Divider().overlay(Tok.separator)

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    section("Project") { projectMenu }
                    section("Run in") { sessionMenu }
                    section("When") { whenSection }
                    section("What") { promptField }
                    section("How") { howRow }
                }
                .padding(20)
            }

            Divider().overlay(Tok.separator)
            footer
        }
        .frame(width: 480, height: 640)
        .background(Tok.bgElevated)
        .task { await loadSessions() }
    }

    // MARK: Sections

    private var projectMenu: some View {
        Menu {
            Button("No project") { projectId = nil; sessionId = nil; Task { await loadSessions() } }
            ForEach(projects) { p in
                Button(p.name) { projectId = p.id; sessionId = nil; Task { await loadSessions() } }
            }
        } label: { menuLabel(projects.first { $0.id == projectId }?.name ?? "No project") }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
    }

    private var sessionMenu: some View {
        Menu {
            Button("New chat each run") { sessionId = nil }
            ForEach(sessions) { s in Button(s.displayTitle) { sessionId = s.id } }
        } label: {
            menuLabel(sessions.first { $0.id == sessionId }?.displayTitle ?? "New chat each run")
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden)
        .disabled(projectId == nil && sessionId == nil)
    }

    @ViewBuilder private var whenSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SegmentedControl(options: whenOptions, value: $when)
            switch when {
            case .once:
                DatePicker("", selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    .datePickerStyle(.field).labelsHidden()
            case .daily:
                timeRow
            case .interval:
                HStack(spacing: 8) {
                    Text("Every").font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary)
                    Stepper(value: $everyHours, in: 1...168) {
                        Text("\(everyHours)").font(TokFont.text(TokFont.subhead, .semibold)).foregroundStyle(Tok.ink)
                            .frame(minWidth: 28)
                    }.fixedSize()
                    Text(everyHours == 1 ? "hour" : "hours").font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary)
                }
            case .days:
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 5) {
                        ForEach(0..<7, id: \.self) { i in dayToggle(i) }
                    }
                    quickDays
                    timeRow
                }
            }
            if when == .daily || when == .days {
                Toggle(isOn: $catchUp) {
                    Text("Run it later the same day if the Mac was asleep")
                        .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary)
                }.toggleStyle(.checkbox)
            }
            summaryLine
        }
    }

    private var timeRow: some View {
        HStack(spacing: 8) {
            Text("At").font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary)
            DatePicker("", selection: $timeDate, displayedComponents: [.hourAndMinute])
                .datePickerStyle(.field).labelsHidden().fixedSize()
        }
    }

    private var quickDays: some View {
        HStack(spacing: 6) {
            quickDayBtn("Weekdays") { selectedDays = [0, 1, 2, 3, 4] }
            quickDayBtn("Weekend") { selectedDays = [5, 6] }
            quickDayBtn("Every day") { selectedDays = [0, 1, 2, 3, 4, 5, 6] }
        }
    }

    private func quickDayBtn(_ label: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.blue)
                .padding(.horizontal, 9).frame(height: 24)
                .background(Tok.blue.opacity(0.12)).clipShape(Capsule())
        }.buttonStyle(.plain)
    }

    private func dayToggle(_ i: Int) -> some View {
        let on = selectedDays.contains(i)
        return Button {
            if on { selectedDays.remove(i) } else { selectedDays.insert(i) }
        } label: {
            Text(scheduleDOW[i]).font(TokFont.text(TokFont.caption, .semibold))
                .foregroundStyle(on ? .white : Tok.inkSecondary)
                .frame(width: 38, height: 30)
                .background(on ? Tok.blue : Tok.fillSecondary)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }.buttonStyle(.plain)
    }

    private var promptField: some View {
        ZStack(alignment: .topLeading) {
            if prompt.isEmpty {
                Text("What should the agent do?")
                    .font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkTertiary)
                    .padding(.horizontal, 10).padding(.vertical, 9).allowsHitTesting(false)
            }
            TextEditor(text: $prompt)
                .font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.ink)
                .scrollContentBackground(.hidden).padding(.horizontal, 6).padding(.vertical, 4)
                .frame(height: 84)
        }
        .background(Tok.bgGrouped).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private var howRow: some View {
        HStack(spacing: 10) {
            Menu {
                ForEach(["fast", "balanced", "deep", "max"], id: \.self) { e in
                    Button(e.capitalized) { effort = e }
                }
            } label: { menuLabel(effort.capitalized, width: 130) }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            Toggle(isOn: $browser) {
                Text("Allow browser").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
            }.toggleStyle(.checkbox)
            Spacer()
        }
    }

    private var summaryLine: some View {
        HStack(spacing: 6) {
            Icon(name: validity == nil ? "check" : "alert", size: 11)
                .foregroundStyle(validity == nil ? Tok.green : Tok.orange)
            Text(validity ?? summaryText).font(TokFont.text(TokFont.caption))
                .foregroundStyle(validity == nil ? Tok.inkSecondary : Tok.orange)
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            if let error { Text(error).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.red).lineLimit(2) }
            Spacer()
            PillButton(title: "Cancel", kind: .plain) { onClose() }
            PillButton(title: editing == nil ? "Create" : "Save", disabled: validity != nil, busy: saving) {
                Task { await save() }
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
    }

    // MARK: Derived

    private var whenOptions: [(value: When, label: String, icon: String?)] {
        [(.once, "Once", nil), (.daily, "Daily", nil), (.interval, "Interval", nil), (.days, "Days", nil)]
    }

    /// nil = valid; otherwise the reason it can't be saved (shown in the summary line).
    private var validity: String? {
        if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Add a message or task" }
        switch when {
        case .once:
            if date.timeIntervalSinceNow < 30 { return "Pick a time at least 30s ahead" }
        case .days:
            if selectedDays.isEmpty { return "Pick at least one day" }
        case .interval:
            if everyHours < 1 { return "Interval must be ≥ 1 hour" }
        case .daily: break
        }
        return nil
    }

    private var summaryText: String {
        switch when {
        case .once:     return "Fires \(fmtWhen(date.timeIntervalSince1970 * 1000))"
        case .daily:    return "Every day at \(hhmm(timeDate))"
        case .interval: return "Every \(everyHours) hour\(everyHours == 1 ? "" : "s")"
        case .days:
            let cad = cadenceFromDays(Array(selectedDays))
            return "\(cad.capitalized) at \(hhmm(timeDate))"
        }
    }

    // MARK: Actions

    private func loadSessions() async {
        guard let pid = projectId else { sessions = []; return }
        sessions = (try? await env.client.call("listSessions", ["projectId": pid], as: [ChatSession].self)) ?? []
    }

    private func save() async {
        guard validity == nil else { return }
        saving = true; error = nil
        let p = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = String(p.prefix(60))
        var ok = false

        if when == .once {
            let ms = date.timeIntervalSince1970 * 1000
            ok = await store.scheduleMessage(fireAt: ms, prompt: p, sessionId: sessionId, projectId: projectId,
                                             effort: effort, browser: browser)
            if ok, let old = editing { await store.delete(old.id) }   // reschedule
        } else {
            let opts = repeatOpts()
            if let old = editing, old.isRecurring {
                var patch: [String: Any] = [
                    "title": title, "prompt": p, "effort": effort, "browser": browser, "catchUp": opts.catchUp,
                    "time": opts.time ?? "", "cadence": opts.cadence ?? "",
                    "everyMinutes": opts.everyMinutes ?? 0,
                ]
                if let pid = projectId { patch["projectId"] = pid }
                if let sid = sessionId { patch["sessionId"] = sid }
                ok = await store.update(old.id, patch: patch)
            } else {
                ok = await store.createRecurring(title: title, prompt: p, projectId: projectId,
                                                 sessionId: sessionId, opts: opts, effort: effort)
                if ok, let old = editing { await store.delete(old.id) }
            }
        }

        saving = false
        if ok { onClose() } else { error = store.error ?? "Couldn't save the schedule." }
    }

    private func repeatOpts() -> RepeatOpts {
        switch when {
        case .daily:    return RepeatOpts(everyMinutes: nil, time: hhmm(timeDate), cadence: "daily", catchUp: catchUp)
        case .days:     return RepeatOpts(everyMinutes: nil, time: hhmm(timeDate),
                                          cadence: cadenceFromDays(Array(selectedDays)), catchUp: catchUp)
        case .interval: return RepeatOpts(everyMinutes: everyHours * 60, time: nil, cadence: nil, catchUp: false)
        case .once:     return RepeatOpts()
        }
    }

    // MARK: Small helpers

    private func section<V: View>(_ title: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title.uppercased()).font(TokFont.text(TokFont.caption, .semibold)).tracking(0.5)
                .foregroundStyle(Tok.inkTertiary)
            content()
        }
    }

    private func menuLabel(_ text: String, width: CGFloat? = nil) -> some View {
        HStack(spacing: 6) {
            Text(text).font(TokFont.text(TokFont.subhead, .medium)).foregroundStyle(Tok.ink).lineLimit(1)
            Spacer(minLength: 4)
            Icon(name: "chevronDown", size: 10).foregroundStyle(Tok.inkSecondary)
        }
        .padding(.horizontal, 11).frame(width: width, height: 34)
        .frame(maxWidth: width == nil ? .infinity : nil)
        .background(Tok.bgGrouped).clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private func hhmm(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }

    private static func parseTime(_ s: String?) -> Date? {
        guard let s, case let parts = s.split(separator: ":"), parts.count == 2,
              let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
        return Calendar.current.date(bySettingHour: h, minute: m, second: 0, of: Date())
    }
}
