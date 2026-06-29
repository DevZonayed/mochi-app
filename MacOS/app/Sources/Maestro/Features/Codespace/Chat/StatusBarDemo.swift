import SwiftUI
import AppKit

/// `Maestro --statusdemo` — a self-contained window that drives the `LiveStatusBar` through every
/// activity state (thinking · running · editing · reading · browsing · searching · responding ·
/// paused) with a synthetic `Job`, so the pinned chatbar status can be eyeballed WITHOUT booting the
/// brain (no sidecar, no engine, no WhatsApp/cron side effects). Mirrors the existing
/// `--selftest` / `--toolviz` harness convention in `MaestroApp.swift`.
enum StatusBarDemo {
    static func run() { StatusDemoApp.main() }
}

private struct StatusDemoApp: App {
    var body: some Scene {
        Window("LiveStatusBar — preview", id: "statusdemo") {
            StatusDemoView()
                .frame(minWidth: 720, minHeight: 520)
                .task { NSApp.activate(ignoringOtherApps: true) }
        }
        .defaultSize(width: 880, height: 620)
        .windowResizability(.contentMinSize)
    }
}

private struct StatusDemoView: View {
    @State private var idx = 1
    @State private var ticks = 0
    @State private var auto = true
    @State private var dark = true
    @State private var jumped = false
    @State private var start = Date()
    @State private var pauseUntil: Double = 0   // epoch ms, set when the paused scenario is entered

    private static let names = ["Thinking", "Running", "Editing", "Reading", "Browsing", "Searching", "Responding", "Paused"]
    private let timer = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle().fill(Tok.separator).frame(height: Tok.hairline)
            Spacer(minLength: 0)
            stage
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Tok.bg)
        .preferredColorScheme(dark ? .dark : .light)
        .onReceive(timer) { _ in tick() }
    }

    // MARK: header + controls

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("LiveStatusBar — live preview")
                        .font(TokFont.display(TokFont.title2, .bold)).foregroundStyle(Tok.ink)
                    Text("The strip that pins just above your composer while a turn runs. No brain — synthetic data.")
                        .font(TokFont.text(TokFont.footnote)).foregroundStyle(Tok.inkSecondary)
                }
                Spacer()
                Toggle("Auto", isOn: $auto).toggleStyle(.switch).tint(Tok.blue)
                    .fixedSize()
                Button { dark.toggle() } label: {
                    Image(systemName: dark ? "moon.fill" : "sun.max.fill")
                        .font(.system(size: 13, weight: .medium)).foregroundStyle(Tok.inkSecondary)
                        .frame(width: 30, height: 26).background(Tok.fillSecondary)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                }.buttonStyle(.plain).help("Toggle light/dark")
            }
            FlowLayout(spacing: 7, lineSpacing: 7) {
                ForEach(Array(Self.names.enumerated()), id: \.offset) { i, name in
                    Button { select(i) } label: {
                        Text(name)
                            .font(TokFont.text(TokFont.footnote, .semibold))
                            .foregroundStyle(idx == i ? .white : Tok.inkSecondary)
                            .padding(.horizontal, 12).frame(height: 30)
                            .background(idx == i ? Tok.blue : Tok.fillSecondary)
                            .clipShape(Capsule())
                    }.buttonStyle(.plain)
                }
            }
        }
        .padding(EdgeInsets(top: 22, leading: 24, bottom: 16, trailing: 24))
    }

    // MARK: stage (the bar above a faux composer)

    private var stage: some View {
        VStack(spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.down").font(.system(size: 10, weight: .bold)).foregroundStyle(Tok.inkTertiary)
                Text(jumped ? "Jumped to the running turn ✓" : "Tap the bar → it scrolls back to the live turn in the real app")
                    .font(TokFont.text(TokFont.caption)).foregroundStyle(jumped ? Tok.green : Tok.inkTertiary)
                    .animation(.easeOut(duration: 0.2), value: jumped)
            }
            LiveStatusBar(job: job, onJump: flashJump)
                .frame(maxWidth: 680)
            fauxComposer.frame(maxWidth: 680)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 24).padding(.bottom, 28)
    }

    /// A non-functional stand-in for the real Composer, just so the bar's placement reads correctly.
    private var fauxComposer: some View {
        VStack(spacing: 8) {
            HStack(alignment: .bottom) {
                Text("Send a message…").font(TokFont.text(14)).foregroundStyle(Tok.inkTertiary)
                Spacer()
                Image(systemName: "stop.fill").font(.system(size: 13, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 34, height: 34).background(Tok.red).clipShape(Circle())
                Image(systemName: "arrow.up").font(.system(size: 15, weight: .semibold)).foregroundStyle(.white)
                    .frame(width: 34, height: 34).background(Tok.blue).clipShape(Circle())
            }
            HStack(spacing: 6) {
                ForEach(["claude-opus-4-8", "BALANCED", "Plan", "Goal"], id: \.self) { t in
                    Text(t).font(TokFont.text(TokFont.caption, .semibold)).foregroundStyle(Tok.inkSecondary)
                        .padding(.horizontal, 9).frame(height: 26).background(Tok.fillSecondary)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
                Spacer()
                Text("⏎ to queue · ⌘⏎ to steer").font(TokFont.text(TokFont.caption)).foregroundStyle(Tok.inkTertiary)
            }
        }
        .padding(EdgeInsets(top: 12, leading: 14, bottom: 10, trailing: 12))
        .background(Tok.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Tok.separator, lineWidth: Tok.hairline))
    }

    // MARK: synthetic job

    private var job: Job {
        let createdMs = start.timeIntervalSince1970 * 1000
        let tokens = Double(40 * ticks + 180)
        let paused = idx == 7
        return Job(id: "demo", status: "running", input: "Build the live status bar",
                   effort: "balanced", tokens: tokens, engine: "claude-code", model: "claude-opus-4-8",
                   transcript: Self.transcript(idx),
                   pausedUntil: paused ? pauseUntil : nil,
                   pausedReason: paused ? "ScheduleWakeup" : nil,
                   createdAt: createdMs)
    }

    private static func tool(_ name: String, _ text: String) -> TranscriptItem {
        TranscriptItem(kind: "tool", text: text, name: name, toolStatus: "running", ts: 1)
    }

    private static func transcript(_ idx: Int) -> [TranscriptItem] {
        switch idx {
        case 0: return []                                                            // Thinking…
        case 1: return [tool("Bash", "npm test")]                                    // Running npm test…
        case 2: return [tool("Edit", "MacOS/app/Sources/Maestro/Features/Codespace/Chat/LiveStatusBar.swift")]
        case 3: return [tool("Read", "apps/desktop/electron/store.ts")]              // Reading …
        case 4: return [tool("WebFetch", "https://developer.apple.com/documentation/swiftui/timelineview")]
        case 5: return [tool("Grep", "liveActivity")]                                // Searching …
        case 6: return [TranscriptItem(kind: "text", text: "Here's the plan — I'll pin the status…", ts: 1)]
        default: return [TranscriptItem(kind: "thinking", text: "Parked until the wakeup fires", ts: 1)]
        }
    }

    // MARK: actions

    private func tick() {
        ticks += 1
        if auto && ticks % 3 == 0 { idx = (idx + 1) % Self.names.count; if idx == 7 { armPause() } }
    }
    private func select(_ i: Int) { auto = false; idx = i; if i == 7 { armPause() } }
    private func armPause() { pauseUntil = (Date().timeIntervalSince1970 + 95) * 1000 }
    private func flashJump() {
        jumped = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { jumped = false }
    }
}
