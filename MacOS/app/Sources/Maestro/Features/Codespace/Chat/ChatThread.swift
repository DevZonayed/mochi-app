import SwiftUI
import AppKit

/// The conversation pane: streamed transcript + composer. Owns a ChatThreadStore bound to the
/// active session (nil = a fresh chat that lazy-creates on first send).
struct ChatThread: View {
    @Environment(AppEnv.self) private var env
    let projectId: String
    let projectName: String
    @Binding var sessionId: String?
    var base: String? = nil       // base branch for a fresh chat (forked on first send)
    var flush: Bool = false
    var active: Bool = true
    let onSessionCreated: (ChatSession) -> Void
    var onOpenFile: (String) -> Void = { FilePreviewWindowController.shared.open(path: $0) }

    @State private var store: ChatThreadStore?
    /// Render only the last N turns (messenger-style) — older turns lazy-load on "Load earlier"
    /// or when the minimap jumps back. Keeps long chats smooth instead of mounting every turn.
    @State private var visibleCount = 8
    @State private var composerText = ""
    @State private var model = "auto"
    @State private var effort = "balanced"
    @State private var plan = false
    @State private var goal = false
    @State private var autopilot = false
    @State private var review = false
    @State private var bgTasks: [BgTask] = []
    @State private var bgToken: Int?
    @State private var schedStore: ScheduleStore?

    /// Absolute root that tool paths are relative to. The brain runs each session in its own git
    /// worktree and relativizes tool paths against THAT cwd, so prefer the session's worktreePath
    /// (falling back to the main checkout for non-repo sessions or before the first run).
    private var projectRoot: String? {
        let main = env.workspace?.projects.first { $0.id == projectId }?.path
        guard let sid = sessionId,
              let wt = env.workspace?.sessionsByProject[projectId]?.first(where: { $0.id == sid })?.worktreePath,
              !wt.isEmpty else { return main }
        return wt
    }

