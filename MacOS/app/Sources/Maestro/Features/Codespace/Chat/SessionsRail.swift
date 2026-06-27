import SwiftUI

/// The 236px sessions rail: New chat, Recent (active) sessions, an Archived collapsible, with
/// per-row inline rename + archive + delete. `activeSessionId == nil` means a fresh chat.
struct SessionsRail: View {
    @Bindable var store: SessionsStore
    @Binding var activeSessionId: String?

    @State private var showArchived = false
    @State private var renamingId: String?
    @State private var renameText = ""
    @State private var hoverId: String?

    var body: some View {
        VStack(spacing: 0) {
            Button { activeSessionId = nil } label: {
                HStack(spacing: 6) {
                    Icon(name: "plus", size: 15, weight: .bold).foregroundStyle(Tok.blue)
                    Text("New chat").font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.ink)
                }
                .frame(maxWidth: .infinity).frame(height: 36).background(Tok.fillSecondary)
                .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 10).padding(.top, 11).padding(.bottom, 9)

            if store.loading {
                Spinner(size: 18).tint(Tok.inkTertiary).frame(maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        if !store.active.isEmpty {
                            sectionHeader("Recent")
                            ForEach(store.active) { row($0) }
                        } else {
                            Text("No chats yet.\nStart one on the right.")
                                .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                                .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.vertical, 22)
                        }
                        if !store.archived.isEmpty {
                            Button { showArchived.toggle() } label: {
                                HStack(spacing: 5) {
                                    Icon(name: showArchived ? "chevronDown" : "chevronRight", size: 11)
                                    Text("Archived (\(store.archived.count))").font(TokFont.text(TokFont.caption, .bold)).tracking(0.5)
                                }
                                .foregroundStyle(Tok.inkTertiary).padding(.horizontal, 8).padding(.top, 8).padding(.bottom, 4)
                            }.buttonStyle(.plain)
                            if showArchived { ForEach(store.archived) { row($0) } }
                        }
                    }
                    .padding(.horizontal, 8).padding(.bottom, 10)
                }
            }
        }
        .frame(width: 236)
        .background(Tok.bgGrouped)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private func sectionHeader(_ t: String) -> some View {
        Text(t.uppercased()).font(TokFont.text(TokFont.caption, .bold)).tracking(0.5)
            .foregroundStyle(Tok.inkTertiary).padding(.horizontal, 8).padding(.top, 6).padding(.bottom, 4)
    }

    private func row(_ s: ChatSession) -> some View {
        let active = activeSessionId == s.id
        return HStack(spacing: 6) {
            VStack(alignment: .leading, spacing: 3) {
                if renamingId == s.id {
                    TextField("", text: $renameText)
                        .textFieldStyle(.plain).font(TokFont.text(TokFont.footnote))
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Tok.bgElevated)
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tok.blue, lineWidth: 1))
                        .onSubmit { commitRename(s) }
                } else {
                    Text(s.displayTitle)
                        .font(TokFont.text(TokFont.footnote, active ? .semibold : .medium))
                        .foregroundStyle(s.isArchived ? Tok.inkTertiary : (active ? Tok.ink : Tok.inkSecondary)).lineLimit(1)
                }
                if let c = s.codename {
                    Text(c).font(TokFont.mono(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                }
            }
            Spacer(minLength: 0)
            if hoverId == s.id && renamingId != s.id {
                HStack(spacing: 2) {
                    miniAction("pencil") { renamingId = s.id; renameText = s.title ?? "" }
                    miniAction("archive") { Task { await store.setArchived(s, !s.isArchived) } }
                    miniAction("trash") { Task { await store.delete(s); if activeSessionId == s.id { activeSessionId = nil } } }
                }
            }
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(active ? Tok.fillSecondary : .clear)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(alignment: .leading) { if active { Tok.blue.frame(width: 2.5).padding(.vertical, 9).clipShape(Capsule()) } }
        .contentShape(Rectangle())
        .onTapGesture { if renamingId != s.id { activeSessionId = s.id } }
        .onHover { hoverId = $0 ? s.id : (hoverId == s.id ? nil : hoverId) }
    }

    private func miniAction(_ icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Icon(name: icon, size: 12).foregroundStyle(Tok.inkTertiary).frame(width: 20, height: 20).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }

    private func commitRename(_ s: ChatSession) {
        let t = renameText.trimmed
        renamingId = nil
        guard !t.isEmpty, t != s.title else { return }
        Task { await store.rename(s, t) }
    }
}
