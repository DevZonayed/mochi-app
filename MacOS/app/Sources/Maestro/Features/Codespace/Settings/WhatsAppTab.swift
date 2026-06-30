import SwiftUI

/// Per-project WhatsApp chat assignment. Mirrors `ProjectPanel.tsx` WhatsAppBody: incoming messages
/// for assigned chats route to this project. Reuses the brain's listProjectWaChats / waListChats /
/// addProjectWaChat / removeProjectWaChat (already used by the top-level WhatsApp space).
struct WhatsAppTab: View {
    @Environment(AppEnv.self) private var env
    let project: Project

    @State private var assigned: [String]? = nil
    @State private var chats: [WaChat] = []
    @State private var blocked = false
    @State private var picking = false
    @State private var pickQuery = ""
    @State private var loaded = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if blocked {
                    (Text("Link your WhatsApp number in ").foregroundColor(Tok.inkSecondary)
                     + Text("Comms").fontWeight(.semibold).foregroundColor(Tok.ink)
                     + Text(" to assign chats to this project.").foregroundColor(Tok.inkSecondary))
                        .font(TokFont.text(TokFont.footnote)).fixedSize(horizontal: false, vertical: true)
                } else if assigned == nil {
                    Text("Loading…").font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                } else {
                    intro
                    if (assigned ?? []).isEmpty { emptyBox } else { ForEach(assigned ?? [], id: \.self) { assignedRow($0) } }
                    if picking { pickerCard } else { assignButton }
                }
            }
            .frame(maxWidth: 560, alignment: .leading)
            .padding(.horizontal, 16).padding(.top, 18).padding(.bottom, 28)
            .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .task { if !loaded { await load() } }
    }

    private var intro: some View {
        (Text("Chats assigned here are tracked for this project: incoming messages route to it, a chat that goes quiet is summarized to you, and the agent prefers these chats. Read & reply to any chat in the ").foregroundColor(Tok.inkSecondary)
         + Text("WhatsApp").fontWeight(.semibold).foregroundColor(Tok.ink)
         + Text(" space.").foregroundColor(Tok.inkSecondary))
            .font(TokFont.text(TokFont.footnote)).lineSpacing(3).fixedSize(horizontal: false, vertical: true)
    }

    private var emptyBox: some View {
        Text("No WhatsApp chats assigned yet.")
            .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
            .frame(maxWidth: .infinity).padding(20)
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(style: StrokeStyle(lineWidth: Tok.hairline, dash: [4, 3])).foregroundStyle(Tok.separatorStrong))
    }

    private func assignedRow(_ id: String) -> some View {
        HStack(spacing: 10) {
            Icon(name: "whatsapp", size: 16).foregroundStyle(Tok.green)
                .frame(width: 30, height: 30).background(Tok.green.opacity(0.16)).clipShape(Circle())
            Text(nameOf(id)).font(TokFont.text(TokFont.callout, .semibold)).foregroundStyle(Tok.ink).lineLimit(1)
            Spacer(minLength: 0)
            Button("Remove") { Task { await removeChat(id) } }
                .buttonStyle(.plain).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.red)
                .padding(.horizontal, 12).frame(height: 30)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private var assignButton: some View {
        Button { picking = true; pickQuery = "" } label: {
            HStack(spacing: 7) {
                Icon(name: "plus", size: 16, weight: .bold)
                Text("Assign a chat").font(TokFont.text(TokFont.callout, .semibold))
            }
            .foregroundStyle(.white).padding(.horizontal, 16).frame(height: 38)
            .background(Tok.green).clipShape(Capsule())
        }
        .buttonStyle(.plain).pressable()
    }

    private var pickerCard: some View {
        let candidates = chats.filter { c in
            !(assigned ?? []).contains(c.chatId)
            && (pickQuery.isEmpty || c.name.localizedCaseInsensitiveContains(pickQuery) || c.chatId.localizedCaseInsensitiveContains(pickQuery))
        }.prefix(50)
        return VStack(spacing: 0) {
            HStack(spacing: 8) {
                Icon(name: "search", size: 14).foregroundStyle(Tok.inkTertiary)
                TextField("Search chats to add", text: $pickQuery).textFieldStyle(.plain).font(TokFont.text(TokFont.footnote))
            }
            .padding(.horizontal, 12).frame(height: 40)
            .overlay(alignment: .bottom) { Tok.separator.frame(height: Tok.hairline) }

            ScrollView {
                VStack(spacing: 0) {
                    if candidates.isEmpty {
                        Text(chats.isEmpty ? "No chats synced yet." : "No more chats to add.")
                            .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkTertiary)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    } else {
                        ForEach(Array(candidates), id: \.chatId) { c in
                            Button { Task { await addChat(c.chatId) } } label: {
                                HStack(spacing: 6) {
                                    Text(c.name).font(TokFont.text(TokFont.footnote, .medium)).foregroundStyle(Tok.ink).lineLimit(1)
                                    Text("· \(c.kind)").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
                                    Spacer(minLength: 0)
                                    Icon(name: "plus", size: 15).foregroundStyle(Tok.green)
                                }
                                .padding(.horizontal, 12).padding(.vertical, 9).contentShape(Rectangle())
                            }.buttonStyle(.plain).hoverFill(Tok.fillTertiary, radius: 0)
                        }
                    }
                }
            }
            .frame(maxHeight: 240)

            Button("Cancel") { picking = false }.buttonStyle(.plain)
                .font(TokFont.text(TokFont.footnote, .semibold)).foregroundStyle(Tok.inkSecondary)
                .frame(maxWidth: .infinity).frame(height: 36)
                .overlay(alignment: .top) { Tok.separator.frame(height: Tok.hairline) }
        }
        .background(Tok.bgElevated).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    private func nameOf(_ id: String) -> String { chats.first { $0.chatId == id }?.name ?? id }

    private func load() async {
        loaded = true
        do { assigned = try await env.client.call("listProjectWaChats", ["projectId": project.id], as: [String].self) }
        catch { blocked = true; return }
        chats = (try? await env.client.call("waListChats", as: [WaChat].self)) ?? []
    }
    private func addChat(_ id: String) async {
        assigned = (try? await env.client.call("addProjectWaChat", ["projectId": project.id, "chatId": id], as: [String].self)) ?? assigned
    }
    private func removeChat(_ id: String) async {
        assigned = (try? await env.client.call("removeProjectWaChat", ["projectId": project.id, "chatId": id], as: [String].self)) ?? assigned
    }
}
