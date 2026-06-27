import Foundation

/// Pure-logic checks for the tool-call de-swagger (run via `Maestro --toolviz`). No window, no
/// sidecar — just asserts the label/path transforms the chat transcript relies on.
enum ToolVizSelfTest {
    static func run() {
        var failures = 0
        func check(_ label: String, _ got: String, _ want: String) {
            let ok = got == want
            if !ok { failures += 1 }
            print("\(ok ? "OK " : "FAIL") \(label): \"\(got)\"\(ok ? "" : " ≠ \"\(want)\"")")
        }
        func checkB(_ label: String, _ got: Bool, _ want: Bool) {
            let ok = got == want; if !ok { failures += 1 }
            print("\(ok ? "OK " : "FAIL") \(label): \(got)\(ok ? "" : " ≠ \(want)")")
        }

        // Codex raw shell command → unwrapped + correct identity
        check("codex sed text", ToolViz.detail(item(name: "exec command", text: "/bin/zsh -lc \"sed -n '1,220p' docs/a.md\"")),
              "sed -n '1,220p' docs/a.md")
        check("codex bash npm", ToolViz.unwrapShell("bash -lc 'npm test'"), "npm test")
        check("plain cmd untouched", ToolViz.unwrapShell("ls -la"), "ls -la")
        checkB("exec→Run", ToolViz.display("exec command").short == "Run", true)
        checkB("exec mono", ToolViz.display("exec command").mono, true)

        // Codex file-change identity
        checkB("edit→Edit", ToolViz.display("edit").short == "Edit", true)
        checkB("edit isFile", ToolViz.display("edit").isFile, true)

        // Claude identities
        checkB("Read isFile", ToolViz.display("Read").isFile, true)
        check("Read verb", ToolViz.display("Read").short, "Read")
        check("Write verb", ToolViz.display("Write").short, "Write")
        check("Bash verb", ToolViz.display("Bash").short, "Run")
        check("Grep verb", ToolViz.display("Grep").short, "Search")
        check("WebSearch verb", ToolViz.display("WebSearch").short, "Web search")

        // Missing / unknown name never renders nameless
        check("nil→Tool", ToolViz.display(nil).short, "Tool")
        check("empty→Tool", ToolViz.display("").short, "Tool")

        // MCP scrub
        check("scrub git", ToolViz.scrubInternalMcp("mcp__maestro__git_status"), "Git status")
        check("scrub inline", ToolViz.scrubInternalMcp("ran mcp__maestro__wa_send_text now"), "ran Wa send text now")

        // File helpers
        check("basename", ToolViz.baseName("apps/desktop/electron/engine.ts"), "engine.ts")
        check("ext tsx", ToolViz.fileExt("Foo.tsx"), "tsx")
        check("ext d.ts", ToolViz.fileExt("types.d.ts"), "ts")
        check("ext gitignore", ToolViz.fileExt(".gitignore"), "gitignore")
        check("ext dockerfile", ToolViz.fileExt("Dockerfile"), "dockerfile")
        check("ext dotfile w/ ext", ToolViz.fileExt(".env.local"), "env")
        check("symbol swift", ToolViz.fileSymbol("Main.swift"), "swift")
        check("symbol pdf", ToolViz.fileSymbol("report.pdf"), "doc.richtext.fill")
        check("badge text ts", ToolViz.badgeText("a/b.tsx"), "tsx")
        checkB("png uses glyph", ToolViz.badgeUsesSymbol("hero.png"), true)
        checkB("ts uses text", ToolViz.badgeUsesSymbol("a.ts"), false)

        // Absolute path rejoin
        check("rel join", ToolViz.absolutePath("a/b.ts", root: "/root") ?? "nil", "/root/a/b.ts")
        check("abs passthrough", ToolViz.absolutePath("/x/y.ts", root: "/root") ?? "nil", "/x/y.ts")

        // File-write classification routes through display() — substring lookalikes are NOT writes
        checkB("Write is write", ToolViz.isWriteFileTool("Write"), true)
        checkB("Edit is write", ToolViz.isWriteFileTool("Edit"), true)
        checkB("str_replace is write", ToolViz.isWriteFileTool("str_replace"), true)
        checkB("Read not write", ToolViz.isWriteFileTool("Read"), false)
        checkB("credit_card not write", ToolViz.isWriteFileTool("credit_card_lookup"), false)
        checkB("wa_edit not write", ToolViz.isWriteFileTool("mcp__whatsapp__wa_edit_message"), false)
        checkB("path-shaped", ToolViz.looksLikePath("apps/x.ts"), true)
        checkB("not path", ToolViz.looksLikePath("hello world"), false)

        print(failures == 0 ? "\nTOOLVIZ SELFTEST OK (all passed)" : "\nTOOLVIZ SELFTEST FAIL (\(failures))")
        exit(failures == 0 ? 0 : 1)
    }

    private static func item(name: String?, text: String, preview: String? = nil) -> TranscriptItem {
        TranscriptItem(kind: "tool", text: text, name: name, preview: preview, ts: 0)
    }
}
