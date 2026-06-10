# Desktop · Page 18 — Settings, Secrets & Security

> Use together with `00-DESIGN-SYSTEM.md`. Model this directly on macOS System Settings: left settings-nav inside the page, right grouped-inset panes.

## Sections (left nav within Settings)
**General** — workspace name, appearance segmented `Light · Dark · Auto`, default effort dial (workspace-wide), startup behavior switches.

**Accounts & keys** — provider rows (Anthropic, OpenAI, fal, Replicate, ElevenLabs, Google…): logo, status, key stored chip (`In Keychain 🔒` — value never displayed, only "Replace key"), OAuth refresh status ("Auto-refreshing ✓"), last used. Footer copy: "Agents use keys; they never see them."

**Security** — grouped:
- Autonomy floor: segmented `Plan first` default note, "bypass mode" deliberately absent — show a static row "Unattended is the maximum autonomy · always inside allowlists and caps" with a lock glyph.
- Untrusted input review switch (on, with explanation line).
- Skill trust: re-scan cadence picker, quarantine behavior.
- Audit log retention picker + "Export audit (JSONL)".

**Devices** — paired phones list (device name, last seen, E2EE chip) with red "Revoke" per row + "Pair new device" (→ Page 19).

**Power & reliability** — wake-lock policy rows ("Keep Mac awake while jobs run" switch with footnote "Jobs survive sleep anyway — they resume from checkpoint"), checkpoint interval, relay address field (mono) with connection health dot.

**Updates** — current version, signed-update channel, "Check now".

**Danger zone** — calm but separated: Reset workspace (typed-confirm sheet), delete-with-cascade explanation in plain words ("Removes projects, transcripts, synced copies, and media. The audit log keeps a tombstone.").

## States & micro-interactions
Every destructive action uses the iOS confirm sheet pattern with the destructive option in red. Key replacement flow masks input with the Keychain glyph animating to a lock-click on save.
