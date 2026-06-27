import SwiftUI

/// Identifies a ScheduleSheet presentation (create when `editing == nil`).
struct ScheduleSheetContext: Identifiable {
    let id: String
    let editing: Schedule?
    var prefillProjectId: String? = nil
}

/// The top-level Schedule destination: a List ⇄ Calendar of every schedule, with a "New
/// schedule" sheet. Owns a `ScheduleStore` and a one-shot project list (for names + the picker).
struct ScheduleView: View {
    @Environment(AppEnv.self) private var env
    @State private var store: ScheduleStore?
    @State private var projects: [Project] = []
    @State private var mode: Mode = .list
    @State private var sheet: ScheduleSheetContext?

    enum Mode: Hashable { case list, calendar }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Tok.separator)
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Tok.bg)
        .task {
            if store == nil { let s = ScheduleStore(client: env.client); await s.start(); store = s }
            projects = (try? await env.client.call("listProjects", as: [Project].self)) ?? []
        }
        .onDisappear { store?.stop() }
        .sheet(item: $sheet) { ctx in
            if let store { ScheduleSheet(context: ctx, projects: projects, store: store) { sheet = nil } }
        }
    }

    private var projectNames: [String: String] {
        Dictionary(projects.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
    }

    private var header: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Schedule").font(TokFont.display(TokFont.title1, .bold)).foregroundStyle(Tok.ink)
                Text(subtitle).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
            }
            Spacer()
            SegmentedControl(options: modeOptions, value: $mode)
            PillButton(title: "New schedule", icon: "plus") { sheet = ScheduleSheetContext(id: "new", editing: nil) }
        }
        .padding(.horizontal, 28).padding(.vertical, 18)
    }

    private var subtitle: String {
        let n = store?.schedules.count ?? 0
        return n == 0 ? "Queued messages & recurring tasks" : "\(n) scheduled"
    }

    private var modeOptions: [(value: Mode, label: String, icon: String?)] {
        [(.list, "List", "jobs"), (.calendar, "Calendar", "calendar")]
    }

    @ViewBuilder private var content: some View {
        if let store {
            if store.loading && store.schedules.isEmpty {
                Spinner(size: 22).tint(Tok.inkTertiary).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if store.schedules.isEmpty {
                emptyState
            } else {
                switch mode {
                case .list:
                    ScheduleListView(store: store, projectNames: projectNames) { s in
                        sheet = ScheduleSheetContext(id: s.id, editing: s)
                    }
                case .calendar:
                    ScheduleCalendarView(store: store) { s in
                        sheet = ScheduleSheetContext(id: s.id, editing: s)
                    }
                }
            }
        } else {
            Spinner(size: 22).tint(Tok.inkTertiary).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Icon(name: "clock", size: 30).foregroundStyle(.white)
                .frame(width: 60, height: 60)
                .background(LinearGradient(colors: [Tok.blue, Tok.indigo], startPoint: .topLeading, endPoint: .bottomTrailing))
                .clipShape(RoundedRectangle(cornerRadius: 17, style: .continuous))
            Text("Nothing scheduled").font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
            Text("Schedule a message from any chat, or create a recurring task.")
                .font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary).multilineTextAlignment(.center)
            PillButton(title: "New schedule", icon: "plus") { sheet = ScheduleSheetContext(id: "new", editing: nil) }
                .padding(.top, 4)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
