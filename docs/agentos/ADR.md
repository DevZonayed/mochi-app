# Maestro — Architecture & Key Decisions (ADR)

> **Status:** BINDING. Every PRD section writer MUST obey this record. Where a PRD draft conflicts with an ADR decision, the ADR wins until formally amended here.
>
> **Scope (authoritative):** Maestro is a **single-user, single-operator** maximum-capability AI-agent desktop + mobile platform. The operator is the sole user and owner, and wears many hats (developer **and** creator). There is **NO multi-tenancy, NO teams, NO SSO/SCIM/RBAC, NO org/tenant hierarchy, NO seat licensing, NO monetization, NO marketplace payment economy.** The top data entity is **Workspace**, not Org. "Enterprise-grade" here means **engineering quality** (security, reliability, observability, cost-awareness, modularity, clean data model, testability) — **not** enterprise sales features. "Phasing" means **build order**, never product tiers.
>
> **Volatility caveat:** Every model ID, price, ToS term, and library version below is **point-in-time (mid-2026) config**, not a constant. The architecture's entire job is to make these swappable. Re-verify at build time against the live Vendor Register (§16.4).

---

## 0. Non-Goals (explicit — drop these; do not let the research drag them back in)

The research was written assuming a multi-tenant commercial SaaS. That framing is **wrong for Maestro** and is overridden here. The following are **OUT OF SCOPE** and must be stated as Non-Goals in every PRD section that touches them:

- **Multi-tenancy / teams / orgs / tenant hierarchy.** Single operator only. No `Org` entity.
- **Identity-as-product:** NO SSO (SAML/OIDC), NO SCIM, NO RBAC, NO seat/role management. (We still do native OAuth *to providers* — that is a connectivity feature, not an identity product. See §6.)
- **Monetization of Maestro itself:** NO subscription tiers, NO pricing, NO free-tier gating, NO usage margin capture. BYO-key means the operator pays providers directly; Maestro captures nothing.
- **Marketplace payment economy:** NO creator payouts, NO take-rate, NO Stripe Connect, NO Telegram Stars billing, NO refunds/chargebacks/VAT/tax engine. The "skills marketplace" is the **operator's own package registry** (npm-for-skills) they publish to and pull from. It may be public/shareable, but there is **no payment layer ever**.
- **Persona fork:** creator-vs-engineer is **not** a product split. It is one power user switching hats via **Project Templates** (§7). Do not design two onboardings, two apps, or two personas.
- **Commercial-rights / ARR-threshold gymnastics** (e.g. LTX-2 "<$10M ARR"): irrelevant — single operator, personal use. We still respect per-vendor ToS and **consent/provenance law** (biometric consent, C2PA labeling — those are legal, not commercial, obligations; see §14).

Cost governance (§16) exists **only** to protect the operator from bill-shock — never to bill anyone.

---

## 1. Desktop framework + UI-agnostic Node service core + typed IPC/RPC boundary

**DECISION:** **Electron** desktop shell (latest stable, "v3x" 2026 line) hosting a **UI-agnostic Node service core ("Maestro Core")** as a separate process. All UI ↔ Core traffic flows over a **single typed RPC boundary** — a versioned tRPC-style contract (TypeScript end-to-end) carried over Electron `MessagePort`/IPC for the desktop renderer and over the relay WebSocket (§12) for mobile. No business logic in the renderer; the renderer is a pure view over the Core.

**RATIONALE:** The primary engine (`@anthropic-ai/claude-agent-sdk`) and Node MCP servers run **in-process with zero sidecar/SEA packaging pain** under Electron's Node main process; Electron also ships built-in `powerSaveBlocker` (§15) and the mature signed `electron-updater` path, and gives identical Chromium rendering for the IDE + media studio. Tauri's wins (RAM, mobile) are real but cost a Node sidecar, an unofficial sleep plugin, and cross-WebView QA — velocity favors Electron now.

