import SwiftUI

/// Create/edit a recurring schedule. Mirrors Scheduler.tsx ScheduleSheet: numbered sections, a
/// searchable project/chat select, fresh-run vs specific-chat, three "when" modes (Every N hours /
/// Daily / Specific days), a live summary + catch-up, the prompt, and the durability note.
struct ScheduleSheet: View {
    @Environment(AppEnv.self) private var env
    let editing: Schedule?
    let projects: [Project]
    let store: ScheduleStore
    let onClose: () -> Void

    enum When: Hashable { case interval, daily, days }

    @State private var projectId = ""              // "" = Workspace (no project)
    @State private var runInSpecific = false
    @State private var sessionId = ""
    @State private var sessions: [ChatSession] = []
    @State private var when: When
    @State private var timeDate: Date
    @State private var everyHours: Int
    @State private var selectedDays: Set<Int>
    @State private var catchUp: Bool
    @State private var prompt: String
    @State private var saving = false
    @State private var error: String?

    private let hourPresets = [1, 2, 3, 4, 6, 8, 12, 24]

    init(context: ScheduleSheetContext, projects: [Project], store: ScheduleStore, onClose: @escaping () -> Void) {
        let e = context.editing
        self.editing = e; self.projects = projects; self.store = store; self.onClose = onClose
        _projectId = State(initialValue: e?.projectId ?? context.prefillProjectId ?? "")
        _runInSpecific = State(initialValue: e?.sessionId != nil)
        _sessionId = State(initialValue: e?.sessionId ?? "")
        _prompt = State(initialValue: e?.prompt ?? "")
        _catchUp = State(initialValue: e?.catchUp ?? true)
        _everyHours = State(initialValue: max(1, (e?.everyMinutes ?? 180) / 60))
        let days = daysFromCadence(e?.cadence)
        _selectedDays = State(initialValue: Set(days.isEmpty ? [0, 1, 2, 3, 4] : days))
        _timeDate = State(initialValue: Self.parseTime(e?.time) ?? Self.parseTime("09:00")!)
        let mode: When
        if let e {
            if e.isInterval { mode = .interval }
            else {
                let cad = e.cadence?.lowercased() ?? ""
                mode = (cad.contains("daily") || days.count == 7 || days.isEmpty) ? .daily : .days
            }
        } else { mode = .daily }
        _when = State(initialValue: mode)
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Tok.separator)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    section("1", "Project & where it runs") { projectSection }
                    section("2", "When") { whenSection }
                    section("3", "What runs each time") { promptSection }
                }
                .padding(20)
            }
            .frame(maxHeight: 540)
            Divider().overlay(Tok.separator)
            footer
        }
        .frame(width: 520)
        .background(Tok.bgElevated)
        .task { await loadSessions() }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(editing == nil ? "New schedule" : "Edit schedule")
                    .font(TokFont.display(TokFont.title2, .bold)).tracking(-0.2).foregroundStyle(Tok.ink)
                Text("Fires on this Mac at its time. Turn on catch-up so a missed run still fires later the same day.")
                    .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            IconButton(icon: "x", size: 32, iconSize: 16) { onClose() }
        }
        .padding(.horizontal, 20).padding(.vertical, 18)
    }

    // MARK: Section 1 — project & where it runs
    private var projectSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            SearchSelect(options: projects.map { ($0.id, $0.name) }, value: $projectId,
                         leadLabel: "Workspace", placeholder: "Search projects…") {
                sessionId = ""; if projectId.isEmpty { runInSpecific = false }; Task { await loadSessions() }
            }
            HStack(spacing: 7) {
                pill("A fresh run each time", active: !runInSpecific) { runInSpecific = false; sessionId = "" }
                pill("A specific chat", active: runInSpecific) { runInSpecific = true }
            }
            Text(runInSpecific ? "Each run continues the chosen chat, keeping its memory + context." : "Each run starts a clean job (no prior chat history).")
                .font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary).fixedSize(horizontal: false, vertical: true)
            if runInSpecific {
                if projectId.isEmpty {
                    Text("Pick a project above to choose one of its chats.").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                } else if sessions.isEmpty {
                    Text("This project has no chats yet — pick “A fresh run each time”, or open a chat first.").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                } else {
                    SearchSelect(options: sessions.map { ($0.id, $0.displayTitle) }, value: $sessionId,
                                 emptyLabel: "Choose a chat…", placeholder: "Search chats…") {}
                }
            }
        }
    }

    // MARK: Section 2 — when
    @ViewBuilder private var whenSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 7) {
                pill("Every N hours", active: when == .interval) { when = .interval }
                pill("Daily", active: when == .daily) { when = .daily }
                pill("Specific days", active: when == .days) { when = .days }
            }
            switch when {
            case .interval:
                HStack(spacing: 7) { ForEach(hourPresets, id: \.self) { h in pill("\(h)h", active: everyHours == h) { everyHours = h } } }
            case .daily:
                timeRow
            case .days:
                HStack(spacing: 6) {
                    pill("Weekdays", active: false) { selectedDays = [0, 1, 2, 3, 4] }
                    pill("Weekend", active: false) { selectedDays = [5, 6] }
                    pill("Every day", active: false) { selectedDays = [0, 1, 2, 3, 4, 5, 6] }
                }
                HStack(spacing: 6) { ForEach(0..<7, id: \.self) { dayToggle($0) } }
                timeRow
            }
            HStack(spacing: 8) {
                Icon(name: validity == nil ? "check" : "alert", size: 14)
                    .foregroundStyle(validity == nil ? Tok.green : Tok.orange)
                Text(validity ?? summaryText).font(TokFont.text(TokFont.footnote, .semibold))
                    .foregroundStyle(validity == nil ? Tok.inkSecondary : Tok.orange)
            }
            if when != .interval {
                HStack(spacing: 10) {
                    MSwitch(on: $catchUp).scaleEffect(0.78)
                    Text("Catch up if missed — run it later the same day if the Mac was asleep.")
                        .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var timeRow: some View {
        HStack(spacing: 10) {
            Text("at").font(TokFont.text(TokFont.callout)).foregroundStyle(Tok.inkSecondary)
            DatePicker("", selection: $timeDate, displayedComponents: [.hourAndMinute])
                .datePickerStyle(.field).labelsHidden().fixedSize()
                .font(TokFont.mono(TokFont.callout))
        }
    }

    private func dayToggle(_ i: Int) -> some View {
        let on = selectedDays.contains(i)
        return Button { if on { selectedDays.remove(i) } else { selectedDays.insert(i) } } label: {
            Text(scheduleDOW[i]).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(on ? Tok.blue : Tok.ink)
                .frame(width: 48, height: 34)
                .background(on ? Tok.blue.opacity(0.16) : Tok.bgGrouped).clipShape(Capsule())
                .overlay(Capsule().strokeBorder(on ? Tok.blue.opacity(0.55) : Tok.separator, lineWidth: on ? 1 : Tok.hairline))
        }.buttonStyle(.plain)
    }

    // MARK: Section 3 — prompt
    private var promptSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            ZStack(alignment: .topLeading) {
                if prompt.isEmpty {
                    Text("Describe what to do, e.g. Pull my latest ~50 WhatsApp messages, summarize the conversation, and send the summary to my private chat.")
                        .font(TokFont.text(TokFont.body)).foregroundStyle(Tok.inkTertiary)
                        .padding(.horizontal, 14).padding(.vertical, 11).allowsHitTesting(false)
                }
                TextEditor(text: $prompt).font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                    .scrollContentBackground(.hidden).padding(.horizontal, 10).padding(.vertical, 7).frame(height: 96)
            }
            .background(Tok.bgGrouped).clipShape(RoundedRectangle(cornerRadius: Tok.Radius.group, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Tok.Radius.group, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
            HStack(alignment: .top, spacing: 10) {
                Icon(name: "shield", size: 15).foregroundStyle(Tok.green).padding(.top, 1)
                Text("Each firing creates a real job on this Mac — it shows up in Jobs and on your phone like a hand-started run, with its cost in Costs.")
                    .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .background(Tok.bgGrouped).clipShape(RoundedRectangle(cornerRadius: Tok.Radius.group, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Tok.Radius.group, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        }
    }

    private var footer: some View {
        HStack(spacing: 14) {
            if let e = editing {
                Button { Task { await store.delete(e.id); onClose() } } label: {
                    HStack(spacing: 6) { Icon(name: "x", size: 15); Text("Delete").font(TokFont.text(TokFont.callout, .semibold)) }
                        .foregroundStyle(Tok.red).padding(.horizontal, 14).frame(height: 40)
                        .background(Tok.red.opacity(0.12)).clipShape(Capsule())
                }.buttonStyle(.plain)
            }
            if let error { Text(error).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.red).lineLimit(2) }
            Spacer()
            PillButton(title: "Cancel", kind: .plain) { onClose() }
            PillButton(title: editing == nil ? "Save schedule" : "Save changes", disabled: validity != nil, busy: saving) { Task { await save() } }
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
    }

    // MARK: Pieces
    private func section<V: View>(_ n: String, _ title: String, @ViewBuilder _ content: () -> V) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(n).font(TokFont.mono(TokFont.caption, .bold)).foregroundStyle(Tok.inkSecondary)
                    .frame(width: 20, height: 20).background(Tok.fillSecondary).clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                Text(title).font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink)
            }
            content()
        }
        .padding(.bottom, 18)
    }

    private func pill(_ label: String, active: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(active ? Tok.blue : Tok.ink)
                .padding(.horizontal, 13).frame(height: 34)
                .background(active ? Tok.blue.opacity(0.16) : Tok.bgGrouped).clipShape(Capsule())
                .overlay(Capsule().strokeBorder(active ? Tok.blue.opacity(0.55) : Tok.separator, lineWidth: active ? 1 : Tok.hairline))
        }.buttonStyle(.plain)
    }

    // MARK: Derived + actions
    private var sortedDays: [Int] { selectedDays.sorted() }
    private var validity: String? {
        if prompt.trimmed.isEmpty { return "Add what runs each time" }
        switch when {
        case .interval: if everyHours < 1 { return "Pick an interval" }
        case .daily: break
        case .days: if selectedDays.isEmpty { return "Pick at least one day" }
        }
        return nil
    }
    private var summaryText: String {
        switch when {
        case .interval: return "Every \(everyHours) hour\(everyHours == 1 ? "" : "s")"
        case .daily: return "Every day at \(hhmm(timeDate))"
        case .days: return "\(cadenceFromDays(sortedDays).capitalized) at \(hhmm(timeDate))"
        }
    }

    private func loadSessions() async {
        guard !projectId.isEmpty else { sessions = []; return }
        sessions = (try? await env.client.call("listSessions", ["projectId": projectId], as: [ChatSession].self)) ?? []
    }

    private func save() async {
        guard validity == nil else { return }
        saving = true; error = nil
        let p = prompt.trimmed
        let title = String(p.prefix(60))
        let pid: String? = projectId.isEmpty ? nil : projectId
        let sid: String? = (runInSpecific && !sessionId.isEmpty) ? sessionId : nil
        let opts = repeatOpts()
        var ok = false
        if let old = editing, old.isRecurring {
            var patch: [String: Any] = [
                "title": title, "prompt": p, "catchUp": opts.catchUp,
                "time": opts.time ?? "", "cadence": opts.cadence ?? "", "everyMinutes": opts.everyMinutes ?? 0,
            ]
            if let pid { patch["projectId"] = pid }
            if let sid { patch["sessionId"] = sid }
            ok = await store.update(old.id, patch: patch)
        } else {
            ok = await store.createRecurring(title: title, prompt: p, projectId: pid, sessionId: sid, opts: opts)
            if ok, let old = editing { await store.delete(old.id) }
        }
        saving = false
        if ok { onClose() } else { error = store.error ?? "Couldn't save the schedule." }
    }

    private func repeatOpts() -> RepeatOpts {
        switch when {
        case .daily: return RepeatOpts(everyMinutes: nil, time: hhmm(timeDate), cadence: "daily", catchUp: catchUp)
        case .days: return RepeatOpts(everyMinutes: nil, time: hhmm(timeDate), cadence: cadenceFromDays(sortedDays), catchUp: catchUp)
        case .interval: return RepeatOpts(everyMinutes: everyHours * 60, time: nil, cadence: nil, catchUp: false)
        }
    }

    private func hhmm(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }
    private static func parseTime(_ s: String?) -> Date? {
        guard let s, case let parts = s.split(separator: ":"), parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) else { return nil }
        return Calendar.current.date(bySettingHour: h, minute: m, second: 0, of: Date())
    }
}