    var body: some View {
        VStack(spacing: 0) {
            transcript
            if !bgTasks.filter(\.isRunning).isEmpty { bgPanel.frame(maxWidth: 1180).padding(.horizontal, 20).padding(.bottom, 8) }
            if let err = store?.sendError {
                Text(err).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.red)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.bottom, 6)
            }
            if let schedStore, !schedStore.pending(forSession: sessionId).isEmpty {
                ScheduledQueuePanel(store: schedStore, sessionId: sessionId) { s in
                    composerText = s.prompt ?? ""
                    Task { await schedStore.delete(s.id) }
                }
                .frame(maxWidth: 1180).padding(.horizontal, 20).padding(.bottom, 8)
            }
            Composer(text: $composerText, model: $model, effort: $effort, plan: $plan, goal: $goal,
                     autopilot: $autopilot, review: $review, sessionActive: sessionId != nil,
                     streaming: store?.streaming ?? false,
                     disabled: store == nil,
                     onSend: send, onStop: stop,
                     onSchedule: scheduleFromComposer)
                .frame(maxWidth: 1180)
                .padding(.horizontal, 20).padding(.bottom, 16)
                .onChange(of: autopilot) { _, v in Task { await store?.setAutopilot(v) } }
                .onChange(of: review) { _, v in Task { await store?.setReviewer(v) } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tok.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: flush ? 0 : 18, style: .continuous))
        .overlay { if !flush { RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline) } }
        .task {
            if store == nil { let s = ChatThreadStore(projectId: projectId, client: env.client); s.start(); store = s }
            if schedStore == nil { let s = ScheduleStore(client: env.client); await s.start(); schedStore = s }
            await store?.bind(sessionId)
            await loadBg()
            if bgToken == nil {
                bgToken = env.client.onEvent { ev in
                    guard ev.name == "bg", let t = decodeJSON(ev.data, as: BgTask.self), t.projectId == projectId else { return }
                    Task { @MainActor in
                        if let i = bgTasks.firstIndex(where: { $0.id == t.id }) { bgTasks[i] = t } else { bgTasks.append(t) }
                    }
                }
            }
        }
        .onChange(of: sessionId) { _, new in Task { await store?.bind(new) } }
        .onDisappear { store?.stop(); schedStore?.stop(); if let t = bgToken { env.client.removeHandler(t); bgToken = nil } }
    }

    private var bgPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(bgTasks.filter(\.isRunning)) { t in
                HStack(spacing: 8) {
                    Circle().fill(Tok.green).frame(width: 7, height: 7)
                    Text(t.command).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.ink).lineLimit(1)
                    Spacer()
                    Button("Stop") { Task { try? await env.client.callVoid("stopBgTask", ["id": t.id]); await loadBg() } }
                        .buttonStyle(.plain).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.red)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
            }
        }
        .background(Tok.bgGrouped).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private func loadBg() async {
        bgTasks = (try? await env.client.call("listBgTasks", ["projectId": projectId], as: [BgTask].self)) ?? []
    }

    @ViewBuilder private var transcript: some View {
        if let store, !store.turns.isEmpty {
            let all = store.turns
            let start = max(0, all.count - visibleCount)
            let windowed = Array(all[start...])
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        if start > 0 {
                            Button { loadEarlier(proxy, all: all) } label: {
                                HStack(spacing: 6) {
                                    Icon(name: "chevronDown", size: 11).rotationEffect(.degrees(180))
                                    Text("Load earlier messages").font(TokFont.text(TokFont.caption, .semibold))
                                }
                                .foregroundStyle(Tok.blue).padding(.horizontal, 12).padding(.vertical, 6)
                                .background(Tok.fillTertiary).clipShape(Capsule())
                            }
                            .buttonStyle(.plain).frame(maxWidth: .infinity)
                        }
                        ForEach(windowed) { job in
                            TurnView(job: job,
                                     projectRoot: projectRoot,
                                     answerable: job.id == all.last?.id && job.isRunning,
                                     onAnswer: { ans in Task { await store.answer(ans) } },
                                     onOpenFile: onOpenFile)
                                .id(job.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .frame(maxWidth: 1180)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 24).padding(.vertical, 22)
                }
                // Messenger-style: start (and stay) pinned to the bottom; growth at the bottom
                // follows the live stream without a per-token scroll, which is what caused the jank.
                .defaultScrollAnchor(.bottom)
                // Click empty transcript space → drop focus so any text selection clears.
                .background { Color.clear.contentShape(Rectangle()).onTapGesture { NSApp.keyWindow?.makeFirstResponder(nil) } }
                .overlay(alignment: .trailing) {
                    TurnMinimap(turns: all.map { MiniTurn(id: $0.id, title: miniTitle($0), running: $0.isRunning) },
                                onJump: { id in jump(to: id, proxy: proxy, all: all) })
                        .padding(.trailing, 2)
                }
                .onChange(of: sessionId) { _, _ in visibleCount = 8 }
            }
        } else {
            emptyState
        }
    }

    private func miniTitle(_ job: Job) -> String {
        let first = job.input.split(separator: "\n").first.map(String.init) ?? job.input
        let t = first.trimmed
        return t.isEmpty ? "Untitled" : t
    }

    /// Reveal +12 older turns while keeping the current top turn in view.
    private func loadEarlier(_ proxy: ScrollViewProxy, all: [Job]) {
        let anchorId = Array(all.suffix(visibleCount)).first?.id
        visibleCount = min(all.count, visibleCount + 12)
        if let anchorId {
            Task { @MainActor in try? await Task.sleep(nanoseconds: 80_000_000); proxy.scrollTo(anchorId, anchor: .top) }
        }
    }

    /// Jump to any turn from the minimap — expand the window to include it, then scroll.
    private func jump(to id: String, proxy: ScrollViewProxy, all: [Job]) {
        if let idx = all.firstIndex(where: { $0.id == id }) {
            let needed = all.count - idx + 1
            if needed > visibleCount { visibleCount = min(all.count, needed) }
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 90_000_000)
            withAnimation(.smooth(duration: 0.25)) { proxy.scrollTo(id, anchor: .top) }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Icon(name: "terminal", size: 26).foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(LinearGradient(colors: [Tok.blue, Tok.purple], startPoint: .topLeading, endPoint: .bottomTrailing))
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
            Text("What should we build in \(projectName)?")
                .font(TokFont.display(TokFont.title1, .bold)).foregroundStyle(Tok.ink).multilineTextAlignment(.center)
            Text("Describe a task and the agent gets to work.")
                .font(TokFont.text(TokFont.subhead)).foregroundStyle(Tok.inkSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func send() {
        let text = composerText.trimmed
        guard !text.isEmpty, let store else { return }
        composerText = ""
        Task {
            await store.send(text, effort: effort, plan: plan, goal: goal, modelKey: model, base: base) { session in
                onSessionCreated(session)
                sessionId = session.id
            }
        }
    }

    private func stop() {
        guard let store, let running = store.turns.last(where: { $0.isRunning }) else { return }
        Task { await store.cancel(running) }
    }

    /// Schedule the typed message for later (composer clock button). Clears the composer on success;
    /// the queued message then appears in the panel above with a live countdown.
    private func scheduleFromComposer(_ req: ScheduleRequest) {
        let text = composerText.trimmed
        guard !text.isEmpty, let schedStore else { return }
        Task { @MainActor in
            let ok: Bool
            switch req {
            case .once(let fireAt):
                ok = await schedStore.scheduleMessage(fireAt: fireAt, prompt: text, sessionId: sessionId,
                                                      projectId: projectId, effort: effort, plan: plan, goal: goal)
            case .repeating(let opts):
                ok = await schedStore.createRecurring(title: String(text.prefix(60)), prompt: text,
                                                      projectId: projectId, sessionId: sessionId, opts: opts, effort: effort)
            }
            if ok { composerText = "" }
        }
    }
}
