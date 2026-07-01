import SwiftUI

/// Identifies a ScheduleSheet presentation (create when `editing == nil`).
struct ScheduleSheetContext: Identifiable {
    let id: String
    let editing: Schedule?
    var prefillProjectId: String? = nil
}

/// Project name + color for the schedule list/calendar (mirrors the web `projMeta`).
struct SchedProjMeta { let name: String; let color: Color }

/// The top-level Schedule destination — "Scheduler": a Calendar ⇄ List of every schedule with a
/// "New schedule" sheet. Mirrors the web Scheduler.tsx.
struct ScheduleView: View {
    @Environment(AppEnv.self) private var env
    @State private var store: ScheduleStore?
    @State private var projects: [Project] = []
    @State private var mode: Mode = .calendar
    @State private var sheet: ScheduleSheetContext?

    enum Mode: Hashable { case calendar, list }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
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

    /// Project meta keyed by id (name + color); used by both list groups and calendar chips.
    private var projMeta: [String: SchedProjMeta] {
        Dictionary(projects.map { ($0.id, SchedProjMeta(name: $0.name, color: ProjectColor.color($0.color))) },
                   uniquingKeysWith: { a, _ in a })
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 14) {
                Text("Scheduler").font(TokFont.display(TokFont.largeTitle, .bold)).tracking(-0.6).foregroundStyle(Tok.ink)
                Spacer()
                SegmentedControl(options: [(.calendar, "Calendar", "calendar"), (.list, "List", "jobs")], value: $mode)
                PillButton(title: "New schedule", icon: "plus") { sheet = ScheduleSheetContext(id: "new", editing: nil) }
            }
            HStack(spacing: 8) {
                Icon(name: "shield", size: 14).foregroundStyle(Tok.green)
                Text("Schedules fire on this Mac while Maestro is running. A missed time rolls forward — or, with catch-up on, still runs later the same day.")
                    .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
            }
        }
        .padding(.horizontal, 28).padding(.top, 24).padding(.bottom, 18)
    }

    @ViewBuilder private var content: some View {
        if let store {
            if store.loading && store.schedules.isEmpty {
                Spinner(size: 22).tint(Tok.inkTertiary).frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                switch mode {
                case .calendar:
                    ScheduleCalendarView(store: store, projMeta: projMeta) { s in
                        sheet = ScheduleSheetContext(id: s.id, editing: s)
                    }
                    .padding(.horizontal, 28).padding(.bottom, 0)
                case .list:
                    ScheduleListView(store: store, projMeta: projMeta) { s in
                        sheet = ScheduleSheetContext(id: s.id, editing: s)
                    }
                }
            }
        } else {
            Spinner(size: 22).tint(Tok.inkTertiary).frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}
