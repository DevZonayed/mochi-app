import SwiftUI

/// One feedback note (lenient decode of the brain's `Feedback`).
struct FeedbackItem: Codable, Identifiable {
    var id: String
    var category: String
    var message: String?
    var status: String?
    var createdAt: Double?
}

/// "Send feedback" modal — category (Bug/Idea/Other) + a note + the auto-attached context, plus a
/// "View all feedback" list. Mirrors the web `Feedback.tsx`. Calls `submitFeedback` / `listFeedback`.
struct FeedbackModal: View {
    @Environment(AppEnv.self) private var env
    var screen: String
    let onClose: () -> Void

    @State private var category = "idea"
    @State private var message = ""
    @State private var sending = false
    @State private var error: String?
    @State private var viewingAll = false
    @State private var all: [FeedbackItem] = []

    private let cats: [(id: String, label: String, icon: String, tint: Color)] = [
        ("bug", "Bug", "alert", Tok.red), ("idea", "Idea", "spark", Tok.blue), ("other", "Other", "chat", Tok.inkSecondary),
    ]
    private var version: String { Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "" }
    private var canSend: Bool { !message.trimmed.isEmpty && !sending }

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Tok.separator)
            if viewingAll { allList } else { compose }
        }
        .frame(width: 460)
        .background(Tok.bgElevated)
        .task { if viewingAll { await loadAll() } }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            Icon(name: "feedback", size: 18).foregroundStyle(Tok.blue)
                .frame(width: 34, height: 34).background(Tok.blue.opacity(0.14))
                .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
            VStack(alignment: .leading, spacing: 3) {
                Text(viewingAll ? "All feedback" : "Send feedback").font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
                Text(viewingAll ? "Everything you've sent from this Mac." : "Found a bug or have an idea? We read every note.")
                    .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
            }
            Spacer(minLength: 8)
            IconButton(icon: "x", size: 30, iconSize: 15) { onClose() }
        }
        .padding(.horizontal, 18).padding(.vertical, 16)
    }

    private var compose: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                ForEach(cats, id: \.id) { c in
                    let on = category == c.id
                    Button { category = c.id } label: {
                        HStack(spacing: 6) { Icon(name: c.icon, size: 13); Text(c.label).font(TokFont.text(TokFont.footnote, .semibold)) }
                            .foregroundStyle(on ? c.tint : Tok.inkSecondary)
                            .frame(maxWidth: .infinity).frame(height: 36)
                            .background(on ? c.tint.opacity(0.14) : Tok.fillSecondary)
                            .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                            .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(on ? c.tint.opacity(0.5) : .clear, lineWidth: 1))
                    }.buttonStyle(.plain)
                }
            }
            .padding(.top, 16)

            ZStack(alignment: .topLeading) {
                if message.isEmpty {
                    Text(placeholder).font(TokFont.text(TokFont.body)).foregroundStyle(Tok.inkTertiary)
                        .padding(.horizontal, 13).padding(.vertical, 12).allowsHitTesting(false)
                }
                TextEditor(text: $message).font(TokFont.text(TokFont.body)).foregroundStyle(Tok.ink)
                    .scrollContentBackground(.hidden).padding(.horizontal, 9).padding(.vertical, 8).frame(height: 118)
            }
            .background(Tok.fillTertiary).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Tok.separator, lineWidth: 1))
            .padding(.top, 12)

            HStack(spacing: 6) {
                Icon(name: "paperclip", size: 12).foregroundStyle(Tok.inkTertiary)
                Text("Attached:").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                ForEach([screen, version.isEmpty ? "" : "v\(version)", "darwin"].filter { !$0.isEmpty }, id: \.self) { t in
                    Text(t).font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkSecondary)
                        .padding(.horizontal, 7).padding(.vertical, 2).background(Tok.fillSecondary).clipShape(Capsule())
                }
            }
            .padding(.top, 11)

            if let error { Text(error).font(TokFont.text(TokFont.footnote, .medium)).foregroundStyle(Tok.red).padding(.top, 10) }

            HStack(spacing: 10) {
                Button("View all feedback") { viewingAll = true; Task { await loadAll() } }.buttonStyle(.plain)
                    .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.inkSecondary)
                Spacer()
                PillButton(title: "Cancel", kind: .plain) { onClose() }
                PillButton(title: sending ? "Sending…" : "Send", disabled: !canSend, busy: sending) { Task { await send() } }
            }
            .padding(.top, 18)
        }
        .padding(.horizontal, 18).padding(.bottom, 16)
    }

    private var allList: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if all.isEmpty {
                        Text("No feedback sent yet.").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary).padding(20)
                    } else {
                        ForEach(all) { f in
                            HStack(alignment: .top, spacing: 9) {
                                Circle().fill(tint(f.category)).frame(width: 7, height: 7).padding(.top, 5)
                                Text(f.message ?? "").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.ink).lineLimit(3)
                                Spacer(minLength: 0)
                            }
                            .padding(.horizontal, 18).padding(.vertical, 9)
                            Tok.separator.frame(height: Tok.hairline).padding(.leading, 18)
                        }
                    }
                }
            }
            .frame(height: 280)
            HStack {
                Button("Back") { viewingAll = false }.buttonStyle(.plain)
                    .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.blue)
                Spacer()
            }
            .padding(.horizontal, 18).padding(.vertical, 12)
            .overlay(alignment: .top) { Tok.separator.frame(height: Tok.hairline) }
        }
    }

    private var placeholder: String {
        switch category { case "bug": "What went wrong? What did you expect?"; case "idea": "What would make Maestro better?"; default: "Tell us what's on your mind…" }
    }
    private func tint(_ c: String) -> Color { c == "bug" ? Tok.red : c == "idea" ? Tok.blue : Tok.inkSecondary }

    private func send() async {
        sending = true; error = nil
        do {
            _ = try await env.client.call("submitFeedback", [
                "category": category, "message": message.trimmed, "source": "desktop",
                "context": ["screen": screen, "platform": "darwin"],
            ], as: FeedbackItem.self)
            onClose()
        } catch let e { error = (e as? RPCError)?.errorDescription ?? "\(e)"; sending = false }
    }
    private func loadAll() async {
        all = (try? await env.client.call("listFeedback", as: [FeedbackItem].self)) ?? []
    }
}
