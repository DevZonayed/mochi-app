we should able to initiate the claude authentication as like claude code, also codex authentication from settings page. make that perfect.
→ ## Done — feature on `feat/cli-login-from-settings`

You can now kick off **`claude login`** and **`codex login`** straight from Settings → Accounts — no terminal-dropping required.

**Design choice — real OS Terminal, not embedded TTY.** Both CLIs are interactive (Codex prints a device code; Claude