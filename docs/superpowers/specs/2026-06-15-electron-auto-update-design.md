# Desktop auto-update — design

**Date:** 2026-06-15 · **App:** `apps/desktop` (Electron) · **Status:** implemented

## Goal

Ship updates the way Conductor does: a user installs the app, we push a new
version, and the app quietly notices, downloads it, and offers **Restart to
update**, plus a **What's New** changelog. Hosted entirely on GitHub — no paid
services, no certificates required to start.

## Decisions

- **Updater:** `electron-updater` (Squirrel.Mac / NSIS / AppImage).
- **Host:** GitHub Releases on `DevZonayed/mochi-app`. Release notes = "What's New".
- **Packaging:** `electron-builder` (config: `apps/desktop/electron-builder.yml`).
- **Publish flow:** push a `v*` git tag → GitHub Actions builds mac+win+linux →
  publishes installers + update feeds to a GitHub Release (`.github/workflows/release.yml`).
- **Signing:** none for now. This is the only real limitation, by platform:

  | Platform | Behavior now (unsigned) | With an Apple cert later |
  |---|---|---|
  | Linux (AppImage) | silent download + Restart to update | n/a |
  | Windows (NSIS) | silent download + Restart (one-time SmartScreen notice) | silent, no notice |
  | macOS (Squirrel.Mac) | detect + What's New, button **opens the download page** | silent download + Restart |

  macOS silent self-replace requires a signed + notarized build (Gatekeeper).
  The code is signing-ready: set `mac.identity` + notarization in
  `electron-builder.yml` and flip `MAC_SILENT_UPDATE = true` in
  `electron/updater.ts` — no redesign.

## Architecture

```
GitHub Releases ──latest*.yml + installers──► electron-updater
                                                   │ (one Updater, electron/updater.ts)
                                                   ▼  emit('update', status, { desktopOnly: true })
                                  main.ts fan-out → desktop windows ONLY (never relayed to phone)
                                                   ▼
              renderer: api.update.onUpdate → <UpdateBanner/> + Settings "Updates" + <WhatsNew/>
                                                   ▲
                          renderer → main: maestro.call('update.{status,check,install,setChannel,notes,openReleases}')
```

- **`electron/updater.ts`** — the only unit touching electron-updater. Maps its
  lifecycle (`checking → available → downloading → ready → error`) to one
  `UpdateStatus` and emits it. Methods: `check`, `install` (quitAndInstall, or
  open the download page on mac-unsigned), `setChannel` (Stable/Beta, persisted
  in userData), `notes` (GitHub release body), `openReleases`, `start`
  (check 8 s after launch, then every 4 h).
- **`main.ts`** — constructs one `Updater(emit)`, routes `update.*` IPC straight
  to it (NOT through the shared dispatch, so it never answers over the relay),
  starts it after the window opens, stops it on quit. `emit` gains a
  `desktopOnly` flag so update events stay local.
- **`localApi.ts`** — `health` now returns the real `app.getVersion()`.
- **Renderer** — `api.update` namespace + `onUpdate` subscription;
  `UpdateBanner` (global bottom-right prompt + post-update What's New);
  `WhatsNew` (notes sheet); Settings → Updates pane wired to real data
  (version, channel, status, Check now, What's New).

## How to cut a release

Releases are **manual** — nothing publishes automatically on push. When ready:

- **GitHub:** Actions tab → "Release desktop app" → **Run workflow** → pick `master`.
- **CLI:** `gh workflow run release.yml --ref master`

The version **auto-increments** (patch bumps from the latest published release;
bump major/minor in `apps/desktop/package.json` to start a new series), so no
manual version edit is needed. The run builds + publishes installers for macOS,
Windows and Linux, then syncs the new version back into package.json. Installed
apps pick the update up within 4 h, on next launch, or via Settings → Check now.

The first release establishes the baseline everyone updates *from*.

## Out of scope (YAGNI)

Staged/percentage rollouts, automatic rollback, in-app history beyond the
current version's notes.

## Verification boundary

Code, build config, and CI are written and typecheck/build locally. The true
end-to-end (publish → download → restart) is exercised by the first tagged CI
run and a real install, since multi-platform installers can only be built on
their own CI runners.
