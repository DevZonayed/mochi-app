# Skills Registry Runtime

This is the operational path for the Maestro skills registry.

## Dokploy

Use `apps/server/docker-compose.dokploy.yml` for the server app. It mounts the
SQLite registry at `/data/maestro-registry.sqlite` through the named Docker
volume `maestro_registry_data`, so Dokploy volume backups include metadata,
admin state, embeddings, cached `SKILL.md` versions, sha256 hashes, audits, and
upstream source status.

Required `.env` values:

```env
MAESTRO_REGISTRY_DB=/data/maestro-registry.sqlite
MAESTRO_REGISTRY_ADMIN_TOKEN=<long random token>
# Optional. Used only for higher GitHub commit-lookup rate limits.
GITHUB_TOKEN=<read-only token>
```

First boot seeds SQLite from `apps/server/registry/skills-index.json` and
`apps/server/registry/skills-vectors.json` only when the DB is empty. After that,
SQLite is the runtime source of truth.

## Verify DB

```bash
cd apps/server
MAESTRO_REGISTRY_DB=/data/maestro-registry.sqlite pnpm registry:verify
```

Expected import baseline:

- `skills`: `3000`
- `embeddings`: `3000`
- `uniqueRepos`: `444`
- `commitPinnedAfter`: increases as content hydration pins upstream commits

Optional content/hash hydration:

```bash
cd apps/server
MAESTRO_REGISTRY_DB=/data/maestro-registry.sqlite pnpm registry:hydrate -- --limit 3000
```

Hydration reads from each skill's original upstream repository, caches live
`SKILL.md` content in `skill_versions`, writes sha256 back to `skills.sha256`,
records the latest upstream commit SHA for the skill path, and stores source
health as `source-ok` or `source-missing`.

## Original Sources

There is no fork or mirror requirement. The registry uses the original
`owner/repo` and `rawBase` from the curated index for search, install, MCP
download, and source verification.

Dry-run the source list:

```bash
cd apps/server
MAESTRO_REGISTRY_DB=/data/maestro-registry.sqlite pnpm registry:sources:dry-run -- --limit 20
```

Sync source health and hydrate cached content from original repos:

```bash
cd apps/server
MAESTRO_REGISTRY_DB=/data/maestro-registry.sqlite pnpm registry:sources:sync -- --limit 3000
```

By default this skips skills that are already `source-ok` and have cached
`SKILL.md` content. Add `--all` for a full refresh from upstream.

The hosted admin portal's source-sync button calls the same upstream-source
logic through `/registry/admin/sync/sources`. The legacy
`/registry/admin/sync/github` route is kept as an alias for older clients, but
it no longer creates forks.

The job is resumable because it updates each skill independently. Failed source
fetches remain visible in admin status as `source-missing`; successful fetches
are marked `source-ok`.

## Admin Portal

Set the same `MAESTRO_REGISTRY_ADMIN_TOKEN` in the Skills page admin-token field.
Then the portal can:

- list enabled and disabled skills
- add a skill from skills.sh/GitHub/SKILL.md URL
- enable or disable registry skills
- dry-run or trigger original-source sync
- inspect metadata, hashes, and `SKILL.md` previews

Public and agent search excludes disabled skills. Existing project-local skill
files are not removed when a registry skill is disabled.
