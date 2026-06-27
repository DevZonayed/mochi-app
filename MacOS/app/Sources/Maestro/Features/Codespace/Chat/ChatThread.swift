import SwiftUI

/// The conversation pane: streamed transcript + composer. Owns a ChatThreadStore bound to the
/// active session (nil = a fresh chat that lazy-creates on first send).
struct ChatThread: View {
    @Environment(AppEnv.self) private var env
    let projectId: String
    let projectName: String
    @Binding var sessionId: String?
    let onSessionCreated: (ChatSession) -> Void

    @State private var store: ChatThreadStore?
    @State private var composerText = ""
    @State private var model = "auto"
    @State private var effort = "balanced"
    @State private var plan = false
    @State private var goal = false
    @State private var bgTasks: [BgTask] = []
    @State private var bgToken: Int?

    var body: some View {
        VStack(spacing: 0) {
            transcript
            if !bgTasks.filter(\.isRunning).isEmpty { bgPanel.frame(maxWidth: 1180).padding(.horizontal, 20).padding(.bottom, 8) }
            if let err = store?.sendError {
                Text(err).font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.red)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 20).padding(.bottom, 6)
            }
            Composer(text: $composerText, model: $model, effort: $effort, plan: $plan, goal: $goal,
                     streaming: store?.streaming ?? false,
                     disabled: store == nil,
                     onSend: send, onStop: stop)
                .frame(maxWidth: 1180)
                .padding(.horizontal, 20).padding(.bottom, 16)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Tok.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
        .task {
            if store == nil { let s = ChatThreadStore(projectId: projectId, client: env.client); s.start(); store = s }
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
        .onDisappear { store?.stop(); if let t = bgToken { env.client.removeHandler(t); bgToken = nil } }
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
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 22) {
                        ForEach(store.turns) { job in
                            TurnView(job: job,
                                     answerable: job.id == store.turns.last?.id && job.isRunning,
                                     onAnswer: { ans in Task { await store.answer(ans) } })
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .frame(maxWidth: 1180)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 24).padding(.vertical, 22)
                }
                .onChange(of: store.turns.count) { proxy.scrollTo("bottom", anchor: .bottom) }
                .onChange(of: store.turns.last?.updatedAt) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        } else {
            emptyState
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
            await store.send(text, effort: effort, plan: plan, goal: goal, modelKey: model) { session in
                onSessionCreated(session)
                sessionId = session.id
            }
        }
    }

    private func stop() {
        guard let store, let running = store.turns.last(where: { $0.isRunning }) else { return }
        Task { await store.cancel(running) }
    }
}
