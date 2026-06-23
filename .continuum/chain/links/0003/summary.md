First of all in settings page i can see that The codex is saying signin but in codespace model switcher it is saying codex is not sign in we need to solve it.
→ ## Done — fix on `fix/codex-auth-state-mismatch`

**Root cause** — a Claude/Codex asymmetry inside `engine.ts`:

| | Login check (`auth.json` / `.claude`) | API-key fallback (keychain) | CLI binary required |
|---|---|---|---|
| **Claude** (931–935) | ✓ | ✓ `getLocalKey('anthropic')` | ✗ |
| **Codex