**REJECTED:**
- *Tauri v2* — first-class mobile + tiny footprint, but Node-SDK-as-sidecar pain, no official sleep plugin (issue #3697 open since 2022; Win11 drops the assertion immediately), and per-OS WebView divergence. **Kept as a deferred re-shell target, not v1.**
- *Pure web app / PWA* — cannot host the Node engine in-process, no real prevent-sleep, no native keychain.

**ABSTRACTION / SEAM:** The **typed RPC contract is the seam.** Because all OS-native concerns sit behind a thin **`PlatformAdapter` interface** (sleep-blocker, deep-link, OAuth loopback, auto-update, keychain, notifications) with one Electron impl today, and all business logic lives in the framework-agnostic Maestro Core, a future Tauri-desktop or Tauri-mobile port is a **re-shell (new PlatformAdapter + new view layer), not a rewrite.** The mobile client (§12) already consumes the *same* RPC contract over the relay — proving the boundary holds.

---

## 2. Process / sandbox topology

**DECISION:** A **multi-process topology modeled on the VS Code architecture**, with the Maestro Core as supervisor:

| Process | Role | Trust |
|---|---|---|
| **Electron Main** | Window/lifecycle, `PlatformAdapter` (sleep/keychain/deep-link/update/notifications), spawns + supervises children | Trusted |
| **Renderer(s)** | UI only (command center, studio, job monitor); no Node integration, `contextIsolation` on, sandboxed | Untrusted-by-default |
| **Maestro Core (agent-engine service)** | UI-agnostic Node service: agent engine, router, data model, RPC server. Hosts `@anthropic-ai/claude-agent-sdk` `query()` loops | Trusted core |
| **Scheduler Worker(s)** | Durable job execution (§8); separate process so a runaway/blocked job can't stall the UI or engine | Trusted, resource-capped |
| **Extension / Skill Host** | Loads third-party skills + first-party plugins (§9, §18) in an **isolated Node `utilityProcess`** (VS Code extension-host model); **never** touches Main; talks to Core over the same RPC contract with a capability-scoped token | **Untrusted** — sandboxed, deny-by-default network/FS |
| **MCP Gateway** | Mandatory single chokepoint for ALL third-party MCP/tool traffic (engine *and* reviewer route through it); scoping, allow/deny, audit, signature verification | Policy boundary |
| **Comms Sidecars** | Telegram (grammY, Node, in-Core or thin child) + **WhatsApp as an isolated Go `whatsmeow` sidecar** (separate process, separate OS user where possible) so a WA ban/crash/compromise is contained | **Isolated**, opt-in ban risk |
| **Media Workers** | Render/compositor jobs (Remotion, ffmpeg, polling of fal/Replicate webhooks); CPU/GPU-heavy, killable, out-of-band of the chat loop | Trusted, resource-capped |

**RATIONALE:** Agents have shell/FS access (RCE surface); third-party skills/MCP are arbitrary code with user privileges (41% of public MCP servers have zero auth; rug-pull + `lotusbail`-class supply-chain precedent). Process isolation + a mandatory gateway is the only credible containment, and matches the dominant **orchestrator-worker** production pattern. Separate scheduler/media processes keep long jobs from blocking the UI.

**REJECTED:** *Single-process monolith* (one compromised skill = full RCE on the operator's machine, one render stalls everything). *Engine-in-renderer* (couples engine to Electron, breaks the re-shell seam, exposes the engine to web content).

**ABSTRACTION / SEAM:** Every child process speaks the **same typed RPC contract** behind a `process bus`; the Extension Host and MCP Gateway are **capability-token-scoped** (a child can only call what its grant allows). Swapping a sidecar (whatsmeow → Baileys, §11) or a worker pool is a process-registry change, not an engine change.

---

## 3. Agent engine: Claude Agent SDK harness, model tiers, GPT reviewer + eval gate

**DECISION:** Build the engine on the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, TS, Node) running inside Maestro Core, behind a thin adapter over the **stable V1 `query()` API** (do NOT depend on the unstable V2 session preview). Inherit subagents (`AgentDefinition`), lifecycle hooks, MCP client, six permission modes incl. **plan mode**, and resumable/forkable **JSONL sessions**.

**Model tiers (exact IDs + mid-2026 prices, $/MTok in/out — config, re-verify):**

| Role | Model | ID | Price | Notes |
|---|---|---|---|---|
| **Builder** | Claude **Opus 4.8** | `claude-opus-4-8` | **$5 / $25** | 1M ctx, 128k output, adaptive thinking, effort default `high`; use `xhigh` for hard coding/agentic work |
| **Driver** | Claude **Sonnet 4.6** | `claude-sonnet-4-6` | **$3 / $15** | Most production turns / sub-project orchestration |
| **Subagents** | Claude **Haiku 4.5** | `claude-haiku-4-5` | **$1 / $5** | Classification, routing, comms, cheap fan-out |
| **Reserve (meter carefully)** | Claude **Fable 5** | `claude-fable-5` | **$10 / $50** | Always-on adaptive thinking, new tokenizer (~30% more tokens), 30-day-retention only. Behind explicit opt-in + budget. |
| **Reviewer (primary)** | **GPT-5.1** | `gpt-5.1` | **$1.25 / $10** (cached in $0.125) | OpenAI Responses API, `reasoning_effort` + low `verbosity`; ~1.05M ctx fits whole PRs |
| **Reviewer (code diffs)** | **GPT-5.1-Codex-Max** | (config) | — | Reach for it only when the reviewer must read repo / run read-only commands |

> The reviewer model line moves ~monthly (the research even disagrees with itself: GPT-5.1 vs GPT-5.5). **The reviewer ID is config with a fallback chain**, never hard-coded.

Caching/discount levers are **mandatory on Claude**: prompt caching (~90% off cached input reads) + Batch API (−50%) on all scheduled/background/eval runs.

**Eval-gating plan (the reviewer must PROVE it earns its cost):** Independent benchmarks show Claude already leads SWE-bench with lower hallucination, so the cross-vendor GPT reviewer's lift is **unproven** and is treated as a **hypothesis, not a given**. Before the reviewer pass is enabled by default:
1. Build a **golden-task eval harness** (§ ties to reliability/testing) of representative Maestro jobs (code + creative) with known-good outcomes.
2. Run each task **builder-only** vs **builder + GPT reviewer loop**, measuring: defect-catch rate, false-positive rate, added latency, added $ cost.
3. **Gate:** the reviewer ships **on-by-default only if it catches real, otherwise-missed defects at acceptable cost.** If lift is marginal, it becomes an **opt-in DEEP-mode-only** pass, not a default — and the ADR is amended to say so. The reviewer is allowed to be dropped; it is not a sacred pillar.

**RATIONALE:** Don't reimplement the harness — the SDK is the same engine as Claude Code with the deepest native MCP. The builder/driver/subagent split mirrors validated cost-tiering (Aider architect/editor). The eval gate exists because "Claude builds, GPT reviews" is a headline feature that the research itself flags as possibly decorative.

**REJECTED:** *Reimplementing the agent loop* (wasteful, loses MCP/hooks/sessions). *Reselling consumer Claude/Codex subscriptions* (Anthropic banned OpenClaw/OpenCode/Roo/Goose Jan 2026; out of scope anyway — operator uses their own key). *Treating the reviewer as proven* (research contradicts it).

**ABSTRACTION / SEAM:** The engine sits behind an **`AgentEngine` interface** (`plan/build/review/stream/resume`) so OpenHands (§17) can be a drop-in fallback. All model selection goes through the **router (§4)** — the engine never names a model ID. The reviewer is a swappable `Reviewer` strategy behind the same router.

---

## 4. Provider-abstraction router / LLM gateway

**DECISION:** **LiteLLM (self-hosted)** as the single LLM gateway/router in front of Claude, GPT, and any image/video text endpoints. The engine and all subsystems request a **logical role** (`builder`, `driver`, `subagent`, `reviewer`) or a **capability tag**, never a raw model ID. The router maps role → concrete provider+ID from config, enforces virtual budgets, and provides failover.

**RATIONALE:** Opus revved 4.5→4.7→4.8 in ~2 months; reviewer IDs move monthly; Sora 2 vanished. Hard-coded IDs guarantee dead code. LiteLLM gives per-logical-key `max_budget`/`budget_duration`, `max_iterations` + `max_budget_per_session` loop kills, and provider failover in one component — directly implementing the bill-shock NFRs (§16) for the single operator.

**Enforced policy at the gateway:** prompt caching + Batch API on Claude for every eligible (scheduled/background/eval) call; **never** ship `bypassPermissions`; hard per-project caps return a 429 to the caller (§16).

**REJECTED:** *Hard-coding model IDs in the engine* (the cardinal sin the research repeatedly warns against). *A hosted/closed router* (lock-in, can't enforce our own budget rules). *No gateway / direct SDK calls* (no central budget/failover/cache enforcement).

**ABSTRACTION / SEAM:** LiteLLM **is** the seam. Its config maps logical roles → IDs; swapping a provider/model is a config edit. If LiteLLM itself must be replaced, the Core only depends on the **`Router` interface** (`complete(role, messages, effort) → stream`), so the gateway implementation is itself swappable.

---

## 5. Switchable-effort abstraction (FAST / BALANCED / DEEP / MAX)

**DECISION:** A normalized **`Effort` enum {FAST, BALANCED, DEEP, MAX}** that the router translates to concrete per-vendor params. Effort is a **first-class dial on every Job/Session**, independently settable for the **build pass** and the **review pass**.

| Maestro effort | Claude (`output_config.effort` + adaptive thinking) | OpenAI (`reasoning_effort`) | Reviewer interaction |
|---|---|---|---|
| **FAST** | `low`, adaptive thinking | `low`/`minimal` | Review **off** by default |
| **BALANCED** | `medium`/`high` | `medium` | Light review (pre-screen) |
| **DEEP** | `high`/`xhigh` | `high` | Full reviewer loop (if eval-gated on) |
| **MAX** | `xhigh`/`max` | `high` + larger budget | Full reviewer loop + (optional) judge panel (§10) |

Claude `budget_tokens` is **removed** on Opus 4.7/4.8/Fable — use adaptive thinking + `effort`; the abstraction must never emit `budget_tokens` for those models.

**The "effort paradox" guardrail:** Research shows high/xhigh effort is **flat-or-worse on many tasks at 4–17× cost and 5–60× latency.** Therefore:
- **Default is BALANCED, not DEEP/MAX.** Escalation to DEEP/MAX is **opt-in** (per-job override) or **auto-escalated only on eval-verified-hard task types** driven by reasoning-token telemetry (§16).
- The UI **always surfaces the cost/latency multiplier** before a DEEP/MAX run.
- Plan mode = DEEP + human checkpoint by default; execution = BALANCED/FAST.

**RATIONALE:** Effort is the headline "dial, not a rebuild" tenet, but the paradox makes naive "more effort = better" actively harmful to the operator's bill and patience. The abstraction makes effort portable across vendors; the guardrail keeps it economical.

**REJECTED:** *Exposing raw vendor params to the UI* (breaks portability, leaks vendor churn into UX). *Defaulting to MAX* ("maximum capability" ≠ maximum effort-tokens on every task — that's the paradox).

**ABSTRACTION / SEAM:** `Effort` is a router input; per-vendor translation lives in **one mapping table** beside the router config. New vendors add a column; new effort semantics never touch callers.

---

## 6. Native OAuth (Anthropic, OpenAI, social/publishing, comms)

**DECISION:** **Authorization Code + PKCE with a loopback redirect (`http://127.0.0.1:<random-port>`) as the DEFAULT** for every provider that supports it; custom-scheme deep link (`maestro://oauth/...`) as the secondary path for providers that reject loopback. All access/refresh tokens (and BYO API keys) live in the **OS keychain** via the `PlatformAdapter`: **macOS Keychain / Windows DPAPI (Credential Manager) / Linux libsecret (Secret Service)**.

**RATIONALE:** PKCE + loopback is the OAuth 2.1 native-app best practice (no client secret on device, no inbound port). Single operator means there is **no "whose key" problem** — BYO-key is trivially satisfied: the operator's own provider keys/tokens are theirs. The only hard requirement is the **agent-invisible-secrets posture** (the agent uses a credential without ever seeing it, surviving prompt injection — §16).

**REJECTED:** *Implicit flow* (deprecated, insecure). *Storing secrets in app config/SQLite/plaintext* (defeats agent-invisibility). *Reselling/sharing consumer subscription OAuth* (banned + out of scope). *A dedicated secrets vault server (Infisical/Vault)* — overkill for one operator; the OS keychain + an in-process agent-invisible accessor is sufficient. (Keep the *interface* so a vault could slot in if ever needed.)

**ABSTRACTION / SEAM:** A **`SecretStore` interface** (`get/put/rotate`, agent-invisible accessor) with a keychain impl; an **`OAuthProvider` registry** so adding a publishing/comms provider (§14) is a config + scope declaration, not new auth plumbing. A **token-refresh service** owns lifecycle (e.g. TikTok 24h expiry).

---

## 7. Canonical data model + stores

**DECISION — canonical hierarchy (Workspace is the top entity; NO Org):**

```
Workspace                      (the operator's single root; global defaults, master budget ceiling)
└── Project          (typed via Project Template: Code / Design / Content / Research / …)
    └── Sub-project  (a focused stream within a Project)
        └── Job      (a unit of work: one-off or scheduled; has a Trigger)
            └── Session   (a live agent run: engine + effort + permissions + skills + tools)
```

**Attachment + inheritance rules** (attach at the right level; **child overrides, else inherits**):

| Concern | Attached at | Inheritance |
|---|---|---|
| **Budget / caps** | Workspace (ceiling) → Project (hard cap) → Job (per-run cap) | Child cap must be ≤ parent remaining; Job spend rolls up to Project ledger then Workspace |
| **Keys / OAuth tokens** | Workspace (operator's keys) | Inherited everywhere; never per-tenant (single user). Agent-invisible. |
| **Skills** | Project (template default set) → Session (ephemeral per-job load, §9) | Session adds/removes on top of Project set |
| **Tools / MCP** | Project (allowed servers) → Job/Session (scoped subset) | Deny-by-default; Session can only narrow, not widen, beyond Project allowlist |
| **Permissions / autonomy** | Project (default mode) → Job (override) | Plan-mode default; never `bypassPermissions` |
| **Instructions / config** | Project (per-project instructions scope every Job) → Sub-project → Session | Concatenated/overridden down the tree |
| **Audit** | Every level, append-only | Immutable; never inherited (recorded where it happens) |
| **Sync-state** | Workspace/Project/Job docs | CRDT per syncable doc |

**Stores (who owns what):**

| Store | Owns | Why |
|---|---|---|
| **SQLite** (embedded, single-operator) | Canonical relational data model: Workspace/Project/Sub-project/Job rows, schedule defs, skill registry index, OAuth-token *metadata* (not the secret), publishing quotas/audits | Embedded, zero-ops, perfect for one operator; **Postgres is NOT needed** (no multi-tenant scale) |
| **Redis** | BullMQ queues + scheduler state + rate-limiter + live-meter counters | Fast ephemeral coordination (§8) |
| **JSONL transcripts** | Claude Agent SDK session transcripts (resumable/forkable) | Native SDK format; the replayable run history |
| **CRDT docs (Yjs)** | Sync-state for desktop↔mobile (live job state, scheduler view, marketplace view) | Offline-first conflict-free (§12) |
| **OS Keychain** (`SecretStore`) | The actual API keys + OAuth refresh tokens | Agent-invisible, OS-protected (§6) |
| **Append-only audit log** (SQLite table + exportable JSONL) | Immutable record of every tool call, send, publish, spend, gate decision | Tamper-evident; doubles as the self-accountability/compliance record |
| **Object store (local FS + optional Cloudflare)** | Media artifacts, render outputs, skill bundles | Large binaries out of the relational store |

> **Postgres + pg-boss is the documented fallback** if the operator ever runs Maestro Core as a long-lived headless server and prefers one datastore (§8) — but **SQLite + Redis is the v1 default** for a single-operator desktop-first deployment.

**RATIONALE:** The critique correctly identified the data model as "the missing spine." One canonical schema with explicit inheritance prevents the fragmentation where every subsystem invents its own store. Single-operator scale means SQLite (not Postgres) is the right default — clean, embedded, testable.

**REJECTED:** *Org as top entity* (no multi-tenancy — overridden). *Postgres as the default* (multi-tenant-scale assumption that doesn't apply). *Per-subsystem ad-hoc stores with no canonical model* (the fragmentation the critique flagged).

**ABSTRACTION / SEAM:** A **`Repository` layer** over SQLite (swappable to Postgres without touching callers); a **`SyncDoc` abstraction** (Yjs today, Automerge reserved §12) over CRDT state; the `SecretStore` (§6) over the keychain. The relational model is the source of truth; CRDT docs are projections for sync.

---

## 8. Scheduler + durable execution

**DECISION:** **BullMQ on Redis** as the primary durable scheduler/queue (desktop-first default), with **pg-boss on Postgres documented as the swap-in** for an all-Postgres headless deployment. The Scheduler Worker process (§2) owns execution. Triggers: **manual, cron, comms-message (§11), webhook/event.** Background-job completion fans out to **mobile push (§12/§15)**.

**Mechanics (mandatory):**
- **Cron** via BullMQ Job Schedulers; per-project concurrency + global rate-limiter.
- **Quartz-style misfire policy** on every schedule (fire-now / skip / coalesce on missed runs after sleep/restart).
- **Idempotency keys on every job** (at-least-once delivery double-sends without them).
- **Checkpoint/resume**: the agent's JSONL session (§3/§7) is the resume point; a job interrupted by OS sleep/lid-close/restart resumes from its last checkpoint, not from zero. A wake-lock (§15) is **not** a completion guarantee — durable resume is.

**RATIONALE:** Self-host the scheduler — do **not** rely on Anthropic's Claude Code Routines (research preview, 1-hour minimum interval + daily cap, "green ≠ success"). BullMQ gives cron + rate-limit + native OTel; idempotency + misfire policy are non-negotiable for at-least-once durability across the OS power events the platform is built to survive. The **per-project durable cron scheduler is a lead differentiator** — nobody ships it natively per-project.

**REJECTED:** *Anthropic Routines as the scheduler* (too coarse, capped). *Hand-rolled setTimeout/cron* (no durability, no resume, dies on restart). *Temporal* (multi-week mission-critical heavy machinery; overkill for one operator's desktop). *Trigger.dev/Inngest hosted* (managed-service dependency for a self-hosted personal platform).

**ABSTRACTION / SEAM:** A **`JobQueue` interface** (`enqueue/schedule/checkpoint/resume/onComplete`) with a BullMQ impl and a pg-boss impl behind it — the scheduler engine is swappable without touching trigger sources or job bodies. Triggers are a **`TriggerSource` registry** (cron/comms/webhook/manual all implement one contract).

---

## 9. Skills + personal marketplace + MCP

**DECISION:** Adopt the **Claude Agent Skills convention verbatim** — `SKILL.md` (frontmatter `name` ≤64 / `description` ≤1024 stating *what + when*; body ≤500 lines; 3-tier progressive disclosure) bundled as Claude plugins (`.claude-plugin/`) carrying skills + MCP servers + hooks. The operator's **own online skill registry** is a **personal package registry (npm-for-skills)** — NO payment layer, ever (§0).

**The dynamic skill loop (per-job ephemeral loading):**
```
Job needs capability X
 → MCP Skill-Broker: search_skills (vector search over name+description) against the operator's registry
 → rank by relevance + version + signature → pick best
 → download_skill → materialize SKILL.md bundle into the Job's .claude/skills/  (per-job, ephemeral)
 → verify SHA256 manifest + signature/provenance
 → Agent SDK loads at session start/reload (write-to-disk + reload closes the no-mid-session-register-API gap)
 → agent uses it; on Job end → unload / cache per policy
```

**Mandatory MCP gateway (§2):** **ALL** third-party MCP/tool traffic — for the engine *and* the reviewer — routes through the gateway. It is the single enforcement point for per-project/per-job scoping, allow/deny, audit, and **signature verification**. Use **`defer_loading` / Tool Search on by default** (context bloat: 4 MCP servers ≈ 51K tokens; Tool Search cuts ~85% of startup tokens).

**Security (continuous, not one-time):**
- **Sandboxing:** skills/MCP run in the Extension/Skill Host (§2), deny-by-default network/FS, capability-scoped tokens. Treat every skill as **arbitrary code with user privileges.**
- **Signing/provenance:** sign the operator's own published skills; pin content hashes + commit SHAs.
- **Continuous re-scan for rug-pulls:** re-verify description-hash drift + re-scan on **every update**, not just install — defeats the rug-pull class (description mutates post-install). A GPT-based static scan flags external-URL fetches / network calls / tool-purpose mismatch on ingest *and* update.
- **HITL** on destructive/irreversible tool calls.

**RATIONALE:** The `SKILL.md` artifact is portable and vendor-neutral; the operator owns the registry, so this is a personal capability store, not a marketplace economy. The two genuinely hard build-it-yourself problems are (a) the **mid-session reload UX** and (b) the **continuous rug-pull-resistant scan** — everything else has OSS building blocks (FastMCP Skills Provider, skills-mcp vector search).

**REJECTED:** *Marketplace with payments/payouts/take-rate* (out of scope §0). *Anthropic `/v1/skills` API as the loader* (container has ZERO network access → kills any skill calling render/comms/model APIs). *Install-time-only review* (defeated by rug-pulls). *Letting the engine/reviewer talk to MCP servers directly* (no enforcement point).

**ABSTRACTION / SEAM:** The **Skill-Broker MCP server** (`search_skills`/`download_skill`, SEP-2640-shaped) is the discovery seam; the **MCP Gateway** is the security/scoping seam; a **capability-negotiation layer** wraps spec revisions + beta headers (`mcp-client-2025-11-20`, `advanced-tool-use-2025-11-20`) so churn doesn't break the platform.

---

## 10. Orchestration / workflow engine

**DECISION:** A **plan → build → review loop** orchestrator (the §3 builder + eval-gated reviewer) with explicit support for **fan-out (map-reduce)**, **judge panels (panel-of-judges / PoLL)**, and **HITL gates**. Default to **single-agent-with-tools**; escalate to multi-agent **only when provably breadth-first** (multi-agent ≈ 15× tokens). Keep hierarchies **shallow** (each level adds ~2s before workers start — bad for mobile/comms UX).

**Loop:**
```
Plan (Claude, DEEP + human checkpoint)
  → Build (Claude builder)
  → Review (GPT reviewer, IF eval-gated on — §3)  → findings → fix loop → (clean | gate)
  → HITL gate (desktop / mobile / Telegram) on any sensitive/irreversible action
```
- **Fan-out** only when item count is unknown at design time (map-reduce).
- **Judge panel** reserved for auto-merge / auto-publish decisions (single LLM judges are adversarially manipulable).
- **HITL gates** are **durable** (survive restart) and offer approve / edit / reject / respond.

**RATIONALE:** Orchestrator-worker is the dominant production pattern, but single-agent is cheaper and lower-latency for most flows; multi-agent and judge panels cost real tokens/latency and are reserved for where they pay off (breadth, irreversibility).

**REJECTED:** *Multi-agent-by-default* (15× cost). *Single LLM judge for auto-merge/publish* (manipulable). *Non-durable gates* (lost on restart — the platform is built to survive restarts).

**ABSTRACTION / SEAM:** Workflows are **declarative graphs** (`plan/build/review/fanout/judge/gate` nodes) over the `AgentEngine` + `Router`; a new workflow is data, not code. Gates implement a **`HumanGate` interface** delivered to whichever surface (desktop/mobile/Telegram) the operator is on.

---

## 11. Comms: Telegram-first + WhatsApp two-lane

**DECISION:** **Telegram-first** (default, zero ban risk), **WhatsApp two-lane** (opt-in). Inbound messages are **untrusted input** (§16 lethal-trifecta). The runtime already exposes `mcp__whatsapp__*` tools encoding exactly this dual design.

- **Telegram (primary):** **grammY** (TS) on the hosted Bot API for messaging; add a **self-hosted local Bot API server** (`ghcr.io/gramiojs/telegram-bot-api`) for the media studio's **2 GB** file limit + local-file-path returns. Free, instant, ToS-friendly, agentic features.
- **WhatsApp Lane A (unofficial, opt-in, operator's own number):** **whatsmeow (Go) sidecar — primary**, Baileys secondary for newsletter/view-once. **Isolated process** (§2). The operator **opts into the ban risk on their own number** (accounts last 2–8 weeks, proactive-outreach ban waves) with a **loud warning**. Reactive/low-volume posture.
- **WhatsApp Lane B (official, opt-in):** **Cloud API** via `wa_set_cloud_credentials` for any business/broadcast use. Note Meta's Jan 2026 general-purpose-AI restriction — keep the official lane for sanctioned uses only.

**Inbound-as-untrusted handling:** every inbound comms message is treated as a potential prompt-injection vector. Outbound sends + destructive ops are **gated behind allowlists + explicit confirmation**; untrusted inbound content is run through a review pass before any action; the comms sidecar cannot widen tool scope.

**RATIONALE:** Telegram is the most AI-agent-friendly major platform (free, no ban risk, 2 GB self-host media path). WhatsApp is legally hostile (official lane bans general AI; unofficial lane bricks numbers) — so it's strictly opt-in, isolated, and operator-consented. Single operator means the "ban risk" is the operator's own informed choice on their own number.

**REJECTED:** *WhatsApp-first / unofficial-as-default* (HIGH ban + supply-chain risk; `lotusbail` precedent). *MTProto userbots for "reply as me"* (use Telegram's sanctioned automation instead). *Embedding the WA sidecar in Core* (a WA compromise would reach the engine — must be isolated).

**ABSTRACTION / SEAM:** A **`CommsChannel` interface** (`send/receive/onTrigger`) with Telegram + WA-unofficial + WA-official impls behind one **comms gateway** with a central rate-limiter/queue. Adding Slack/Discord/email later is a new `CommsChannel`, no Core change.

---

## 12. Mobile + remote-control plane + sync + P2P

**DECISION:** A **React Native + Expo thin client** (NOT an on-device agent — Opus-class work is infeasible on a phone; mobile drives the desktop Core) over a **relay-brokered E2EE WebSocket** control plane, **forking Happy Coder (`slopus/happy`, MIT, ~95% TS)**. Both desktop Core and phone open **outbound** WSS to a dumb self-hosted relay that forwards only encrypted blobs.

- **Crypto:** **X25519/ECDH key agreement + AES-256-GCM**; Noise/ECDH handshake.
- **Pairing:** **QR + short-lived (~2 min) one-time token** carrying the desktop's public key; timeboxed.
- **Sync:** **Yjs** (`y-websocket` over the relay + `op-sqlite`/MMKV offline persistence) for session/scheduler/marketplace state. **Automerge 3.0 reserved** for versioned/branching subsystems only.
- **Reachability (two-layer, swappable):** **Cloudflare Tunnel** for public web surfaces; **Tailscale / Headscale / raw WireGuard** for private admin access.
- **P2P:** **relay-first** (covers the 15–25% of clients that pure WebRTC/libp2p fails on via symmetric NAT/CGNAT). **True P2P (WebRTC + coturn) is optional and deferred** — relay covers ~80% of the need at near-zero cost.

**RATIONALE:** The proven 2026 pattern is **not pure P2P** — it's relay-brokered E2EE WebSocket: zero inbound ports, CGNAT/firewall traversal, sleep-survival. Happy Coder is the closest existing impl (~80% of the requirement, directly forkable). Expo wins for JS/TS reuse with the Node engine and the same RPC contract (§1). This reconciles the research's internal Yjs-vs-Automerge / is-it-really-P2P disagreement: **Yjs + relay-first is the decision; P2P is an optional later transport, not a v1 pillar.**

**REJECTED:** *On-device agent execution* (infeasible for Opus-class). *Pure WebRTC/libp2p P2P as the foundation* (fails 15–25% of clients, needs coturn ~$149/mo). *Flutter* (loses JS/TS engine reuse). *Anthropic Remote Control as the sole plane* (hosted, preview, tier-gated — keep as a complementary convenience only).

**ABSTRACTION / SEAM:** A **`SyncProvider` interface** (Yjs today, Automerge/Loro swappable) and a **`Transport` interface** (relay today, WebRTC P2P later) keep both swappable. The mobile client consumes the **same typed RPC contract (§1)** over the relay — the boundary is identical to desktop IPC.

---

## 13. Creative media studio routing

**DECISION:** A **provider-agnostic abstraction layer over aggregators + first-party + OSS self-host lanes** — never direct-vendor-only. Normalized internal interfaces: **`ImageJob` / `VideoJob` / `AvatarJob` / `VoiceJob`** (and `PublishJob` → §14). Models are swappable by config string. **Async-by-default + webhooks** (never block a chat turn on a multi-minute render).

**Routing lanes:** **fal.ai (primary) + Replicate (secondary)** aggregators · **first-party direct** (Google Veo/Gemini, OpenAI GPT Image) for SLA/new-version access · **OSS self-host** (ComfyUI/Wan/LTX-2/FLUX.1-dev on RunPod) as the vendor-outage/ban-free fallback lane (§17).

**Concrete picks (config, re-verify):**

| Modality | Draft / high-volume | Final / hero | Notes |
|---|---|---|---|
| **Image** | GPT Image 1 Mini (~$0.005), Seedream 4.5 (~$0.03) | **GPT-Image-1.5**, **Flux 2 Pro** (~$0.055, ~1265 Elo, multi-ref), **Nano-Banana-2** (Gemini 3 Flash Image, chat editing), Ideogram 3 (text-in-image), Recraft V3 (SVG/logo) | C2PA / SynthID on outputs |
| **Video** | Seedance 2.0 Fast (~$0.022/s), Hailuo 2.3, Wan | **Veo 3.1** (native audio + i2v, prod-credible), **Seedance 2.0** (volume), **Kling 2.x** (cinematic/dialogue), **Wan / LTX-2** (OSS self-host) | **NOT Sora 2 — it is dead** (sunset; no third-party APIs). At most a feature-flag with auto-fallback. |
| **Avatar** | Argil (BYO ElevenLabs voice, cheap short-form) | **HeyGen** (Avatar IV/V; migrate streaming → LiveAvatar), **D-ID / Tavus / Anam** (real-time, <300ms) | Self-host MuseTalk/LatentSync at high volume |
| **Voice / TTS** | **ElevenLabs** (Flash v2.5 / Multilingual), **Cartesia** (Sonic-3, lowest latency), **OpenAI** (gpt-4o-mini-tts / Realtime) | — | — |
| **Music** | **ElevenLabs Music v2** — the ONLY AI music with explicit commercial clearance + a real API | — | **Suno/Udio: NO API + active litigation → user-pasted assets only, never a dependency** |
| **Kinetic typography / assembly** | **Remotion** (React video) + Lambda | — | **Remotion Company License must be budgeted + `@remotion/licensing` per-render webhook wired from day one** |

**Compositor / render pipeline:** Remotion (deterministic kinetic typography, karaoke captions, b-roll, lower-thirds) on Media Workers (§2); ElevenLabs Scribe v2 / Deepgram for word-level caption timestamps. **Async orchestration:** submit + `webhook_url`, persist job IDs in the scheduler (§8), poll as fallback, surface progress to desktop/mobile/Telegram.

**RATIONALE:** The market moved 4+ times in 6 months (Kling, FLUX.2, Nano Banana 2, Seedream 4.5, **Sora 2's death**); hard-wiring any vendor guarantees dead code. The aggregator absorbs churn; first-party gives SLA; OSS gives an unbannable/offline lane. Provenance (C2PA/SynthID) and consent (§14) are legal obligations even for a single operator.

**REJECTED:** *Direct-vendor integrations only* (rot fast). *Building on Sora 2* (dead). *Suno/Udio as a dependency* (no API + litigation). *Midjourney via wrappers* (ToS ban — manual/external only).

**ABSTRACTION / SEAM:** Each `*Job` interface is the seam; "a model" is just a routed endpoint behind a config string — **each media model can itself be a Skill (§9)** that selects an endpoint. A **geopolitical/data-residency flag** on the router can exclude Chinese-owned models (Kling/Seedance/Wan/Seedream) when the operator sets it.

---

## 14. Publishing

**DECISION:** A **`PublishProvider` abstraction** over YouTube / TikTok / Instagram / Facebook / Threads / X / LinkedIn / Pinterest / Bluesky, with a **hybrid direct-API + aggregator** strategy and **HITL / draft-mode publishing by default**. Per-platform quotas/audits tracked in SQLite. **Provenance + consent are mandatory** (legal, not commercial).

- **Direct APIs** where ROI is clear (YouTube, Meta-family — one Meta review covers IG/FB/Threads).
- **Aggregator** for breadth from day one: **Ayrshare** OR **self-hosted Postiz** (⚠️ **AGPL-3.0 — run network-served as a backend, do NOT bundle into the desktop/mobile binary; get a quick license sanity-check**) OR upload-post.
- **HITL / draft-mode:** publishing defaults to **draft/approve** (esp. TikTok unaudited = SELF_ONLY anyway). Per-platform **quota/rate tracker** (YouTube 1600 units/upload; TikTok ~15–25/creator/24h; IG 100/24h; Threads 250/24h). X: links in **replies/bio**, not main post, to dodge the ~$0.20/URL charge.
- **Provenance / AI-labeling:** store + expose **C2PA / SynthID**; AI-generated labeling on every published asset.
- **Biometric consent:** explicit **consent capture + identity verification before any avatar/voice cloning** (biometric-consent law applies regardless of single-operator status — it protects the *cloned person*, who may not be the operator).

**RATIONALE:** Each platform has heavy independent gates (TikTok audit 2–6 wks, LinkedIn Partner Program weeks–months, YouTube quota); the aggregator absorbs that burden while direct APIs win on volume. HITL/draft-mode is the safe default for irreversible public actions. Provenance + consent are non-negotiable legal obligations.

**REJECTED:** *Direct-API-only* (8 platform audits at launch is infeasible). *Auto-publish without HITL* (irreversible public action — too risky as a default). *Bundling AGPL Postiz into the app binary* (copyleft reach — run it network-served).

**ABSTRACTION / SEAM:** `PublishProvider` (`publish/schedule/quota/status`) with direct + aggregator impls; provenance/consent enforced in **Maestro's own layer** (§ media consent/moderation) before dispatch, not delegated to vendors.

---

## 15. System integration

**DECISION:** All native concerns behind the `PlatformAdapter` (§1):
- **Reference-counted, job-scoped prevent-sleep:** **`prevent-app-suspension`** for headless runs (lets the display sleep, saves battery) and **`prevent-display-sleep`** only when the operator is actively watching a render/stream. **Reference-counted** (acquire on job start, release on completion/failure/cancel; the last release lets the machine sleep). A wake-lock is **not** a completion guarantee — pair with durable resume (§8).
- **Native notifications** (job complete, gate needed, budget warning) + **deep links** (`maestro://`) for OAuth callbacks and mobile→desktop hand-off.
- **Signed auto-update**: `electron-updater` + **macOS notarization** (mandatory — auto-update breaks on macOS without it; Apple Developer Program $99/yr) + **Windows OV code-signing** (~$200–300/yr; EV no longer required since MS dropped EV OIDs Aug 2024). Notarization/signing is a **release gate**.
- **Super-Tester browser-extension bridge** exposed as an **agent tool surface** (§ MCP) — reuse the existing extension's capabilities as a tool the agent can call (browser automation/inspection), routed through the MCP gateway like any tool.

**RATIONALE:** "Jobs don't die because the Mac slept" is a core tenet, but display-sleep prevention drains battery needlessly — hence the app-suspension-vs-display split + reference counting + release-on-completion. Signing/notarization is recurring and **blocking** for auto-update, so it's budgeted and gated.

**REJECTED:** *Always prevent display sleep* (battery drain when only headless work runs). *Unsigned/un-notarized builds* (auto-update breaks; OS warnings). *Treating wake-lock as durability* (forced sleep/hibernate still interrupts — resume covers it).

**ABSTRACTION / SEAM:** `PlatformAdapter` is the seam (Electron impl now, Tauri impl later); the sleep-blocker is a **reference-counted service** any subsystem acquires/releases; the Super-Tester bridge is a **Tool** behind the gateway.

---

## 16. Observability + cost metering

**DECISION:** **OpenTelemetry GenAI semantic conventions + self-hosted Langfuse** for traces, with a **unified budget ledger** as a first-class signal. Live meters + loop guards everywhere.

- **Tracing:** OTel GenAI conventions (pin versions — still experimental) across desktop → relay → mobile → media workers; per-job thinking/reasoning-token telemetry feeds the **effort auto-tuner (§5)**.
- **Unified budget ledger:** one service meters **everything** — LLM tokens × effort multipliers, container-hours (~$0.05/hr), session-hours (~$0.08/hr), web search (~$10/1K), image ($0.005–0.24), **video (a single 4K+audio minute ≈ $35–45)**, avatar minutes, Remotion render licensing, per-platform publishing costs (X's ~$0.20/URL trap). Spend rolls up Job → Project → Workspace (§7).
- **Live meters + pre-run estimates** surfaced in UI before any DEEP/MAX or media run.
- **Loop guards:** `max_iterations` + `max_budget_per_session` enforced at the router (§4); **hard per-project caps return 429 on exceed.**
- **Auto-downgrade + batch/cache:** auto-downgrade to a cheaper model near caps; Batch (−50%) + prompt caching (~90%) enforced on scheduled/background runs.

**RATIONALE:** Cost governance is the operator's bill-shock shield (Replit's documented $1k/week shocks, Devin's opaque ACUs are the anti-pattern). It exists **only** to protect the single operator — never to bill anyone (§0). Self-hosted Langfuse avoids lock-in (Helicone is in maintenance mode).

**REJECTED:** *Per-subsystem ad-hoc metering* (the fragmentation the critique flagged — must be one ledger). *Hosted observability with lock-in.* *Soft/advisory caps* (must be hard 429s to actually prevent bill-shock).

**ABSTRACTION / SEAM:** A **`BudgetLedger` service** is the single metering seam (every cost-incurring subsystem reports to it); OTel exporters are swappable (Langfuse today). The auto-tuner reads telemetry, writes effort defaults — a closed loop.

---

## 17. Reliability / fallbacks

**DECISION:** A **per-dependency degradation matrix** with concrete fallbacks:

| Dependency | Primary | Fallback | Mechanism |
|---|---|---|---|
| **Agent engine** | Claude Agent SDK | **OpenHands (MIT, self-host)** | `AgentEngine` interface drop-in (§3); offline/air-gapped/Anthropic-outage |
| **LLM provider** | Claude/GPT via LiteLLM | Provider failover + auto-downgrade | Router (§4) |
| **Media vendor** | fal.ai / first-party | **OSS self-host lane (Wan/LTX-2/ComfyUI)** | `*Job` interface flips cloud↔local (§13); vendor outage/ban |
| **Long job vs OS power event** | wake-lock (§15) | **Durable checkpoint/resume** | Scheduler (§8) — the real guarantee |
| **Network reachability** | direct/Tunnel | **Relay-first** | §12 — survives NAT/CGNAT (15–25% of clients) |
| **Render reliability** | webhooks | **Polling fallback + retries** | Async orchestration (§13) |
| **Comms** | Telegram | WhatsApp lanes / queue+retry | §11 |
| **Datastore** | SQLite/Redis | Postgres/pg-boss | §7/§8 repository seam |

**RATIONALE:** The critique correctly demanded a single failure-mode matrix instead of per-section footnotes. Every external dependency in this fast-moving landscape (Anthropic billing churn, Meta bans, model death) needs a defined degradation path. Durable resume — not a wake-lock — is the actual completion guarantee.

**REJECTED:** *Single-vendor hard dependency anywhere* (Sora 2's death is the cautionary tale). *Wake-lock as the reliability story* (forced sleep still interrupts).

**ABSTRACTION / SEAM:** The interfaces from §3/§4/§7/§8/§12/§13 **are** the fallback seams — each fallback is a swap-in behind an existing interface, never a special case.

---

## 18. Modular plugin runtime + extension SDK

**DECISION:** **Everything above the Foundation core is a plugin** loaded over a **stable contract** into the Extension/Skill Host (§2), VS Code-style. First-party AND third-party features load on the fly via the **same manifest + lifecycle + capability model**.

- **Manifest:** Claude-plugin-aligned (`.claude-plugin/plugin.json`-style) declaring: id/version, contributed **skills + MCP servers + hooks + UI surfaces + triggers + channels**, and a **declared capability/permission set** (which tools, network hosts, FS paths, comms channels it may touch).
- **Lifecycle:** `discover → verify(signature/scan) → activate(scoped token) → run → deactivate/unload`. Activation grants only the manifest-declared, operator-approved capabilities (deny-by-default).
- **Capability/permission model:** a plugin **cannot widen** its grant at runtime; the Extension Host enforces the manifest; all tool calls route through the MCP gateway (§9). First-party plugins use the **same contract** as third-party (dogfooding the seam).
- **Distribution:** Git repos / the operator's registry (§9); on-the-fly install without app updates.

**RATIONALE:** "The core is a thin runtime; every capability is a module over a stable contract" is the founding tenet (#2). One contract for first- and third-party keeps the core thin and the seam honest. The capability model is the security boundary (arbitrary-code-with-user-privileges reality).

**REJECTED:** *Hard-coded first-party features* (breaks "add features on the fly"; two code paths). *Plugins with ambient/unscoped privileges* (RCE surface). *A bespoke non-MCP plugin protocol* (loses interop with the Claude/MCP ecosystem).

**ABSTRACTION / SEAM:** The **plugin manifest + capability grant + Extension Host RPC contract** is the SDK seam. The kernel (F1) only knows the contract, never a specific plugin.

---

## 19. Packaging / repo strategy

**DECISION:** A **single TypeScript-first monorepo** (pnpm workspaces + Turborepo), with **Go/Rust sidecars only where forced.**

```
maestro/
├── apps/
│   ├── desktop/            # Electron shell (renderer UI + Main + PlatformAdapter)
│   └── mobile/             # React Native + Expo thin client (forked Happy)
├── packages/
│   ├── core/               # Maestro Core: UI-agnostic Node service (engine host, RPC server)
│   ├── rpc-contract/       # the typed RPC/IPC contract (shared desktop+mobile+core)  ← THE seam
│   ├── engine/             # AgentEngine interface + Claude-Agent-SDK impl + OpenHands fallback
│   ├── router/             # LiteLLM integration + Effort mapping
│   ├── scheduler/          # JobQueue interface + BullMQ/pg-boss impls
│   ├── data/               # Repository layer (SQLite) + canonical data model + migrations
│   ├── skills/             # Skill-Broker + MCP Gateway + Extension Host
│   ├── comms/              # CommsChannel gateway (grammY)
│   ├── media/              # *Job interfaces + fal/Replicate/first-party/OSS routing + Remotion
│   ├── publishing/         # PublishProvider abstraction
│   ├── sync/               # SyncProvider (Yjs) + Transport (relay)
│   ├── secrets/            # SecretStore (keychain) + OAuth
│   ├── observability/      # OTel + Langfuse + BudgetLedger
│   └── plugin-sdk/         # manifest + lifecycle + capability model (first+third party)
├── sidecars/
│   ├── whatsmeow/          # Go — WhatsApp unofficial lane (isolated process)
│   └── relay/              # self-hosted E2EE WebSocket relay (forked Happy)
└── services/
    └── skill-registry/     # the operator's OWN online skill registry (publish/search/download) — NO payment layer
```

**Languages:** **TS for everything possible** (engine, core, UI, mobile, most sidecars). **Go** for the whatsmeow WhatsApp sidecar (the canonical library). **Rust** reserved only if a future Tauri re-shell or a perf-critical sidecar demands it.

**Build/release pipeline:** Turborepo task graph; per-app builds; **signed auto-update is a release gate** (macOS notarization + Windows OV signing, §15); the relay + skill-registry deploy as the operator's own services (Cloudflare Workers/containers).

**RATIONALE:** TS-first maximizes reuse across desktop/mobile/core (the whole reason Expo + Node-SDK beats Flutter). A monorepo keeps the **`rpc-contract` seam** and all interface packages in one place so the abstractions stay honest. Go/Rust only where a library mandates it (whatsmeow) — no gratuitous polyglot tax.

**REJECTED:** *Polyrepo* (the shared RPC contract + interfaces would drift across repos). *Polyglot-by-preference* (every non-TS package is a reuse + hiring + build tax; only pay it when forced). *Bundling the skill-registry into the app* (it's the operator's online service, not desktop code).

**ABSTRACTION / SEAM:** `packages/rpc-contract` is the load-bearing seam binding desktop ↔ core ↔ mobile; every `*-interface` package (engine/router/scheduler/data/sync/secrets/plugin-sdk) is an explicit swap point matching the abstractions named throughout this ADR.

---

## Appendix A — Binding invariants (every PRD section must uphold)

1. **Single operator. Workspace is the top entity. No Org, no tenancy, no teams, no SSO/SCIM/RBAC, no monetization, no marketplace payments.** (§0, §7)
2. **Never hard-code a model ID, price, or vendor** — route through the LiteLLM router + Effort abstraction; everything is re-verifiable config. (§3, §4, §5, §13)
3. **Agent-invisible secrets** in the OS keychain; the agent uses credentials it never sees. (§6, §16)
4. **Mandatory MCP gateway** between BOTH engine and reviewer and ALL third-party tools/skills; treat every skill/MCP as arbitrary code; continuous re-scan for rug-pulls. (§2, §9)
5. **Durable scheduler with checkpoint/resume + idempotency + misfire policy** is the real reliability guarantee — a wake-lock is not. (§8, §15, §17)
6. **One canonical data model with explicit inheritance; one unified budget ledger; one append-only audit log.** No per-subsystem fragmentation. (§7, §16)
7. **Telegram-first; WhatsApp opt-in/isolated/consented; inbound is untrusted.** (§11)
8. **Mobile is a thin client** over a relay-first E2EE WebSocket; **P2P is an optional later transport, not a v1 pillar; Yjs is the sync default.** (§12)
9. **Media/effort/publish default to the cheap/safe tier** with HITL gates and pre-run cost estimates; **Sora 2 is dead; Suno/Udio are not dependencies.** (§5, §13, §14)
10. **Everything above the thin core is a plugin over one stable, capability-scoped contract** — first-party and third-party identical. (§18)
11. **The GPT reviewer must pass the eval gate to ship on-by-default** — it is droppable, not sacred. (§3, §10)
12. **"Phasing" = build order** (parallel workstreams on one critical path `F1 → F2/F3 → E1 → D1 → D2`), **never product tiers.** (decomposition §9)

---

## Appendix B — Build order (critical path; NOT tiers)

All subsystems are in scope and built. Build order = dependency-driven parallel workstreams sharing one spine:

- **Spine (blocks most):** Plugin kernel → Secrets/OAuth + Budget ledger → Agent engine (Claude SDK + router + effort) → Projects/data model → Durable scheduler.
- **Capability (parallel after engine):** MCP gateway + Extension Host → Skill-broker → operator's skill registry.
- **Orchestration (parallel after engine):** plan→build→review loop + (eval-gate the reviewer) + judge panels + HITL gates.
- **Reach (parallel after sync backbone):** relay + sync → mobile thin client → Telegram → WhatsApp two-lane.
- **Studio (parallel, needs only the engine):** media `*Job` routing → trends/research → publishing.
- **Shell (continuous):** desktop command center grows alongside everything.

**First integration milestone (de-risks every seam before pouring concrete):** Spine + one end-to-end vertical — one Project Template running a scheduled Job that loads one registry skill, metered by the budget ledger, visible on desktop, approvable from the phone over the relay.
