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
    @State private var attachments: [ComposerAttachment] = []
    /// Messages typed while a turn is running — they wait here and drain one-at-a-time when the turn
    /// finishes (so the agent isn't hit with several prompts at once). Survives restart per session.
    @State private var queue: [QueuedItem] = []
    /// True while a send/drain is in flight — serializes the drain so a steer or concurrent
    /// running-state transition can't double-send the queue.
    @State private var dispatching = false
    /// Per-chat worker model. Seeded from the Settings default worker for a fresh chat, then
    /// restored per-session on reopen (the brain persists `session.primary` on each send; we also
    /// keep a local map so a re-pick is remembered instantly).
    @State private var model = "auto"
    /// Default reviewer model key ("off" or "<provider>:<model>") — applied to each send so the
    /// reviewer runs the user's chosen model when Review is enabled.
    @State private var reviewerKey = ""
    @State private var defaultWorkerKey = ""
    /// Global reviewer default (empty when the workspace reviewer is "off") — seeds fresh chats.
    @State private var defaultReviewerKey = ""
    /// Persisted per-session worker model picks: { sessionId: pickerKey }.
    @AppStorage("maestro.chat.models") private var chatModelsJSON = "{}"
    /// Persisted per-session reviewer model picks: { sessionId: pickerKey }.
    @AppStorage("maestro.chat.reviewers") private var chatReviewersJSON = "{}"
    @State private var effort = "balanced"
    @State private var plan = false
    @State private var goal = false
    @State private var autopilot = false
    @State private var review = false
    @State private var bgTasks: [BgTask] = []
    @State private var bgToken: Int?
    @State private var schedStore: ScheduleStore?
    @State private var suppressTranscriptBottomPin = false

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
            if !queue.isEmpty {
                LocalQueuePanel(items: queue,
                                onEdit: { item in composerText = item.text; queue.removeAll { $0.id == item.id }; persistQueue() },
                                onRemove: { item in queue.removeAll { $0.id == item.id }; persistQueue() },
                                onSendNow: { item in
                                    queue.removeAll { $0.id == item.id }; persistQueue()
                                    if let running = store?.turns.last(where: { $0.isRunning }) { Task { await store?.cancel(running) } }
                                    dispatchSend(text: item.text, atts: item.atts, effort: item.effort, plan: item.plan, goal: item.goal)
                                })
                .frame(maxWidth: 1180).padding(.horizontal, 20).padding(.bottom, 8)
            }
            if let schedStore {
                ScheduledQueuePanel(store: schedStore, sessionId: sessionId) { s in
                    composerText = s.prompt ?? ""
                    Task { await schedStore.delete(s.id) }
                }
                .frame(maxWidth: 1180).padding(.horizontal, 20).padding(.bottom, 8)
            }
            Composer(text: $composerText, attachments: $attachments, model: $model, effort: $effort, plan: $plan, goal: $goal,
                     autopilot: $autopilot, review: $review, reviewerKey: $reviewerKey, sessionActive: sessionId != nil,
                     streaming: store?.streaming ?? false,
                     disabled: store == nil,
                     onSend: send, onStop: stop, onSendNow: sendNow,
                     onSchedule: scheduleFromComposer, queuedCount: queue.count,
                     onReviewChanged: { v in reviewToggled(v) },
                     onAutopilotChanged: { v in Task { await store?.setAutopilot(v) } })
                .frame(maxWidth: 1180)
                .padding(.horizontal, 20).padding(.bottom, 16)
                .onChange(of: store?.streaming ?? false) { _, running in if !running { drainQueue() } }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tok.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: flush ? 0 : 18, style: .continuous))
        .overlay { if !flush { RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline) } }
        .task {
            if store == nil { let s = ChatThreadStore(projectId: projectId, client: env.client); s.start(); store = s }
            if schedStore == nil { let s = ScheduleStore(client: env.client); await s.start(); schedStore = s }
            await store?.bind(sessionId)
            await seedRoles()
            loadQueue()
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
        .onChange(of: sessionId) { _, new in Task { await store?.bind(new) }; restoreModel(for: new); restoreReviewer(for: new); restoreToggles(for: new); loadQueue() }
        .onChange(of: model) { _, v in if let sid = sessionId, v != "auto", !v.isEmpty { setChatModel(sid, v) } }
        .onChange(of: reviewerKey) { _, v in if let sid = sessionId, v != "off", !v.isEmpty { setChatReviewer(sid, v) } }
        // Deleting an inline chip removes its «attach:id» marker from the text — drop that payload too.
        .onChange(of: composerText) { _, t in
            if !attachments.isEmpty { attachments.removeAll { !t.contains("«attach:\($0.id)»") } }
        }
        .onDisappear { store?.stop(); schedStore?.stop(); if let t = bgToken { env.client.removeHandler(t); bgToken = nil } }
    }

    // MARK: - Per-chat model memory

    private func chatModels() -> [String: String] {
        (try? JSONDecoder().decode([String: String].self, from: Data(chatModelsJSON.utf8))) ?? [:]
    }
    private func setChatModel(_ sid: String, _ key: String) {
        var m = chatModels(); m[sid] = key
        chatModelsJSON = String(data: (try? JSONEncoder().encode(m)) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
    }
    private func sessionPrimaryKey(_ sid: String) -> String? {
        env.workspace?.sessionsByProject[projectId]?.first { $0.id == sid }?.primaryKey
    }

    // MARK: - Per-chat reviewer-model memory (mirrors the worker-model memory above)

    private func chatReviewers() -> [String: String] {
        (try? JSONDecoder().decode([String: String].self, from: Data(chatReviewersJSON.utf8))) ?? [:]
    }
    private func setChatReviewer(_ sid: String, _ key: String) {
        var m = chatReviewers(); m[sid] = key
        chatReviewersJSON = String(data: (try? JSONEncoder().encode(m)) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
    }
    private func sessionReviewerKey(_ sid: String) -> String? {
        env.workspace?.sessionsByProject[projectId]?.first { $0.id == sid }?.reviewerModelKey
    }

    /// Load the Settings defaults, then settle `model` to: this chat's remembered pick → the brain's
    /// persisted per-chat model → the default worker. Same precedence settles the reviewer model.
    private func seedRoles() async {
        guard let roles = try? await env.client.call("getRoles", as: Roles.self) else { return }
        defaultWorkerKey = roles.primary.key
        // Global reviewer default, but never "off" — the Review toggle owns whether the reviewer runs,
        // so an empty default lets the composer's reviewer ModelPicker self-seed a real runnable model.
        defaultReviewerKey = roles.reviewer.isOff ? "" : roles.reviewer.key
        // Authoritative initial pick: this chat's remembered model → the brain's persisted per-chat
        // model → the Settings default worker. Set unconditionally so a fresh chat honors the default
        // even though the composer's ModelPicker self-seeds to a favorite first.
        let restored = sessionId.flatMap { chatModels()[$0] } ?? sessionId.flatMap { sessionPrimaryKey($0) }
        if let restored, !restored.isEmpty { model = restored }
        else if !roles.primary.key.isEmpty { model = roles.primary.key }
        // Same precedence for the reviewer: this chat's remembered reviewer → the brain's persisted
        // per-chat reviewer → the global reviewer default → empty (picker self-seeds when shown).
        let restoredRev = sessionId.flatMap { chatReviewers()[$0] } ?? sessionId.flatMap { sessionReviewerKey($0) }
        if let restoredRev, restoredRev != "off", !restoredRev.isEmpty { reviewerKey = restoredRev }
        else { reviewerKey = defaultReviewerKey }
        // Reflect the session's persisted Review / Autopilot state on the composer toggles.
        restoreToggles(for: sessionId)
    }

    /// Restore a chat's remembered worker model when switching sessions. Opening a brand-new chat
    /// (nil) resets to the default worker so new chats start there, as Settings advertises.
    private func restoreModel(for sid: String?) {
        guard let sid else { if !defaultWorkerKey.isEmpty { model = defaultWorkerKey }; return }
        if let saved = chatModels()[sid], !saved.isEmpty { model = saved }
        else if let key = sessionPrimaryKey(sid), !key.isEmpty { model = key }
        else if !defaultWorkerKey.isEmpty, model == "auto" { model = defaultWorkerKey }
        if model != "auto", !model.isEmpty { setChatModel(sid, model) }
    }

    /// Restore a chat's remembered reviewer model when switching sessions: this chat's remembered
    /// pick → the brain's persisted per-chat reviewer → the global reviewer default (empty if the
    /// workspace reviewer is "off", so the composer's reviewer ModelPicker self-seeds a real model).
    private func restoreReviewer(for sid: String?) {
        guard let sid else { reviewerKey = defaultReviewerKey; return }
        if let saved = chatReviewers()[sid], saved != "off", !saved.isEmpty { reviewerKey = saved }
        else if let key = sessionReviewerKey(sid), !key.isEmpty { reviewerKey = key }
        else { reviewerKey = defaultReviewerKey }
        if reviewerKey != "off", !reviewerKey.isEmpty { setChatReviewer(sid, reviewerKey) }
    }

    /// Sync the Review / Autopilot pills to the session's persisted state WITHOUT writing back to the
    /// brain — those writes happen only on a user tap (the composer's onReviewChanged/onAutopilotChanged
    /// callbacks). A fresh chat (nil) resets both to off.
    private func restoreToggles(for sid: String?) {
        let s = sid.flatMap { id in env.workspace?.sessionsByProject[projectId]?.first { $0.id == id } }
        let reviewing = s?.reviewerEnabled ?? false
        review = reviewing
        autopilot = s?.autoPilot ?? false
        // A session restored with Review ON must carry a concrete reviewer model, or the reviewed
        // turn would silently fall back to "off". Seed the best available key when none is set.
        if reviewing, reviewerKey.isEmpty || reviewerKey == "off" { reviewerKey = fallbackReviewerKey() }
    }

    /// A user tap on the Review pill. Turning it on with no reviewer model yet picks a concrete one
    /// up front, so the very first reviewed turn actually runs a model instead of silently falling
    /// back to "off".
    private func reviewToggled(_ on: Bool) {
        if on, reviewerKey.isEmpty || reviewerKey == "off" { reviewerKey = fallbackReviewerKey() }
        Task { await store?.setReviewer(on) }
    }

    /// Best available runnable model key for the reviewer when none is chosen — favorite/first from
    /// the catalog, else the current worker model, else the workspace worker default. Effectively
    /// never empty (roles.primary.key is always set), so a reviewed turn can't fall back to "off"
    /// just because the model catalog hasn't finished loading yet.
    private func fallbackReviewerKey() -> String {
        if let k = firstRunnableReviewerKey() { return k }
        if model != "auto", !model.isEmpty { return model }
        if !defaultWorkerKey.isEmpty { return defaultWorkerKey }
        return defaultReviewerKey
    }

    /// First favorite runnable model (else the first runnable) from the shared catalog cache — mirrors
    /// the ModelPicker's own default seed, so the reviewer is set before the picker is ever opened.
    private func firstRunnableReviewerKey() -> String? {
        let runnable = ModelCatalogCache.groups.filter(\.runnable).flatMap(\.models)
        let favs = Set((UserDefaults.standard.string(forKey: "maestro.favoriteModels") ?? "")
            .split(separator: ",").map(String.init))
        return runnable.first(where: { favs.contains($0.key) })?.key ?? runnable.first?.key
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
        if let store {
            if !store.turns.isEmpty {
                transcriptList(store)
            } else if store.loading {
                // Existing chat whose transcript is still loading — show a skeleton, NOT the
                // "What should we build?" placeholder (which momentarily flashed before).
                transcriptSkeleton
            } else {
                emptyState
            }
        } else {
            emptyState
        }
    }

    @ViewBuilder private func transcriptList(_ store: ChatThreadStore) -> some View {
        let all = store.turns
        let start = max(0, all.count - visibleCount)
        let windowed = Array(all[start...])
        let scrollResetKey = sessionId ?? "new"
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
                .background {
                    BottomPinnedScrollObserver(resetKey: scrollResetKey,
                                               enabled: !suppressTranscriptBottomPin)
                }
            }
            // Messenger-style auto-follow, but only while the viewport is already near the bottom.
            // The observer (above) pins explicitly + coalesces stream resizes, and forces thin overlay
            // scrollers — together they avoid the `.defaultScrollAnchor(.bottom)` re-anchor shake.
            // Click empty transcript space → drop focus so any text selection clears.
            .background { Color.clear.contentShape(Rectangle()).onTapGesture { NSApp.keyWindow?.makeFirstResponder(nil) } }
            .overlay(alignment: .trailing) {
                TurnMinimap(turns: all.map { MiniTurn(id: $0.id, title: miniTitle($0), running: $0.isRunning) },
                            onJump: { id in jump(to: id, proxy: proxy, all: all) })
                    .padding(.trailing, 2)
            }
            .onChange(of: sessionId) { _, _ in visibleCount = 8 }
        }
    }

    /// Shimmering placeholder rows shown while an existing chat's transcript loads (cache miss),
    /// so opening a chat never flashes the empty "What should we build?" state.
    private var transcriptSkeleton: some View {
        VStack(alignment: .leading, spacing: 26) {
            ForEach(0..<4, id: \.self) { i in
                VStack(alignment: i.isMultiple(of: 2) ? .trailing : .leading, spacing: 8) {
                    skelBar(width: i.isMultiple(of: 2) ? 220 : 150, height: 34)   // bubble / header
                    if !i.isMultiple(of: 2) {
                        skelBar(width: 460, height: 12)
                        skelBar(width: 380, height: 12)
                    }
                }
                .frame(maxWidth: .infinity, alignment: i.isMultiple(of: 2) ? .trailing : .leading)
            }
        }
        .frame(maxWidth: 1180).frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 24).padding(.vertical, 22)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .modifier(SkeletonShimmer())
    }

    private func skelBar(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous)
            .fill(Tok.fillTertiary)
            .frame(width: width, height: height)
    }

    private func miniTitle(_ job: Job) -> String {
        let first = job.input.split(separator: "\n").first.map(String.init) ?? job.input
        let t = first.trimmed
        return t.isEmpty ? "Untitled" : t
    }

    /// Reveal +12 older turns while keeping the current top turn in view.
    private func loadEarlier(_ proxy: ScrollViewProxy, all: [Job]) {
        let anchorId = Array(all.suffix(visibleCount)).first?.id
        suppressTranscriptBottomPin = true
        visibleCount = min(all.count, visibleCount + 12)
        if let anchorId {
            Task { @MainActor in
                try? await Task.sleep(nanoseconds: 80_000_000)
                proxy.scrollTo(anchorId, anchor: .top)
                try? await Task.sleep(nanoseconds: 120_000_000)
                suppressTranscriptBottomPin = false
            }
        } else {
            suppressTranscriptBottomPin = false
        }
    }

    /// Jump to any turn from the minimap — expand the window to include it, then scroll.
    private func jump(to id: String, proxy: ScrollViewProxy, all: [Job]) {
        suppressTranscriptBottomPin = true
        if let idx = all.firstIndex(where: { $0.id == id }) {
            let needed = all.count - idx + 1
            if needed > visibleCount { visibleCount = min(all.count, needed) }
        }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 90_000_000)
            withAnimation(.smooth(duration: 0.25)) { proxy.scrollTo(id, anchor: .top) }
            try? await Task.sleep(nanoseconds: 280_000_000)
            suppressTranscriptBottomPin = false
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

    /// Enter: send now if idle, else QUEUE behind the running turn (a wakeup-paused turn still counts
    /// as running, so messages correctly hold until it actually finishes).
    private func send() {
        let text = composerText.trimmed
        guard !text.isEmpty || !attachments.isEmpty, let store else { return }
        let atts = attachments
        composerText = ""; attachments = []
        if store.streaming {
            queue.append(QueuedItem(id: UUID().uuidString, text: text, atts: atts, effort: effort, plan: plan, goal: goal))
            persistQueue()
        } else {
            dispatchSend(text: text, atts: atts, effort: effort, plan: plan, goal: goal)
        }
    }

    /// ⌘↩: interrupt the running turn and send this message immediately (steer).
    private func sendNow() {
        let text = composerText.trimmed
        guard !text.isEmpty || !attachments.isEmpty, let store else { return }
        let atts = attachments
        composerText = ""; attachments = []
        // `dispatching` is set synchronously below, so the cancel's running→idle transition can't
        // sneak in a concurrent drain before the steered send creates its own running turn.
        if let running = store.turns.last(where: { $0.isRunning }) { Task { await store.cancel(running) } }
        dispatchSend(text: text, atts: atts, effort: effort, plan: plan, goal: goal)
    }

    private func dispatchSend(text: String, atts: [ComposerAttachment], effort: String, plan: Bool, goal: Bool) {
        guard let store else { return }
        dispatching = true
        Task {
            await store.send(text, effort: effort, plan: plan, goal: goal, modelKey: model,
                             reviewerKey: reviewerKey.isEmpty ? nil : reviewerKey, base: base, attachments: atts) { session in
                onSessionCreated(session)
                sessionId = session.id
            }
            dispatching = false
            // Continue the chain even if the send FAILED (no running turn → no streaming transition
            // would otherwise re-fire the drain, stranding the rest of the queue).
            drainQueue()
        }
    }

    /// Fire the next queued message once the running turn settles (drains sequentially). The
    /// `dispatching` guard serializes drains so a steer / concurrent transition can't double-send.
    private func drainQueue() {
        guard let store, !dispatching, !store.streaming, !queue.isEmpty else { return }
        let next = queue.removeFirst()
        persistQueue()
        dispatchSend(text: next.text, atts: next.atts, effort: next.effort, plan: next.plan, goal: next.goal)
    }

    private func stop() {
        guard let store, let running = store.turns.last(where: { $0.isRunning }) else { return }
        Task { await store.cancel(running) }
    }

    // MARK: - Local message queue (persisted per session, options included)

    private func queueKey(_ sid: String) -> String { "maestro.chat.queue.\(sid)" }
    private func loadQueue() {
        guard let sid = sessionId,
              let raw = UserDefaults.standard.data(forKey: queueKey(sid)),
              let saved = try? JSONDecoder().decode([PersistedQueueItem].self, from: raw) else { queue = []; return }
        queue = saved.map { QueuedItem(id: UUID().uuidString, text: $0.text, atts: [], effort: $0.effort, plan: $0.plan, goal: $0.goal) }
    }
    private func persistQueue() {
        guard let sid = sessionId else { return }
        let key = queueKey(sid)
        if queue.isEmpty { UserDefaults.standard.removeObject(forKey: key) }
        else if let raw = try? JSONEncoder().encode(queue.map { PersistedQueueItem(text: $0.text, effort: $0.effort, plan: $0.plan, goal: $0.goal) }) {
            UserDefaults.standard.set(raw, forKey: key)
        }
    }

    /// Schedule the typed message for later (composer clock button). Clears the composer on success;
    /// the queued message then appears in the panel above with a live countdown.
    private func scheduleFromComposer(_ req: ScheduleRequest) {
        let text = composerText.trimmed
        guard !text.isEmpty, let schedStore else { return }
        Task { @MainActor in
            // A fresh chat has no session yet — eager-create one so the queued message binds to a real
            // chat and shows its countdown in the panel above the composer (instead of vanishing).
            var sid = sessionId
            if sid == nil, let s = try? await env.client.call("createSession", ["projectId": projectId], as: ChatSession.self) {
                onSessionCreated(s); sessionId = s.id; sid = s.id
            }
            let ok: Bool
            switch req {
            case .once(let fireAt):
                ok = await schedStore.scheduleMessage(fireAt: fireAt, prompt: text, sessionId: sid,
                                                      projectId: projectId, effort: effort, plan: plan, goal: goal)
            case .repeating(let opts):
                ok = await schedStore.createRecurring(title: String(text.prefix(60)), prompt: text,
                                                      projectId: projectId, sessionId: sid, opts: opts, effort: effort)
            }
            if ok {
                composerText = ""
                await schedStore.reload()
            }
        }
    }
}

