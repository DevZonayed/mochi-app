# Mobile · Page 11 — Settings (Tab 5)

> Use together with `00-DESIGN-SYSTEM.md`. Model on iOS Settings exactly: grouped-inset lists on grey.

## Sections
1. **Connection card (top hero):** Mac name + workspace, live link status (green dot "Connected via relay · E2EE", amber "Reconnecting…", red "Unreachable"), latency caption ("84 ms"), and a "Test connection" quiet button. The E2EE shield chip opens an info sheet (plain explanation, key fingerprint in spaced mono to verify against the Mac).
2. **Notifications:** master switch + per-type switches (Gates, Completions, Failures, Budget, Publishing) with the gate-types note "Destructive approvals always confirm in app".
3. **Approvals security:** Face ID for approvals switch (on by default for publish/merge/over-budget), "Allow lock-screen approve for safe gates" switch.
4. **Appearance:** Light · Dark · Auto segmented; app icon picker (3 variants in a row).
5. **Offline & sync:** outbox row showing queued intents count ("2 actions waiting to apply"), storage used by cached media with a Clear button.
6. **This device:** device name field, "Unpair from Mac" (red, typed/Face-ID confirm with consequence copy: "You'll stop receiving gates and live runs. The Mac keeps working.").
7. **About:** version (mono), relay address (mono, read-only), licenses.

## States
Unreachable Mac turns the hero card amber with last-seen time and a "What can I still do?" link (sheet: view cached state ✓, queue approvals ✓, start jobs queued ✓, live streams ✗).

## Micro-interactions
Status dot transitions colors with a soft cross-fade, never blinks. Unpair uses hold-to-confirm fill on the destructive button.