/// A searchable single-select combobox (project / chat picker) — a trigger + a filterable popover.
struct SearchSelect: View {
    let options: [(id: String, label: String)]
    @Binding var value: String
    var leadLabel: String? = nil       // pinned option representing the empty ("") value
    var emptyLabel: String = "Choose…"
    var placeholder: String
    var onChange: () -> Void = {}

    @State private var open = false
    @State private var q = ""
    @FocusState private var searchFocused: Bool

    private var selected: (id: String, label: String)? { value.isEmpty ? nil : options.first { $0.id == value } }
    private var triggerLabel: String { selected?.label ?? leadLabel ?? emptyLabel }
    private var muted: Bool { selected == nil && leadLabel == nil }
    private var filtered: [(id: String, label: String)] {
        q.trimmed.isEmpty ? options : options.filter { $0.label.localizedCaseInsensitiveContains(q.trimmed) }
    }

    var body: some View {
        Button { open.toggle() } label: {
            HStack(spacing: 8) {
                Text(triggerLabel).font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(muted ? Tok.inkTertiary : Tok.ink).lineLimit(1)
                Spacer(minLength: 4)
                Icon(name: "chevronDown", size: 14).foregroundStyle(Tok.inkTertiary).rotationEffect(.degrees(open ? 180 : 0))
            }
            .padding(.horizontal, 12).frame(height: 40)
            .background(Tok.bgGrouped).clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(open ? Tok.blue.opacity(0.55) : Tok.separator, lineWidth: open ? 1 : Tok.hairline))
        }
        .buttonStyle(.plain)
        .popover(isPresented: $open, arrowEdge: .bottom) {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Icon(name: "search", size: 15).foregroundStyle(Tok.inkTertiary)
                    TextField(placeholder, text: $q).textFieldStyle(.plain).font(TokFont.text(TokFont.footnote)).focused($searchFocused)
                }
                .padding(.horizontal, 11).frame(height: 38)
                .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }
                ScrollView {
                    VStack(spacing: 0) {
                        if let leadLabel, q.trimmed.isEmpty { selectRow(leadLabel, active: value.isEmpty) { value = ""; onChange(); open = false } }
                        ForEach(filtered, id: \.id) { o in selectRow(o.label, active: value == o.id) { value = o.id; onChange(); open = false } }
                        if filtered.isEmpty && !(leadLabel != nil && q.trimmed.isEmpty) {
                            Text("No matches").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary).padding(16)
                        }
                    }.padding(5)
                }
                .frame(maxHeight: 248)
            }
            .frame(width: 440)
            .background(Tok.bgElevated)
            .onAppear { searchFocused = true }
        }
    }

    private func selectRow(_ label: String, active: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Text(label).font(TokFont.text(TokFont.callout, .medium)).foregroundStyle(active ? Tok.blue : Tok.ink).lineLimit(1)
                Spacer(minLength: 0)
                if active { Icon(name: "check", size: 15).foregroundStyle(Tok.blue) }
            }
            .padding(.horizontal, 9).frame(height: 36)
            .background(active ? Tok.blue.opacity(0.14) : .clear).clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
        }.buttonStyle(.plain).hoverFill(Tok.fillSecondary, radius: 8)
    }
}