/// Gentle opacity pulse for skeleton placeholders.
private struct SkeletonShimmer: ViewModifier {
    @State private var dim = false
    func body(content: Content) -> some View {
        content.opacity(dim ? 0.5 : 1)
            .onAppear { withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true } }
    }
}

/// A message typed while the agent was running — held until the current turn finishes.
struct QueuedItem: Identifiable, Equatable {
    let id: String
    var text: String
    var atts: [ComposerAttachment]
    var effort: String
    var plan: Bool
    var goal: Bool
}

/// The persisted form of a queued message (text + send options; attachments don't survive restart).
private struct PersistedQueueItem: Codable {
    var text: String
    var effort: String
    var plan: Bool
    var goal: Bool
}

/// The "N queued" box above the composer: messages waiting for the running turn to finish, each
/// with edit (refill the composer), send-now (interrupt & steer), and remove.
private struct LocalQueuePanel: View {
    let items: [QueuedItem]
    let onEdit: (QueuedItem) -> Void
    let onRemove: (QueuedItem) -> Void
    let onSendNow: (QueuedItem) -> Void
    @State private var expanded = true

    var body: some View {
        VStack(spacing: 0) {
            Button { withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) { expanded.toggle() } } label: {
                HStack(spacing: 8) {
                    Icon(name: "layers", size: 13).foregroundStyle(Tok.purple)
                    Text("\(items.count) queued message\(items.count == 1 ? "" : "s")")
                        .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink)
                    Text("· sends when the turn finishes").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                    Spacer()
                    Icon(name: "chevronRight", size: 11).foregroundStyle(Tok.inkTertiary).rotationEffect(.degrees(expanded ? 90 : 0))
                }
                .padding(.horizontal, 12).padding(.vertical, 9).contentShape(Rectangle())
            }.buttonStyle(.plain)
            if expanded {
                ForEach(Array(items.enumerated()), id: \.element.id) { i, item in
                    HStack(spacing: 10) {
                        Text("\(i + 1)").font(TokFont.mono(TokFont.caption, .semibold)).foregroundStyle(Tok.inkTertiary).frame(width: 16)
                        Text(item.text.isEmpty ? "Attachment" : item.text)
                            .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.ink).lineLimit(1)
                        if !item.atts.isEmpty {
                            Icon(name: "paperclip", size: 11).foregroundStyle(Tok.inkTertiary)
                        }
                        Spacer(minLength: 8)
                        qbtn("arrowRight") { onSendNow(item) }.help("Send now — interrupt and steer")
                        qbtn("pencil") { onEdit(item) }.help("Edit in composer")
                        qbtn("x") { onRemove(item) }.help("Remove")
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .overlay(alignment: .top) { Tok.separator.frame(height: Tok.hairline).padding(.leading, 12) }
                }
            }
        }
        .background(Tok.bgGrouped)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private func qbtn(_ icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name: icon, size: 13).foregroundStyle(Tok.inkSecondary)
                .frame(width: 24, height: 24).hoverFill(Tok.fillSecondary, radius: 6).contentShape(Rectangle())
        }.pressable()
    }
}
