# Maestro — Foundational Research Brief

> Auto-generated from workflow wf_07dcf9ad-093 (17 research domains -> 4 syntheses -> critique). Mid-2026 snapshot. Raw per-domain findings in research/findings.json.


---

# Competitive Landscape, Agent Engines & Differentiation

I'll synthesize this research into a tight, decision-useful PRD section. This is a writing/synthesis task — the research JSON is already provided, so no further investigation is needed. Let me produce the Markdown section directly.

# Competitive Landscape, Agent Engines & Differentiation

> **Snapshot caveat (mid-2026):** Model IDs, pricing, ToS terms, and Agent-SDK billing in this section shifted multiple times in H1 2026 and are point-in-time. Treat every price/limit as config to re-verify at build time, not a hardcoded constant.

## 1. State of the Art & Key Players

The AI coding-agent market has **converged on one architecture**: parallel agents, each isolated in its own git worktree/branch, behind a plan-then-act gate, with a review/merge-to-PR loop and increasingly cloud/background execution. **This loop is now table stakes, not a differentiator** — Cursor, Conductor, Warp, Factory, and Zed all ship it.

### Competitive map

| Tool | Pattern | Pricing (mid-2026) | Open? | Notes for us |
|---|---|---|---|---|
| **Cursor 3 / Composer 2.5** | 8 parallel agents in worktrees (`/multitask`, `/worktree`, `/best-of-n`, `/apply-worktree`); local + cloud handoff | Hobby $0 / Pro $20 / Pro+ $60 / Ultra $200; Teams $32–$96/seat | No SDK | Strongest desktop multi-agent UX. Composer 2.5 (built on Kimi K2.5) at **$0.50/$2.50 per MTok, ~6.7 min/task** is the cost benchmark our scheduler must beat. UX command set to match. |
| **Conductor** (Melty Labs) | Mac orchestrator: parallel Claude Code/Codex/Cursor in worktrees+branch (~10s spin-up), Plan Mode, Code Review, 1-click PR, MCP, message queues | **FREE app, BYO subscription** | No SDK | **The single closest existing product to our core.** Validates the architecture. **Gaps to beat: Mac-only, no mobile, no native scheduler, no WhatsApp/Telegram, no image/video, no P2P.** Tracks frontier models within days (Opus 4.8 added May 28). |
| **Warp 2.0 (ADE)** | Terminal-as-workbench; hosts its agent + Claude Code + Codex + Gemini CLI as tabs; "Oz" cloud execution | Free 150 cr/mo; Build $20; Business $50/seat | OSS ADE | Best reference for **hosting heterogeneous engines under one UI** — close to our "run any engine" ambition. |
| **Factory (Droids)** | Cross-surface parallel Droids: desktop+CLI+TUI+web+IDE+Slack with **synced sessions/skills**; Factory Bridge runs in local env | Pro $20 / Plus $100 / Max $200 | CLI+SDK | Best reference for **cross-surface continuity** — exactly our desktop+mobile+messaging goal. Raised $150M at **$1.5B** (Apr 2026). |
| **Devin** (Cognition) | Full autonomy; parallel managed sessions, playbooks, knowledge base | Free / Pro $20 / Max $200; **ACU billing ~$2.00–2.25 (~15 min each)** | Closed | High-autonomy benchmark. **Opaque ACU cost is the #1 complaint** — our transparent per-project budget is the counter. |
| **Windsurf → "Devin Desktop"** | Cascade agent, in-house SWE-1.5/1.6 | Pro $20 (↑ from $15 Mar 2026); moved credits→quotas Mar 19 | Closed | **Consolidation cautionary tale**: acquired by Cognition (~$250M, Dec 2025) and rebranded fast. Don't hard-depend on any single IDE. |
| **Replit Agent 3** | Cloud build-and-deploy, ~200-min autonomy, self-healing tests | "Effort-based" checkpoints; simple edit ~$0.10–0.25, complex feature $5+ | Closed | **Bill-shock cautionary tale**: effort checkpoints + autonomous subagent spawning produced documented **$1,000/week bills** (up from $180–200/mo). |

### Open-source / model-agnostic anchor (de-risks lock-in)

- **OpenHands** (MIT, 71k★, self-hostable) — 68.4% SWE-bench Verified w/ Opus 4.6; **~$0.20–1.05/task self-hosted**. Leading self-hostable fallback; Cloud SDK + mobile prior art.
- **Cline** (Apache 2.0, 30+ providers) — clean plan/act gate; BYOK floor ~$0.50–2.00/feature.
- **Aider** (Apache 2.0) — **gold-standard architect/editor cost-split (30–50% cheaper)** + git-atomic commits; directly applicable to our builds/reviews pipeline.
- **Zed** — **ACP (Agent Client Protocol)**, an open protocol to plug in Claude Code/Codex/OpenCode behind one interface.
- **Continue** (Apache 2.0, 2.5M+ installs) — **IDE Agents (sync) vs Cloud Agents (async, event-driven)**; best reference for our background-agent + scheduler vision.

### Frontier engines (the engine+reviewer split this product proposes)

| Role | Model | ID | Price /MTok | Context | Notes |
|---|---|---|---|---|---|
| **Primary builder** | Claude Opus 4.8 | `claude-opus-4-8` | $5 / $25 | 1M (200k on Foundry) | 128k output, effort defaults `high`, Jan 2026 cutoff. Released May 28, 2026. |
| **Default driver** | Claude Sonnet 4.6 | `claude-sonnet-4-6` | $3 / $15 | 1M | Most production turns. |
| **Cheap subagent** | Claude Haiku 4.5 | `claude-haiku-4-5` | $1 / $5 | 200k | Classification, routing, comms. |
| **Reserve tier** | Claude Fable 5 | `claude-fable-5` | $10 / $50 | 1M | GA June 9, 2026; always-on adaptive thinking. Meter carefully. |
| **Reviewer (GPT)** | GPT-5.5 *(default Codex model)* | `gpt-5.5` | $5 / $30 | ~1.05M | Released Apr 23/24, 2026; powers OpenAI's own "Code review." There is **no separate `gpt-5.5-codex`**. |
| **Cheaper reviewer** | GPT-5.4 / 5.4-mini | `gpt-5.4` / `gpt-5.4-mini` | $2.50/$15 / $0.75/$4.50 | — | Two-tier review pre-screen. |

> **Note on GPT review-model version:** earlier research cited GPT-5.3-Codex (Feb 2026, ~$1.75/$14) as the reviewer; the OpenAI-specific research supersedes this with **GPT-5.5 as the current Codex default** ($5/$30). The line moves ~monthly (GPT-5.6 already teased; GPT-5.2/5.3 deprecated for sign-in). **Treat the reviewer model ID as config with a fallback.**

Cost-discounting levers available on both providers: **Batch API −50%**, **prompt caching (~90% off cached input, cache-read ~0.1× base)**.

---

## 2. Recommendation for Our Universal Agent Platform

**Win on what no competitor ships *together*, not on the commoditized loop.**

### 2a. The engine+reviewer split (validated by the market)
- **Claude Opus 4.8 = primary builder** (xhigh effort in plan mode), **Sonnet 4.6 = default driver**, **Haiku 4.5 = subagents/comms**.
- **GPT-5.5 = independent cross-vendor reviewer** (medium/high `reasoning_effort`, **low `verbosity`** for terse, rigorous critiques).
- Cross-vendor critique catches single-vendor blind spots — exactly what OpenAI's own Codex review feature and Aider's architect/editor pattern validate. **Caveat:** independent benchmarks show Claude still leads SWE-bench Pro with lower hallucination, so **validate reviewer lift on our codebases before pricing it as a feature.**

### 2b. The differentiation (white space)
No competitor ships the full loop. We should own **all three together**:
1. **True per-project cron scheduler** (Continue/Warp Oz/Devin have pieces; none have it natively per-project).
2. **Background/remote agents that push results to mobile.**
3. **WhatsApp/Telegram triggering + notifications.**
4. Plus **mobile + P2P** and an **image/video studio** — none of which Conductor (our closest competitor) has.

### 2c. Treat the core loop as parity, not pitch
Match — don't market — worktree-per-agent isolation + plan-mode gate + review/merge-to-PR. Copy Cursor's `/worktree`, `/apply-worktree`, `/best-of-n` UX and Conductor's per-workspace setup script. Pitching this as differentiation makes us a me-too wrapper.

### 2d. Transparent cost control = a real differentiator
Ship **hard per-project spend caps, pre-run cost estimates, and live token/ACU meters** — directly countering Replit's $1k/week shocks and Devin's opaque ACUs. Use Batch API + prompt caching on all scheduled/background runs.

---

## 3. Build vs. Buy & Stack/Vendor Choices

### Engine: BUILD on the Claude Agent SDK (don't reimplement the harness)
Embed `@anthropic-ai/claude-agent-sdk` (TS, Node 18+, bundles a native binary per platform) in the **Electron main process**, streaming over IPC to the renderer; use `claude-agent-sdk` (Python 3.10+) for the backend/scheduler/comms tier. Inherit for free: built-in tools, programmatic **subagents** (`AgentDefinition`), **lifecycle hooks**, **MCP** (stdio/SSE/HTTP/in-process), **six permission modes incl. plan mode**, and resumable/forkable **JSONL sessions** (maps directly to "per-project"). Build on the **stable V1 `query()` API behind a thin adapter** — the V2 session preview is unstable and already flagged for removal.

### Auth/business model: BUY first-party API access — do NOT resell consumer subscriptions
**This is the single most important stack decision.**

| Option | Verdict |
|---|---|
| **Per-user/org API keys** (or Bedrock/Vertex/Azure Foundry/Claude Platform on AWS) | **✅ Recommended.** Only ToS-compliant, ban-safe foundation for a shipped multi-tenant product. Cloud routes add enterprise procurement + data residency. |
| **BYO consumer Claude/Codex subscription** (Conductor-style, headless/scheduled) | **❌ Avoid.** Anthropic explicitly forbids third-party use of claude.ai/Pro/Max OAuth and **has banned tools that did it (OpenClaw, OpenCode, Roo Code, Goose) since Jan 2026**. OpenAI side has documented Pro bans + billing inconsistencies. The June-15-2026 Agent-SDK subscription credits are tiny, non-rollover, and shared with the user's own `claude -p` — unusable as a platform base. |

### Recommended stack

| Layer | Choice | Why |
|---|---|---|
| **Primary engine** | Claude Agent SDK (TS + Python) | Same harness as Claude Code; deepest native MCP |
| **Reviewer** | GPT-5.5 via raw OpenAI Responses API (API key) | Cleanest ToS; 1.05M context fits whole PRs; reach for Codex SDK only when reviewer must read repo/run commands (read-only sandbox) |
| **Multi-engine hosting** | **MCP everywhere; consider Zed's ACP** | Host Claude Code/Codex/OpenHands/OpenCode behind one interface — insurance vs repricing/acquisition |
| **Durable execution / scheduler** | **Trigger.dev v4** (TS-native, pausable HITL, no-pay-while-waiting) or **Inngest AgentKit** (event-driven, `useAgent` browser streaming); **Temporal** only for multi-week mission-critical (then add payload codecs to avoid history saturation) | Don't hand-roll durability/retries for background jobs |
| **LLM gateway** | **LiteLLM** (self-hosted) | Virtual keys per project, `max_budget`/`budget_duration`, `max_iterations` + `max_budget_per_session` to kill runaway loops, provider failover. Implements cost-control NFRs + reduces lock-in in one component |
| **Secrets** | **Infisical Agent Vault** (agent uses credential without seeing it) or Vault dynamic secrets | Survives prompt injection; store BYO keys encrypted, per-tenant |
| **Observability** | **OpenTelemetry GenAI conventions + self-hosted Langfuse** | Portable, no lock-in (avoid Helicone — maintenance mode). Conventions still experimental → pin versions |
| **Skills marketplace** | **MCP + Agent Skills (SKILL.md + `.claude-plugin/marketplace.json`)** | Interoperable with Anthropic's + community marketplaces (Agensi, SkillsMP) from day one |
| **Fallback engine** | **OpenHands (MIT), self-hosted** | Offline/air-gapped/Anthropic-outage; ~$0.20–1.05/task floor |
| **Mobile + P2P** | **Automerge** (Rust→iOS/Android FFI) + libp2p, cloud as relay | Offline-first; keep server-side audit copy for enterprise tenants |
| **Comms** | **Telegram Bot API primary; WhatsApp via official Cloud API/BSP only** | See risks |
| **Background execution** | SDK **Monitor tool** (event-driven, costs nothing while idle) over polling | Per-project scheduler, builds, long renders |

### Orchestration topology
**Orchestrator-worker (supervisor)** is the dominant production pattern (~70% of deployments) — but keep most flows **single-agent-with-tools** unless provably breadth-first (multi-agent costs ~15× tokens). Use **map-reduce fan-out** only when item count is unknown at design time. Keep hierarchies **shallow** (each level adds ~2s before workers start — bad for mobile/WhatsApp UX).

---

## 4. Risks & Tradeoffs

| Risk | Severity | Mitigation |
|---|---|---|
| **ToS / account-ban** — automating consumer Claude/Codex OAuth | **HIGH** | First-party API keys / cloud routes only. Never ship `bypassPermissions`. |
| **WhatsApp ban** — unofficial Baileys/Evolution libs violate Meta ToS; **15–30% ban rate for proactive messaging over 12 mo**; Meta blocking third-party AI chatbots since ~Jan 2026 | **HIGH** | Telegram-first; WhatsApp **official Cloud API/BSP only**; confine any unofficial use to opt-in, self-hosted, respond-only (<2% ban) with explicit disclosure. **Do not ship unofficial proactive WhatsApp in enterprise tier.** |
| **Cost runaway / bill shock** — Opus 4.8 loops ($5/$25, +35% tokens on new tokenizer), video (~$240/10 min 1080p Veo), opaque effort tokens billed as output | **HIGH** | Hard per-project caps (429 on exceed), pre-run estimates, model downgrades, Batch+caching, hook-based loop guards, `max_iterations`. |
| **Effort paradox** — high/xhigh effort is flat-or-worse on many tasks at 4–17× cost, 5–60× latency | **MED-HIGH** | Default LOW/MEDIUM; escalate only on verified-hard, eval-gated tasks. Surface cost multiplier in UI. |
| **Model/pricing volatility** — IDs/defaults change every 4–8 weeks; Opus 4.7/4.8 **removed `budget_tokens` (HTTP 400)**; Opus 4.1 retires Aug 5; Sonnet 4/Opus 4 retire June 15 | **HIGH** | Normalized **effort abstraction layer** (FAST/BALANCED/DEEP/MAX → per-vendor params); pin IDs; proactive migration. |
| **Vendor lock-in / consolidation** — Windsurf→Cognition, Factory at $1.5B | **MED-HIGH** | MCP/ACP layer + OpenHands fallback + LiteLLM routing. |
| **June 15, 2026 Agent-SDK credit change** | **MED** | API-key accounts unaffected (pay-as-you-go); model economics around this, not subscriptions. |
| **Security / prompt injection** — shell-access agents + third-party MCP/skills = RCE + exfiltration surface | **HIGH** | Sandboxed per-project dirs, deny-rules for network/destructive Bash, PreToolUse hook gating, agent-aware vault, sign/sandbox marketplace skills (treat all external content as untrusted). |
| **LLM-as-judge unreliability** — single judges are adversarially manipulable | **MED** | Panel-of-judges (PoLL) / adversarial verify for auto-merge/auto-publish. |
| **EU AI Act** — enforcement + fines (3% turnover / €15M) from Aug 2, 2026; high-risk agentic use needs audit trails + human checkpoints | **MED** | Immutable audit logs + HITL gates as P0/P1. |
| **P2P/local-first reliability** — CRDT history bloat, NAT traversal, schema migration | **MED** | Design migration/compaction up front; server-side audit copy. |

---

## 5. Must-Have Product Capabilities (implied)

1. **Worktree-per-agent isolation + plan-mode gate + review/merge-to-PR** — parity table stakes; copy Cursor/Conductor UX.
2. **Per-project cron scheduler** with durable execution (survives crashes/restarts) — core differentiator.
3. **Background/remote agents that push results to mobile** + **WhatsApp/Telegram triggering & notifications** — the white-space loop.
4. **Hard per-project spend caps, pre-run cost estimates, live token/ACU meters** — counter to the #1 market complaint.
5. **Multi-model routing** behind an LLM gateway: Opus 4.8 builder / Sonnet 4.6 driver / Haiku 4.5 subagents / GPT-5.5 reviewer — all config-swappable.
6. **Mode-aware effort** (plan = DEEP + human checkpoint; execution = BALANCED/FAST) with per-job override slider — Claude Code itself hasn't shipped this natively (#50323), so we own the orchestration.
7. **Provider-agnostic effort abstraction layer** (FAST/BALANCED/DEEP/MAX).
8. **Durable HITL approval gates** on every sensitive/irreversible action (send message, publish, merge, spend) — approve/edit/reject/respond, surviving restarts.
9. **Layered autonomy controls**: plan mode default → `dontAsk` + tight `allowedTools` for unattended runs → `acceptEdits` only in isolated dirs → **never** `bypassPermissions` for end users; PreToolUse/PostToolUse hooks for blocking + audit.
10. **Skills marketplace** on MCP + SKILL.md with **signing/provenance, sandboxing, security review, and a monetization/billing primitive** (greenfield — no standard registry-billing exists).
11. **Enterprise readiness as P0/P1, not an afterthought**: SAML/OIDC SSO + SCIM, RBAC, immutable+exportable audit logs, zero-retention/no-training contractual language, BYOK, regional residency; SOC 2 Type II first, then ISO 27001/42001.
12. **Agent-aware secrets vault** (credential-without-visibility) + per-tenant encrypted BYO-key storage.
13. **OpenHands self-host fallback** for offline/air-gapped/outage scenarios.
14. **OTel-based observability** with per-job thinking/reasoning-token telemetry to auto-tune default effort per task type.
15. **Image/video studio with aggressive metering** (video is the cost driver — gate behind strict budgets).

---

**Bottom line for the founder:** The core agent loop is commoditized — Conductor already ships your architecture for free. Your moat is the **cross-surface orchestration layer** (per-project scheduler + mobile push + WhatsApp/Telegram + P2P + image/video) wrapped around a **compliant, first-party-API engine** (Claude builds, GPT-5.5 reviews), with **transparent budgets** as the trust differentiator versus Devin/Replit. Build on the Claude Agent SDK, route everything through an LLM gateway + durable execution engine, and treat every model ID/price as re-verifiable config. The two things that can kill you are **ToS bans** (never resell consumer subscriptions; Telegram-first comms) and **cost runaway** (hard caps from day one).


---

# Core Platform Architecture, Stack, Comms & Scheduling

This is a synthesis task. The research JSON is already provided in full, and my job is to write a tight, decision-useful Markdown PRD section. No file exploration is needed since this is pure synthesis. Let me write the brief.

---

# Core Platform Architecture, Stack, Comms & Scheduling

> Decision brief for our universal AI-agent platform (desktop + mobile, agent IDE + media studio + comms + per-project scheduler). All names, versions, and prices reflect mid-2026 research. Two themes dominate every decision below: **(1) ship velocity favors the Node-native, relay-first, BYO-key path now; (2) every external dependency is a fast-moving commercial/ToS risk — abstract it so it stays swappable.**

---

## 1. State of the Art: Key Options with Specifics

### 1.1 Desktop framework

| | **Electron (v3x, 2026)** | **Tauri v2** |
|---|---|---|
| Runtime | Bundled Chromium + Node.js (Node in **main process**) | Rust core + per-OS WebView (WebView2 / WKWebView / WebKitGTK) |
| Installer / RAM idle | 80–150 MB / 150–300 MB | 3–10 MB / 30–50 MB |
| Cold start | 1–2 s | <0.5 s |
| Rendering | Identical Chromium everywhere | Diverges per-OS (Linux WebKitGTK lags) → more QA |
| Security | Manual hardening (contextIsolation, sandbox, no nodeIntegration) | Capability **deny-by-default** |
| Mobile (iOS/Android) | **None** | **First-class, one codebase** |
| Node SDK bundling | In-process, zero packaging pain | Sidecar binary only (`externalBin`, SEA/pkg) |
| Sleep-blocking | **Built-in** `powerSaveBlocker` | Community-only (no official plugin; issue #3697 open since 2022) |
| Auto-update | `electron-updater` — de-facto, best-documented | Minisign updater, ~6 lines config, less documented |
| Ecosystem | Larger, more mature | Plugin registry grew 47 (Jan '25) → 120+ (Apr '26) |

**Decisive fact:** our primary engine, the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, ships a bundled CLI binary + subagents/sessions/MCP client), is a Node package. Electron runs it and Node MCP servers in-process with **zero sidecar/SEA pain**. Tauri requires shipping it as a sidecar (pkg is deprecated; Node 20+ SEA is the modern but awkward path).

### 1.2 AI model layer (June 2026 pricing, per Mtok in/out)

| Role | Model | Price | Notes |
|---|---|---|---|
| **Primary engine** | Claude **Opus 4.8** (May 28 2026) / 4.7 | $5 / $25 | Prompt caching ~90% off cached reads; Batch API 50% off |
| | Claude **Sonnet 4.6** | $3 / $15 | Workhorse tier |
| | Claude **Haiku 4.5** | $1 / $5 | Cheap/fast |
| **Independent review** | **GPT-5.1** | $1.25 / $10 (cached in $0.125) | No deprecation planned |
| | **GPT-5.1-Codex-Max** | — | Code-review diffs |
| **Image** | GPT Image 1.5 | ~$0.04 | ~1264 Elo (top LMArena) |
| | Flux 2 Pro | ~$0.055 | ~1265 Elo |
| | Nano Banana 2 / Gemini 3 Flash Image | ~$0.045 (512px)–$0.15 (4K) | |
| | GPT Image 1 Mini | ~$0.005 | Cheapest |
| **Video** | Google Veo 3.1 | $0.10–$0.60/sec (Vertex) | |
| | ByteDance Seedance 2.0 | ~$0.06–$0.13/sec | |
| | ~~OpenAI Sora 2~~ | **SHUT DOWN globally 2026 — do NOT design around it** | |

### 1.3 Mobile control plane & sync

The proven 2026 pattern for phone→desktop-agent control is **NOT pure P2P** — it is a **relay-brokered, end-to-end-encrypted WebSocket fabric**: the desktop CLI daemon and the phone each open an *outbound* WSS to a dumb relay that forwards only encrypted blobs. This gives zero inbound ports, CGNAT/firewall traversal, and sleep-survival. Pure WebRTC/libp2p/iroh fails for **15–25% of clients** (symmetric NAT/CGNAT) and always needs a TURN fallback (`coturn`, ~$149/mo + bandwidth + DDoS protection).

- **Anthropic Claude Code Remote Control** (GA-preview Feb 25 2026, Claude v2.1.52, Max tier): `claude remote-control`/`/rc` → QR/URL pairing. Outbound-HTTPS-only, short-lived scoped credentials. **But Anthropic-hosted (no self-host), preview-stage, tier-gated** → complementary, not foundational.
- **Happy Coder** (`slopus/happy`, MIT, ~22k stars, ~95% TS): CLI daemon + self-hostable encrypted relay + Expo app, X25519/ECDH/AES-256-GCM, push notifications, device handoff, voice. **Closest existing implementation — directly forkable (~80% of our requirement).**
- **CRDT sync:** Yjs (~920k weekly npm downloads, deepest ecosystem, `y-websocket`/`op-sqlite`/MMKV) is the default; Automerge 3.0 (Aug 2025, 10× memory cut, RN JSI bindings, Git-like history) for rich-JSON/versioned subsystems.
- **Reachability:** Tailscale (free cap removed 2026: unlimited devices) / Headscale / raw WireGuard for **private admin** access; Cloudflare Tunnel for **public** web surfaces. Complementary, not competing.
- **Client:** React Native + **Expo** beats Flutter here purely for JS/TS reuse with the Node engine (`react-native-webrtc`, Yjs/Automerge JS, Anthropic/OpenAI JS SDKs).

### 1.4 Comms channels

| | **Telegram Bot API (v10.0)** | **WhatsApp Cloud API (official)** | **WhatsApp unofficial (Baileys/whatsmeow/Evolution)** |
|---|---|---|---|
| Cost | **Free** (Stars only for digital goods) | Per-message: US Marketing $0.025, Utility/Auth $0.004, Service free | Free (no per-msg) |
| Onboarding | Instant (@BotFather) | Weeks (business verification + template approval) | Instant (QR/pairing) |
| Ban risk | **None** | Near-zero | **HIGH — accounts last 2–8 weeks; ban waves q2–3mo** |
| ToS for AI | Friendly; 2026 added agentic features | **Jan 15 2026: general-purpose AI "Providers" BANNED** (under CADE/Italy challenge) | Violates ToS |
| File limits | 50 MB up / 20 MB down (cloud); **2 GB via self-hosted local Bot API server** | — | Full app parity |
| Capability | Streaming (`sendMessageDraft` 9.5), bot-to-bot, guest mode, Mini Apps, Stars | Template-gated, no status/groups-at-scale | Full personal account (status, groups, channels, polls) |

Telegram is the most AI-agent-friendly major platform. WhatsApp's official lane is the only ToS-safe path **but is legally hostile to a general-purpose AI assistant** and is paid+slow; unofficial libs carry real ban-wave + supply-chain risk (Dec 2025 `lotusbail` trojan poisoned a Baileys wrapper, >50k installs, hardcoded pairing code added attacker as a linked device, persisted after uninstall).

### 1.5 Job scheduling

Self-host the scheduler — do not rely on Anthropic's **Claude Code Routines** (research preview, **1-hour minimum interval + per-account daily cap**, "green status ≠ task success" → too coarse for multi-tenant).

- **BullMQ** (Redis): cron Job Schedulers, global rate limiter, native OpenTelemetry.
- **pg-boss** (Postgres-only): cron lock, singleton dedup, opt-out retries — simpler if you're already on Postgres.
- Managed alternatives: Trigger.dev v4, Inngest, Temporal, Cloudflare DO Alarms.
- Adopt **Quartz misfire policies + idempotency keys** (at-least-once delivery double-sends without them). Use Routines only as an optional *dispatch backend*.

---

## 2. Recommendations for OUR Platform

1. **Ship v1 on Electron, not Tauri.** Node-native Claude Agent SDK + MCP servers in-process, built-in `powerSaveBlocker`, mature signed `electron-updater`, consistent Chromium rendering for the IDE/studio. Accept the bundle/RAM cost for velocity.

2. **Architect a hard process/IPC boundary now** so a future Tauri (or Tauri-mobile) port is a re-shell, not a rewrite. Keep the **agent engine, scheduler, comms, and media adapters as a UI-agnostic Node service** behind a typed IPC/RPC layer. Put all OS-native concerns (sleep-blocker, deep-link, OAuth loopback, auto-update) behind a thin platform interface with one Electron impl today.

3. **Mobile control plane = relay-brokered E2EE WebSocket** (copy/fork **Happy Coder**, MIT). Outbound-only WSS, X25519/ECDH/AES-256-GCM, QR pairing carrying the desktop's public key + a short-lived (~2 min) one-time token, then a Noise/ECDH handshake. Build the client in **React Native + Expo**. Treat Anthropic Remote Control as a complementary convenience, never the sole plane.

4. **Sync with Yjs** (`y-websocket` over the relay + `op-sqlite`/MMKV offline persistence) for session/scheduler/marketplace state; reserve Automerge 3.0 for versioned/branching subsystems. Isolate sync behind an abstraction (Yjs/Automerge/Loro swappable).

5. **Comms: Telegram first, WhatsApp two-lane.** Ship Telegram (hosted Bot API + **grammY** TS framework) as the default — free, instant, zero ban risk, agentic features. Add a **self-hosted local Bot API server** (`ghcr.io/gramiojs/telegram-bot-api`) for the media studio (2 GB files, local file-path returns). For WhatsApp, adopt a **two-lane abstraction**: (A) unofficial personal-account lane (**whatsmeow** Go sidecar primary, Baileys secondary for newsletter/view-once) where the *user opts into ban risk on their own number*; (B) official Cloud API as an opt-in business/broadcast lane. The runtime's `mcp__whatsapp__*` toolset (`set_cloud_credentials` + QR/pairing) already encodes this dual design. **Never expose a general-purpose AI assistant to third parties over the official Cloud API** (Jan 2026 ban). Use Telegram's sanctioned **Chat Automation** for "reply as me" instead of MTProto userbots.

6. **Scheduler = BullMQ or pg-boss, self-hosted.** Quartz misfire policies + idempotency keys on every job. Routines only as an optional dispatch backend.

7. **Model layer = provider-abstraction router.** Claude Opus 4.8/Sonnet 4.6 primary, GPT-5.1/Codex-Max as independent review pass, pluggable image/video backends. **Never hard-code a model ID** (Opus revved 4.5→4.7→4.8 in ~2 months; Sora 2 vanished). Hard-require prompt caching + Batch API on Claude.

8. **BYO-key by default.** End users bring their own Anthropic/OpenAI/image/video keys. This sidesteps Anthropic's reselling ToS, avoids the new non-rollover Agent-SDK credit pool exhausting under our schedulers, and removes us from cost-of-goods risk on long agent runs.

9. **Skills marketplace = Claude Code's plugin/skill conventions verbatim.** `.claude-plugin/plugin.json`-style manifest bundling skills + MCP servers + hooks, distributed as Git repos, indexed like the official MCP Registry (2,000+ servers), loaded into a **sandboxed extension-host process** (VS Code model) so third-party skills never touch the main process. On-the-fly features without app updates.

10. **Spike Tauri v2 mobile + Iroh/Automerge in parallel** to validate the cross-framework boundary and inform whether the eventual unification target is Tauri-everywhere.

---

## 3. Build-vs-Buy & Stack/Vendor Choices

| Layer | **Build / Self-host** | **Buy / Managed** | Decision |
|---|---|---|---|
| Desktop shell | Electron (OSS, free) | — | **Build on Electron** |
| Agent engine | Claude Agent SDK (OSS) | — | **Build on; BYO-key for usage** |
| Mobile client + relay | Fork Happy Coder (MIT, self-host relay) | Anthropic Remote Control (hosted, preview) | **Build (fork Happy); Anthropic RC as bonus** |
| Sync | Yjs / Automerge (OSS) | — | **Build (abstracted)** |
| Reachability | Headscale / raw WireGuard | Tailscale ($8–18/user/mo), Cloudflare Tunnel (free tier) | **Buy CF Tunnel (public) + Tailscale/Headscale (private), swappable** |
| Telegram | grammY + self-hosted local Bot API server | Hosted cloud Bot API (free) | **Buy cloud API for messaging; self-host server only for big media** |
| WhatsApp | whatsmeow/Baileys sidecar or Evolution API | Official Cloud API via BSP (360dialog ~$49/mo/number + ~$0.005/msg markup; effective 2–5× Meta rates) | **Build unofficial lane (user's number) + buy official lane (opt-in)** |
| Scheduler | BullMQ (Redis) / pg-boss (Postgres) | Trigger.dev / Inngest / Temporal | **Build (BullMQ or pg-boss)** |
| Models | — | Pay-as-you-go APIs (BYO-key) | **Buy via abstraction router** |
| Push | — | Expo Push (FCM/APNs, free) | **Buy Expo; offer ntfy as no-Google self-host escape hatch** |

**Recurring fixed costs (non-optional):** Apple Developer Program **$99/yr** + mandatory notarization (both frameworks' auto-update breaks on macOS without it); Windows OV code-signing cert **~$200–300/yr** (EV no longer needed since MS dropped EV OIDs Aug 2024). TURN relay (`coturn`) ~$149/mo+ *only if* you ship true WebRTC P2P.

---

## 4. Risks & Tradeoffs

| Risk | Severity | Mitigation |
|---|---|---|
| **Anthropic billing/ToS churn** — Jun 15 2026 split puts headless Agent-SDK usage on a separate **non-rollover** monthly credit (Pro $20/Max-20x $200, API-rate-billed); reselling claude.ai login/limits to end users **prohibited**. A per-project scheduler exhausts this fast. Policy already changed multiple times in 2026. | **HIGH** | **BYO-key design**; durable checkpointing; treat policy as unstable. |
| **WhatsApp ban waves** — unofficial libs: accounts last 2–8 wks, proactive outreach 15–30%/yr ban; 2026 "unanswered-message" tracker. Official lane bans general-purpose AI (Jan 2026, under regulatory challenge → uncertain scope). | **HIGH** | Two-lane abstraction; unofficial = user's own number, opt-in/reactive/low-volume, isolated process, loud ToS warning. Build for both ban-permanent and ban-lifted outcomes. |
| **Supply-chain (Node/MCP/skills)** — large fast-changing dep surface; demonstrated `lotusbail` Baileys trojan. | **MED-HIGH** | Pin/lock deps, vendor+audit, sandbox extension host, monitor linked-device list, vet marketplace skills. |
| **Prompt-injection "lethal trifecta"** — agent with WhatsApp/Telegram + web + tools can be induced to exfiltrate private chats. | **MED-HIGH** | Gate all outbound sends + destructive ops behind allowlists/confirmation; run untrusted inbound content through GPT review before action; sandbox scheduler jobs. |
| **Phone-controlled agent = RCE surface** — full filesystem/MCP/env access; compromised pairing/relay = remote code execution. | **HIGH** | E2EE, short-lived scoped credentials, explicit approval gates, timeboxed pairing QRs. |
| **Code-signing/notarization** recurring & blocking for auto-update. | **MED** | Budget cert procurement + notarization pipeline (identity validation can take days). |
| **Vendor/model churn** — model IDs/prices rev every few months; Sora 2 died. | **MED** | Provider-abstraction router; never hard-code IDs; studio must not depend on Sora. |
| **Tauri-if-later risks** — no official sleep plugin (single-maintainer crates; Win11 drops assertion immediately so blocker must be held continuously), cross-WebView fragmentation. | **MED** | If porting, vendor a thin Rust binding for sleep; budget cross-WebView QA. |
| **Long-job vs OS power events** — even with a held assertion, forced sleep (lid close, low-battery hibernate, admin policy) can interrupt jobs; a wake-lock is not a completion guarantee. | **MED** | Durable checkpointing/resume in the scheduler. |
| **P2P/relay/VPN as single point of failure** — TURN/relay/control-plane DDoS targets; Tailscale SaaS lock-in + per-user cost; iroh pre-1.0, js-libp2p WebTransport unsupported on Safari. | **MED** | Relay-first (avoids most TURN cost); keep P2P optional behind stable relay; design VPN layer swappable (Tailscale/Headscale/raw WireGuard). |
| **Push limits** — APNs 4KB payload cap (MessageTooBig), FCM Google coupling. | **LOW-MED** | Keep payloads thin; ntfy/UnifiedPush escape hatch. |
| **Stars/IAP economics** — Telegram Stars is the only in-bot currency for digital goods; Apple/Google take ~30% on Star purchases (~$0.013/Star to creators). | **LOW-MED** | Model 30% cut into marketplace pricing; route high-value purchases to web/Fragment. |

---

## 5. Must-Have Product Capabilities Implied

These fall out of the decisions above and should be first-class requirements:

- **Provider-abstraction router** for all models (Claude / GPT / image / video) — no hard-coded IDs; per-call model selection; prompt-caching + Batch API enforced on Claude.
- **BYO-key credential vault** — per-user API keys stored in the OS keychain (Keychain/DPAPI/libsecret), never plaintext; same for OAuth refresh tokens.
- **Reference-counted, job-scoped sleep-blocker** — `prevent-app-suspension` for headless runs (lets display sleep, saves battery), `prevent-display-sleep` only when the user is watching; release on completion/failure/cancel.
- **Durable scheduler with checkpoint/resume + idempotency keys** — survives OS power events; Quartz misfire policies; per-project isolation.
- **Pluggable comms gateway** — single abstraction over Telegram (default) and the WhatsApp two-lane (unofficial sidecar ↔ official Cloud API ↔ managed gateway), swappable without app changes; central rate-limiter/queue around all sends.
- **Sandboxed extension/skill host** — runtime-loaded, manifest-based (Claude Code convention), Git-repo distribution, no raw main-process access; outbound-send gating + content review for skills that touch comms.
- **Relay-brokered E2EE mobile control** — outbound-only WSS, QR + short-lived-token pairing, approval gates, diff review, push notifications, voice; scoped/expiring credentials.
- **Offline-first CRDT sync** — conflict-free desktop↔phone state behind a swappable (Yjs/Automerge/Loro) abstraction.
- **Two-layer network reachability** — private (Tailscale/Headscale/WireGuard) for admin, public (Cloudflare Tunnel) for the studio/web surface, swappable.
- **Native OAuth** — Authorization Code + **PKCE with loopback (`http://127.0.0.1:<random-port>`) as default**, custom-scheme deep link as secondary.
- **Signed auto-update + notarization pipeline** — `electron-updater`, macOS notarization, Windows OV signing as a release-gate.
- **Security guardrails against the lethal trifecta** — allowlists + explicit confirmation on outbound/destructive actions, untrusted-content review pass, per-job sandboxing, dependency pinning/auditing, linked-device monitoring.

---

**One-line program summary:** Build v1 on **Electron + Node service core + Claude Agent SDK (BYO-key)**, mobile via **forked Happy Coder relay + Expo**, comms **Telegram-first + WhatsApp two-lane**, scheduling on **BullMQ/pg-boss** — with hard IPC/provider/comms/network abstractions so the framework, model, channel, and transport choices all stay swappable as this fast-moving landscape (Anthropic billing, Meta's AI ban, model churn) shifts under us.


---

# Dynamic Skills Marketplace & MCP Capability Layer

I'll synthesize this research into a decision-useful PRD section. Let me analyze the structure and produce the brief.

# Dynamic Skills Marketplace & MCP Capability Layer

## 1. State of the Art & Key Players

### The standard has consolidated (mid-2026)

Two complementary layers now define how agents acquire capabilities, and both have settled into clear standards:

| Layer | What it packages | Standard | Status |
|---|---|---|---|
| **Agent Skills** (`SKILL.md`) | *Know-how* — instructions, references, scripts | Open-sourced Dec 18 2025, governed by the **Agentic AI Foundation** (146+ members by Feb 2026); spec at agentskills.io | Portable across Claude Code, OpenAI Codex CLI, Gemini CLI, GitHub Copilot, Cursor, Cline, Windsurf, OpenCode (20+ tools) |
| **MCP** (servers/tools) | *Capabilities* — live tool calls to external systems | Spec rev **2025-11-25** (prior 2025-06-18); adopted by Anthropic, OpenAI, Google, Microsoft, Docker, Cloudflare | De facto interop layer |

**Key architectural fact:** The `SKILL.md` *artifact* is portable and vendor-neutral, but the *distribution/runtime* (plugin marketplaces, `/v1/skills` API, code-exec container, beta headers) remains Anthropic-specific. Lock-in lives at the runtime layer, not the artifact layer.

### Skills format & loading model (concrete specs)

- **`SKILL.md`**: only `name` (≤64 chars, lowercase/numbers/hyphens, no `anthropic`/`claude`) and `description` (≤1024 chars, must state *what* AND *when*) are required frontmatter. Body ≤500 lines / ~5K tokens.
- **Progressive disclosure (3 tiers)**: Level 1 metadata (~100 tokens/skill) always loaded → Level 2 body (~5K tokens) loads on trigger → Level 3 bundled scripts/refs run via bash so *code never enters context, only stdout*. **Implication:** 100 pre-loaded skills = ~10K tokens/turn of recurring cost. Gate discovery behind search, don't pre-load metadata.

### Skills distribution rails (3 first-party options)

| Rail | Strength | Critical limitation |
|---|---|---|
| **Claude Code Plugins + Marketplaces** | Native; bundles skills+agents+hooks+MCP+LSP+channels; project-scope shares via git; commit-SHA pinning; `channels` field maps to Telegram/Slack/Discord | Discovery is **install-time, not live-search**; plugins copied to cache (no external refs); MCP-bearing reloads invalidate prompt cache (need `--force`) |
| **Skills API** (`/v1/skills`, beta `skills-2025-10-02`) | Cleanest on-demand fetch; `GET .../versions/{version}/content` returns a **zip**; workspace-wide | **Container has ZERO network access** (kills any skill calling Telegram/render/model APIs); not ZDR-eligible; Anthropic lock-in |
| **MCP skill-broker** (skills-mcp, mcp-skillset, FastMCP Skills Provider; standards track **SEP-2640**) | **True dynamic discovery** (search live catalog → pick → fetch); flat token cost; engine-agnostic; SHA256 manifests | Agent SDK has **no mid-session register API** — must write-to-disk + reload; SEP-2640 still experimental |

**The dynamic-discovery gap:** The Agent SDK discovers skills from the filesystem *only at session start*. There is no programmatic runtime skill-register API. The emerging fix is serving skills as **MCP Resources** (SEP-2640: connect once, server-side updates, RBAC, versioning), with working prior art in **skills-mcp** (vector search, `bge-small-en-v1.5`), **mcp-skillset** (hybrid vector+knowledge-graph RAG, on-demand load), and **FastMCP Skills Provider** (`skill://name/SKILL.md` + SHA256 manifest, `sync_skills` to disk).

### MCP: the 2026 inflection points

- **Transports**: `stdio` (local subprocess) and **Streamable HTTP** (the remote default; legacy HTTP+SSE deprecated).
- **Context bloat is THE scaling problem**: 4 servers ≈ 51K tokens (47% of a 200K window); 7+ servers exceed 67K *before any user input*; Perplexity publicly dropped MCP internally over ~72% context waste.
- **The fix — Anthropic Tool Search Tool (GA Feb 2026)**: mark tools `defer_loading:true`; only a search interface + critical tools load up front. **~85% startup-token reduction** (75K → ~8K); Opus 4.5 tool-selection accuracy 79.5% → 88.1%. Requires `advanced-tool-use-2025-11-20` (+ `mcp-client-2025-11-20` for MCP toolsets). Still beta; can mis-select on complex workflows.
- **Dynamic discovery is native**: `notifications/tools/list_changed` lets a server expose different tools by scope without reconnect (client support varies — Gemini CLI lagged).
- **Durable tasks (SEP-1686)**: polling + deferred results — directly relevant to long video renders and the per-project scheduler.

### Discovery & registries

| Registry | Scale | Notes |
|---|---|---|
| **Official MCP Registry** (registry.modelcontextprotocol.io) | Canonical | Reverse-DNS namespaces tied to verified GitHub/domain ownership (anti-spoofing); backed by Anthropic/GitHub/Microsoft/PulseMCP; self-hostable |
| Glama / PulseMCP / Smithery / mcp.so | ~21K / ~12K / ~7K / ~5K | PulseMCP hand-reviewed daily; Smithery has Registry API + hosted servers; quality varies |
| Docker MCP Catalog | 300+ | **Signed/attested** container images |
| **Skill** catalogs: tonsofskills (2,810 skills, `ccpi` CLI), skills.sh (~2K), claudeskills.info (658), Agensi (~200 curated/scanned), SkillsMP (**800K** GitHub-scraped, min 2 stars) | — | Mostly download-then-load, uneven quality; **Agensi** is closest to our target model (curated + scanned + 80/20 creator split + live-MCP) |

### Security reality (the dominant risk)

- Scans of 8,000+ public MCP servers: **41% zero auth**, **43% unsafe command-exec paths**, **37% SSRF-vulnerable**. Censys found 12,520 internet-exposed MCP services, most unauthenticated.
- Named attack classes: **tool poisoning** (malicious instructions in tool descriptions), **rug-pull** (description mutates after install — defeats one-time review), token-passthrough abuse; 9 CVEs from broken OAuth.
- Anthropic explicitly treats every skill/plugin as **arbitrary code execution with user privileges**. OWASP now publishes an MCP Security Cheat Sheet.
- **Gateways are the standard mitigation**: Docker MCP Gateway (container isolation + `--verify-signatures`), MintMCP (RBAC + "Virtual/Agent Bundles" = per-job scoped revocable tokens), IBM ContextForge (OSS), Lunar MCPX.

---

## 2. Recommendation for Our Universal AI-Agent Platform

### Adopt the Hybrid architecture (Option D) + Gateway-first

Combine an **MCP skill-broker** for live discovery, native **Agent SDK filesystem loading** for execution, and a **mandatory GPT/Codex review gate** for safety:

```
User/Job
  → MCP Skill-Broker (search_skills via vector search over name+description)
  → download_skill → writes SKILL.md bundle into per-project .claude/skills/
  → Agent SDK (Claude Code, claude-opus-4-8) loads at session/reload
  → ALL third-party MCP tools routed through a Gateway (scoping/RBAC/audit/sigs)
```

**Rationale:**
- **Skill-broker (modeled on FastMCP Provider + SEP-2640)** gives true search-driven discovery while keeping per-turn Level-1 token cost *flat* past ~50 skills (vector search beats pre-loading all metadata).
- **Filesystem materialization** is the only way the Agent SDK actually loads a skill — engineer the write-to-disk + reload loop now; be drop-in compatible when SEP-2640 ratifies.
- **Gateway-first** is non-negotiable: never let Claude Code or the GPT reviewer talk to third-party servers directly. The gateway is the single enforcement point for per-project/per-job scoping, allow/deny lists, audit, and signature verification — and it's model-agnostic, so engine and reviewer share one policy.

### Per-project / per-job scoping

- **Per project**: committable manifest (like `.mcp.json` / `extraKnownMarketplaces`) listing allowed servers/tools, with **env-var secret indirection** (never hardcode). Project scope auto-offers the curated skill set to every collaborator.
- **Per job**: short-lived **"Agent Bundle"** identity (M2M auth, independently revocable scoped tokens) so a rogue tool can't escalate beyond that job. Use durable tasks (SEP-1686) for long renders; `list_changed` to re-scope on project switch.

### Mandatory security gate (continuous, not one-time)

1. Run **every** third-party/user-submitted skill and MCP server through a GPT-based review + static scan **before** listing: flag external URL fetches, unexpected network calls, tool use mismatched to stated purpose.
2. **Pin content hashes** (FastMCP `_manifest` SHA256) and **commit SHAs**; **re-scan on every update** to catch rug-pulls.
3. Prefer **reverse-DNS-verified** namespaces from the Official Registry; layer Glama/PulseMCP/Smithery as enrichment only.
4. **Human-in-the-loop approval** for destructive/irreversible tool calls.

### Comms surface (hard constraint)

**Lead with Telegram Bot API** (official, free, sanctioned). Treat **WhatsApp as business-workflow-only via Meta Cloud API + a registered BSP** (EUR 0.03–0.15/conversation). **Do NOT** build the consumer assistant on unofficial QR-pairing libs (Baileys/Evolution/WA-Automate/OpenClaw) — they violate Meta's **Jan 15 2026 ban on third-party general-purpose AI chatbots** and carry **2–8 week account-ban waves** (recurring every 2–3 months). Model both uniformly via the plugin `channels` field, but isolate per-job with revocable creds.

> ⚠️ Note: the environment exposes an `mcp__whatsapp__*` toolset built on QR/pairing-code instance flows (`wa_get_qr_code`, `wa_get_pairing_code`, `wa_create_instance`). This is exactly the unofficial path the research flags as critical-risk. It also exposes `wa_set_cloud_credentials` (the sanctioned Cloud API path). **Restrict production consumer flows to the Cloud-API path; gate the unofficial instance tools behind explicit business-workflow scoping or disable them.**

---

## 3. Build vs. Buy & Stack/Vendor Choices

| Component | Decision | Choice & rationale |
|---|---|---|
| **Skill artifacts** | **Build (author) on open standard** | Portable `SKILL.md`; usable by Claude Code (engine) AND GPT/Codex (reviewer); zero artifact lock-in |
| **Skill-broker MCP server** | **Build** (on OSS base) | FastMCP Skills Provider as the building block (manifest + SHA256 + `sync_skills`-to-disk); add vector search (`skills-mcp`/`mcp-skillset` patterns). Track SEP-2640 |
| **Engine** | **Buy (API)** | **`claude-opus-4-8`** primary ($5/$25 per 1M, 1M ctx) |
| **Reviewer** | **Buy (API)** | GPT/Codex via OpenAI Agents SDK / Responses API — consumes the *same* MCP servers (one server, two consumers) |
| **Gateway (untrusted local tools)** | **Buy/OSS** | **Docker MCP Gateway** — container isolation + `--verify-signatures` against signed SBOMs |
| **Gateway (remote RBAC)** | **Build-or-Buy** | OSS **IBM ContextForge** (avoid lock-in) vs. commercial **MintMCP** (turnkey Agent Bundles, SSO/SCIM). Start OSS, escalate to MintMCP if RBAC complexity demands |
| **Remote/marketplace hosting** | **Buy (cheap)** | **Cloudflare Workers + Agents SDK** — Streamable HTTP, built-in OAuth 2.1, Durable Objects, hibernation billing (pay only while active). Free tier 100K req/day; paid $5/mo min. Ideal for bursty per-job usage |
| **Upstream catalog** | **Buy/sync** | Official **MCP Registry** as source of truth; enrich with PulseMCP (reviewed) / Smithery (hosted) |
| **Telegram** | **Buy (free)** | Official Bot API |
| **WhatsApp** | **Buy (regulated)** | Meta Cloud API via registered BSP only |

**Transport standard:** Streamable HTTP for all hosted/remote/marketplace/P2P servers; `stdio` only for sandboxed tools bundled into the desktop/mobile host.

### Cost levers to instrument in the per-project scheduler

- Code-exec containers: **$0.05/container-hour** (wall-clock); 50 free hrs/day/org.
- Managed Agents: **$0.08/session-hour**. Web search: **$10/1K searches**.
- Keep **network-dependent skills** (studio, comms, scheduler) on Claude Code / Agent SDK hosts (full network). Reserve the **no-network API code-exec container** only for self-contained document/data skills.

---

## 4. Risks & Tradeoffs

| Risk | Severity | Mitigation |
|---|---|---|
| **Arbitrary code execution** — skills/plugins/servers run with user privileges; we auto-install third-party code on users' behalf (largest attack surface: exfiltration, prompt injection, RCE) | Critical | Mandatory pre-ingest GPT review + static scan; hash + commit-SHA pinning; gateway sandboxing; human approval for destructive calls |
| **Tool poisoning / rug-pull** — defeats one-time review (descriptions mutate post-install) | Critical | **Continuous** re-verification: description hashing, re-scan on every update — not just install-time |
| **WhatsApp ban/ToS** — Meta Jan 15 2026 AI-chatbot ban targets our exact use case; unofficial libs brick users' primary phone numbers | Critical | Telegram-first; WhatsApp via Cloud API + BSP only; per-job revocable creds; restrict/disable the unofficial `wa_*` instance tools |
| **Dynamic-loading gap / standard immaturity** — no SDK mid-session register API; SEP-2640 + durable tasks experimental | High | Engineer write-to-disk + reload now; abstract behind the broker; wrap beta headers in a capability-negotiation layer |
| **Context-bloat economics** — 50–72% of window on schemas pre-query; Tool Search beta can mis-select | High | `defer_loading` default; ~5–15 critical tools per project; gateway-side deterministic tool filtering as fallback for automated jobs |
| **Runtime vendor lock-in** — Tool Search, MCP Connector, `/v1/skills`, beta headers are Anthropic-specific & churn | Medium | Keep tool defs in portable MCP servers behind the gateway; prefer OSS gateways; portable `SKILL.md` |
| **Registry quality / supply chain** — open catalogs largely unreviewed (SkillsMP 800K scraped); plugins copied to cache can't reference external files | Medium | Never expose unscanned; verified namespaces only; redesign cross-repo skills around the copy-to-cache constraint |
| **OAuth/credential handling** — 9 CVEs; token-passthrough abuse | Medium | Gateway enforces audience-bound, capability-scoped tokens; never pass user tokens through verbatim |
| **Hosted-dependency risk** — Smithery/vendor uptime, rate-limit, pricing exposure; per-job token + output bloat | Medium | Self-host first-party/curated servers on Cloudflare; budget container-hours + output bloat per job |

---

## 5. Must-Have Product Capabilities (Implied)

1. **MCP skill-broker** exposing `search_skills` (vector search over name+description) and `download_skill` (writes `SKILL.md` bundle into per-project `.claude/skills/`), with SHA256 integrity manifests. SEP-2640-shaped.
2. **Reload orchestration** — materialize-to-disk + session reload/restart UX to close the mid-session hot-load gap (the single hardest engineering problem here).
3. **Gateway layer** enforcing per-project/per-job tool allow/deny lists, RBAC, audit logging, and signature verification — sitting between BOTH engine and reviewer and ALL third-party servers.
4. **Continuous security pipeline** — GPT review + static scan on ingest *and on every update*; hash/commit-SHA pinning; rug-pull detection via description-hash drift.
5. **Per-job ephemeral identities** ("Agent Bundles") with M2M auth and independently revocable scoped tokens.
6. **`defer_loading` / Tool Search on by default** per project, with a deterministic gateway-side filtering fallback for scheduled/automated jobs.
7. **Cost instrumentation in the scheduler** — track container-hours ($0.05/hr), session-hours ($0.08/hr), searches ($10/1K), and Level-1 metadata token drift; route network-dependent skills to full-network hosts.
8. **Unified comms abstraction** via the plugin `channels` field — Telegram-first, WhatsApp Cloud-API-only, with the unofficial WhatsApp instance path gated/disabled in production.
9. **Capability-negotiation layer** wrapping spec revisions (Streamable HTTP / 2025-11-25) and beta headers (`mcp-client-2025-11-20`, `advanced-tool-use-2025-11-20`, `skills-2025-10-02`) so churn doesn't break the platform.
10. **Durable-task support (SEP-1686)** for long renders/batch studio jobs (polling + deferred results) and `list_changed`-driven re-scoping on project switch.

---

**Bottom line:** Build a thin, portable skill-broker + a hard gateway boundary; buy the engine (Claude Opus 4.8), reviewer (GPT), local sandboxing (Docker), and hosting (Cloudflare). Treat every skill and server as hostile code subject to continuous re-scanning. Lead comms with Telegram and confine WhatsApp to the sanctioned Cloud API. The two genuinely hard, build-it-yourself problems are (a) the mid-session reload UX and (b) the continuous rug-pull-resistant security pipeline — everything else has a credible buy/OSS option today.


---

# Creative Media Studio (Image, Video, Avatar, Publishing, Trends)

I'll synthesize this research into a decision-useful PRD section. This is a synthesis task—I have all the research JSON I need, so I'll write the section directly.

# Creative Media Studio (Image, Video, Avatar, Publishing, Trends)

## 0. TL;DR for the Founder

Build the Creative Media Studio as a **provider-agnostic abstraction layer over aggregators**, not a set of direct vendor integrations. The market moved 4+ times in 6 months (Kling 3.0, FLUX.2, Nano Banana 2/Pro, Seedream 4.5, Sora 2's death sentence) — hard-wiring any vendor guarantees dead code. Route everything through **fal.ai (primary) + Replicate (secondary)** for generation, **ElevenLabs + Cartesia** for voice/music, **HeyGen/Argil + D-ID/Tavus** for avatars, **Remotion** as the deterministic assembler, and **upload-post / self-hosted Postiz** for publishing. Keep an **open-weight self-host lane (Wan, LTX-2, FLUX.1-dev, ComfyUI)** as the no-ToS-ban escape hatch and free tier. The three load-bearing must-haves: **async job orchestration with webhooks**, **per-project cost metering/budgets**, and **a unified consent + moderation + provenance layer**.

---

## 1. State of the Art — Players & Options

### 1.1 Image Generation (4 tiers, ~$0.005–0.24/image)

| Tier | Model(s) | Best at | Price | Notes |
|---|---|---|---|---|
| Flagship multimodal | **Google Nano Banana** (Gemini 3 Pro Image, 3.1 Flash Image / "Nano Banana 2", 2.5 Flash) | Conversational/chat-driven editing, character consistency (6 obj+5 char Pro; 10 obj+4 char 3.1 Flash) | Pro ~$0.134 (1–2K) / $0.24 (4K); 3.1 Flash $0.045–0.151; 2.5 Flash $0.039 ($0.0195 batch) | SynthID watermark on all outputs; cuts refinement iterations ~60–70% |
| Flagship multimodal | **OpenAI GPT Image 2 / 1.5 / 1 / 1 Mini** | Prompt adherence, high-input-fidelity faces/logos | Mini ~$0.005–0.011; GPT Image 2 $0.006–0.211 | C2PA provenance; **GPT Image 1 deprecates Oct 23 2026**; token-billed |
| Open + first-party API | **FLUX.2 [pro]/[flex]/[dev]/[klein]** (Black Forest Labs) + **FLUX.1 Kontext [pro]/[max]** | Creative quality (~1265 Elo), up to 10 ref images, unified edit/inpaint, typography | BFL API 1cr=$0.01; fal $0.03/MP pro, $0.06/MP flex; Kontext $0.04/MP | **Only frontier model that is BOTH open-weight AND clean first-party API**; dev=32B open weights, klein=Apache-2.0 |
| Specialists | **Ideogram 3** (in-image text, 90–95% acc), **Recraft V3** (only true SVG/vector + brand styles), **ByteDance Seedream 4.5** (cinematic, cheap, character-consistent) | Text-in-image / logos+vectors / cheap consistency | Ideogram ~$0.06 (Turbo $0.03); Recraft $0.04 raster/$0.08 vector; Seedream ~$0.03–0.035 | Seedream is Chinese-origin (compliance flag) |
| Self-host/OSS | **ComfyUI + FLUX.1-dev / SDXL / SD3.5** on RunPod | Cost control, privacy, custom LoRAs | GPU-second only (H100 $1.89/h, A100 $0.99/h) | ~114k GitHub stars; VRAM: SDXL 8GB+, FLUX.1-dev fp8 12GB+ |
| **EXCLUDE** | **Midjourney v7/v8** | Best raw aesthetics | Sub-only $10–120/mo | **No public API**; third-party wrappers (PiAPI/ImagineAPI/APIFRAME) violate ToS → ban risk. Manual/external only. |

### 1.2 Video Generation (8s–20s clips, ~$0.02–0.70/sec)

| Tier | Models | Specifics | Notes |
|---|---|---|---|
| Frontier closed | **Veo 3.1** (Lite/Fast/Quality), **Kling 3.0**, **Runway Gen-4.5**, ~~Sora 2~~ | Native synced audio + i2v now table stakes | See deprecation warning below |
| Quality leader | **Kling 3.0** (Kuaishou, Feb 5 2026) | **#1 ELO (1243)**, up to 15s, 4K image gen, multi-shot consistent characters, multi-char lip-synced dialogue | Best access via fal; **Chinese-owned** (data-residency flag) |
| Most production-credible | **Google Veo 3.1** | 8s native, 720p/1080p/4K, native audio + i2v on all 3.1 tiers; clean first-party API + enterprise SLA | Lite ~$0.03–0.05/s, Fast ~$0.10–0.15/s, Quality ~$0.20–0.40/s, 4K+audio ~$0.60/s |
| Budget / high-volume | **Seedance 2.0** (ByteDance), **Hailuo 2.3** (MiniMax) | Drafts/previews/iteration | Seedance Fast $0.022/s → Pro $0.247/s (1080p Pro volatile, some cite ~$0.68/s); Hailuo 768p ~$0.045/s. Both Chinese-owned |
| Open-weight | **Wan 2.5/2.6** (Apache 2.0), **LTX-2** (Lightricks) | Self-host escape hatch | Wan = clean commercial rights, no royalties; **Wan 3.0 (~60B, 4K, 30s) expected mid-2026**. LTX-2 = first prod-ready OPEN model w/ native synced 4K audio+video, 20s@50fps; **free under $10M ARR** |
| Specialty editing | **Runway** Gen-4.5 / Aleph (video-to-video) / Act-Two (performance capture) | Editing & consistent-character workflows | Credits $0.01 each; gen4.5 $0.12/s, aleph2 $0.28/s. Not the volume cost-leader |
| Mid-tier | **Luma Ray3/Ray3.14** | Reasoning-driven, fast | Ray-2 ~$0.08/s; **separate API wallet from Dream Machine app** |

> **⚠️ HARD DEPRECATION — DO NOT BUILD ON SORA 2.** OpenAI sunsets `sora-2`, `sora-2-pro` and `POST /v1/videos` on **September 24, 2026** (consumer app already killed April 26, 2026). Reverse-engineered third-party Sora APIs were largely killed by OpenAI's Jan 2026 Cloudflare hardening (403s) + account bans. At most offer Sora behind a feature flag with auto-fallback to Veo/Kling, and plan code removal.

### 1.3 Avatar & Motion (batch-render vs. real-time streaming)

| Layer | Vendor | Specifics |
|---|---|---|
| Turnkey avatar (batch) | **HeyGen API v3** | Most complete: Avatar IV/V digital-twin, Photo Avatar, 40+ lang dubbing, Lipsync. PAYG ~$1/min std, Avatar IV $4/min. **Migration: streaming-avatar SDK sunset 2026-03-31 → LiveAvatar (WebRTC/LiveKit); v1/v2 REST end 2026-10-31.** Business/Enterprise tier only |
| Cheap short-form assembler | **Argil API** | Avatar+voice+b-roll in one call; clone from 2-min selfie; BYO ElevenLabs voice to cut cost. Classic $39/mo, Pro $149/mo |
| Enterprise polish | **Synthesia** | 240+ avatars, 160+ langs; Creator ~$64/mo |
| UGC/ad at scale | **Mirage** (formerly Captions, $500M val) | Audio→full avatar video; bulk UGC ads API. Business $399/mo/8k credits |
| Real-time conversational | **D-ID V4** (sub-0.5s turns, 4K, 120+ langs, ~$5.90/min), **Tavus CVI** (BYO-LLM/TTS, SOC2/HIPAA, Starter $59/mo), **Anam** (~180ms latency, SOC2 Type II+HIPAA, US+EU, zero-retention) | Target: audio round-trip <300ms, mouth response <1s |
| Lip-sync (managed) | **Sync.so** (lipsync-2/-pro) | Frame-accurate, ~$0.02–0.025/sec; also on fal/Replicate |
| Lip-sync (OSS self-host) | **MuseTalk** (real-time 30fps+), **LatentSync 1.6** (best visuals), **Wav2Lip** (most accurate) | Removes per-min fees + ToS exposure; needs GPU ops |

### 1.4 Voice, Music & Captions (now commodity-tier)

| Capability | Recommended | Specifics |
|---|---|---|
| TTS (default) | **ElevenLabs Flash v2.5** (~75ms, $0.05/1k chars), Multilingual v2 / v3 ($0.10/1k) | Turbo v2.5 deprecated → Flash |
| TTS (lowest latency/cheapest) | **Cartesia Sonic-3** (90ms) / Sonic Turbo (~40ms), **$0.03/min**, instant clone from 10s | Best for real-time turn-taking |
| TTS (GPT-side) + speech-to-speech | **OpenAI gpt-4o-mini-tts** (~$0.015/min, steerable), **gpt-realtime/GPT-Realtime-2** (~$0.30/min all-in) | WebRTC for the interactive assistant brain |
| **Music** | **🟢 ElevenLabs Music v2** | **The ONLY AI music with explicit commercial clearance** (licensed stems; cleared on all paid plans, film/TV=Enterprise). Has a real API. Model IDs `music_v1`, v2 adds section-by-section + mid-track transitions |
| **Music (AVOID as dependency)** | ~~Suno / Udio~~ | **No official public API**; active UMG/Sony litigation (Sony vs Udio open; UMG+Sony vs Suno stalled, no trial date; AFM union now suing over settlements). Commercial rights only while subscribed, not retroactive. Treat as **user-pasted assets only** |
| Captions (word-level timestamps) | **ElevenLabs Scribe v2** (90+ langs, scribe_v2_realtime ~150ms), **Deepgram Nova-3** (5.26% WER), **AssemblyAI** | Raw Whisper does NOT return word-level timestamps |
| Assembler / motion graphics | **Remotion** (React video) + Lambda | Deterministic kinetic typography, karaoke captions, b-roll compositing. Lambda ~$0.02/min. **License: free ≤3 employees; Company License ~$25/dev/mo, min $100/mo or $1000/yr above that** — budget from day one + `@remotion/licensing` per-render webhook |

### 1.5 Publishing & Trends (heavy per-platform gates)

| Platform | Gate | Limits |
|---|---|---|
| **YouTube Shorts** | `videos.insert`, no audit to start | 1600 quota units/upload; default 10k/day = **~6 uploads/day** until free (slow) audit passes |
| **TikTok** | **Mandatory audit (2–6 wks); unaudited = SELF_ONLY private** | ~6 req/min/token, **~15–25 posts/creator/24h shared across ALL clients**; tokens expire 24h |
| **Instagram/Facebook/Threads** | One Meta App Review + Business Verification covers all three | IG 100/24h, Threads 250/24h, FB Reels 4,800×engaged-users/24h |
| **X (Twitter)** | **Free tier killed Feb 6 2026; pay-per-use** | ~$0.01–0.015/post, **~$0.20/post-with-URL** (link trap), ~$0.005/read. No new Basic/Pro signups |
| **LinkedIn** | Community Management API → **Partner Program approval (weeks–months)** | Standard tier needs screencast demo |
| **Pinterest** | Free, v5 | Trial ~1,000 req/day; Standard upgrade needed for volume |
| **Aggregators** | **Ayrshare** ($149/mo 1 profile → $599 Business/30), **upload-post** (account-based: $24/5, $50/25), **Postiz** (AGPL-3.0 self-host + MCP), **Blotato** ($29+/mo, MCP, bundles AI video) | Absorb the audit/token/refresh burden |

**Trends intelligence is fragmenting:** TikTok **closed its open trends API** (Creative Center is browser-only, Research API academic-gated). Programmatic signals now come from scraper APIs (**Apify** — ToS/ban risk) or tools (**HookMafia** viral hooks+trending sounds, **Metricool** official trending-audio + best-time-to-post, **VidIQ**).

---

## 2. Recommendations for OUR Universal AI-Agent Platform

### 2.1 Core architectural principle — abstract everything

Define **one normalized internal interface per media type** so models are swappable by config string. This is exactly what the dynamic skills marketplace should wrap — each "model" becomes a skill that selects an endpoint.

- **`ImageJob`** (generate / edit-inpaint / multi-reference / upscale)
- **`VideoJob`** (prompt, init/reference image, duration, resolution, audio bool, model-id, webhook)
- **`AvatarJob`**, **`VoiceJob`**, **`PublishJob`** (PublishingProvider abstraction)

### 2.2 Recommended composable pipeline (avatar/video end-to-end)

```
[script: Claude Code primary, GPT review]
  → [voice: ElevenLabs Flash v2.5 default | Cartesia Sonic-3 low-latency | gpt-4o-mini-tts GPT-side]
  → [avatar clip: HeyGen quality | Argil cheap short-form | self-hosted MuseTalk at scale]
  → [captions: ElevenLabs Scribe v2 / Deepgram word timestamps]
  → [b-roll: fal.ai → Kling/Veo/Wan]
  → [music: ElevenLabs Music v2 (cleared)]
  → [final assembly + kinetic typography: Remotion on Lambda]
  → [publish: upload-post / Postiz aggregator → YouTube/Meta direct where ROI clear]
```

### 2.3 Default model-routing matrix (cost-optimized, hybrid tiered)

| Job | Draft / high-volume | Final / hero |
|---|---|---|
| **Image** | GPT Image 1 Mini ($0.005), Seedream 4.5 ($0.03) | FLUX.2 [pro] (hero+multi-ref), FLUX.1 Kontext (edits), Nano Banana Flash (chat editing), Ideogram 3 (text-in-image), Recraft V3 (SVG/logos) |
| **Video** | Seedance 2.0 Fast ($0.022/s), Hailuo 2.3 Fast, Wan | Veo 3.1 (with-audio; Fast for cost, Quality for hero), Kling 3.0 (cinematic/dialogue), Runway Aleph/Act-Two (editing/perf capture) |
| **Avatar** | Argil (BYO EL voice) | HeyGen Avatar IV/V; D-ID V4 / Anam / Tavus for real-time |

**Pattern:** generate many cheap previews → upscale/re-render the chosen one with frontier. Always surface a **live cost estimate before generation**.

### 2.4 Real-time interactive assistant face

Pair **OpenAI Realtime (gpt-realtime/GPT-Realtime-2, WebRTC)** or **Cartesia** for the voice loop with a streaming avatar (**D-ID V4 / Anam**). Target audio round-trip <300ms, mouth <1s. **Use WebRTC, not WebSockets, on mobile** for stable latency (aligns with the P2P/mobile-sovereignty requirement). Migrate any HeyGen streaming to LiveAvatar now.

### 2.5 Publishing rollout — sequence by friction

- **Phase 1 (low gate):** YouTube + Pinterest + Threads + Bluesky
- **Phase 2:** Instagram + Facebook Reels (one Meta review covers all three)
- **Phase 3 (slowest):** TikTok (audit) + LinkedIn (Partner Program) — or cover via aggregator from day one
- **Day-one actions:** apply for YouTube Audit & Quota Extension immediately (free, weeks–months); launch TikTok in **Draft/inbox mode** (human approves in-app, no public-audit dependency); put X links in **replies/bio not main post** to dodge the $0.20/URL charge.

---

## 3. Build vs. Buy & Stack/Vendor Choices

| Layer | Decision | Choice | Rationale |
|---|---|---|---|
| Image/video/avatar/lip-sync generation | **BUY (aggregate)** | **fal.ai primary, Replicate secondary** | One key, 600–985 endpoints, swap-by-string, uniform async/webhook, built-in CDN. Absorbs monthly churn. Failover avoids single-aggregator lock-in |
| Frontier first-party fallbacks | **BUY (direct)** | **Google Veo/Gemini** (already the agent key), **OpenAI GPT Image** (already the review model) | Enterprise SLA, clearest ToS, first access to new versions, no aggregator markup |
| Open-weight self-host lane | **BUILD/HOST** | **Wan 2.x (Apache-2.0), LTX-2, FLUX.1-dev, ComfyUI on RunPod** | Free tier, privacy/data-residency, no per-call ban risk, P2P/mobile-sovereignty story, no-vendor-can-revoke failover |
| Voice + Music + Captions | **BUY** | **ElevenLabs** (voice+Music v2+Scribe in one vendor), **Cartesia** (latency/cost), **OpenAI** (GPT-side) | Music v2 = only legally-clean AI music with an API |
| Final assembly / motion graphics | **BUY (license) + BUILD templates** | **Remotion** + Lambda | Only mature React/HTML deterministic engine; reproducible captions/lower-thirds/b-roll. Budget the Company License + per-render webhook into unit economics from day one |
| Publishing | **BUY/SELF-HOST hybrid** | **upload-post** (cheap account-based, fits small-creator base) or **self-hosted Postiz** (AGPL-3.0, ships MCP server → Claude Code drives it) as engine; **direct YouTube + Meta** where volume justifies | Avoids owning 8 platform audits at launch |
| Trends/virality | **BUILD on legal signals first** | Metricool (official trending-audio + best-time) + IG/YT insights + GPT for hooks/titles. Apify scraper **isolated, optional, risk-flagged only** | TikTok closed its open trends API; scraping carries ban risk |

**Self-host crossover points:** lip-sync (MuseTalk/LatentSync) becomes worthwhile **above ~tens of thousands of avatar-minutes/month**; open-weight image/video self-host pays off for free-tier, privacy, and high-volume drafting.

**⚠️ Postiz AGPL-3.0 caveat:** copyleft can trigger obligations if embedded/distributed in a commercial desktop/mobile product. **Get legal review** — prefer running it as a **network-served backend** to limit copyleft reach rather than bundling.

---

## 4. Risks & Tradeoffs

| Risk | Impact | Mitigation |
|---|---|---|
| **Vendor deprecation / fast churn** | Sora 2 dies Sept 24 2026; GPT Image 1 dies Oct 23 2026; HeyGen streaming SDK sunset Mar 31 2026; new models monthly. Hardcoded IDs rot fast | Config-driven routing, abstraction layer, version pinning + migration tests, changelog monitoring + quarterly re-verification |
| **Cost blow-ups** | 4K+audio video can hit ~$0.60–0.70/s → **a single minute = $35–45**; token-billed image up to $0.24; real-time avatars $3–6/min; X surprise bills | Per-project budgets + hard quotas, cheap-draft-then-upscale, batch/async (-50%), config-driven cost table, default to cheap tiers |
| **Content/legal liability** | Real-person likeness, copyrighted characters, deepfakes, AI music lawsuits. Guardrails differ wildly (Sora strict, open models permissive) | **Own moderation in OUR layer** uniformly before dispatch; consent capture + identity verification for avatars/voice cloning; default to ElevenLabs Music v2; store + expose C2PA/SynthID provenance |
| **ToS / ban risk** | Reverse-engineered APIs (Sora), Midjourney wrappers, TikTok scraping, unauthorized likeness cloning → account/key bans | Only official first-party or legitimate aggregators; human-in-the-loop + per-creator rate pacing; consent flow |
| **Vendor lock-in** | Bespoke avatar IDs (HeyGen/Tavus/D-ID), single aggregator | Normalized interface + fal/Replicate redundancy + always-available OSS self-host path |
| **Reliability / latency** | Renders take minutes; real-time pipelines 1–3s; queues back up; chunked uploads error-prone; TikTok 24h token expiry | Async-by-default + webhooks + polling fallback + retries; never block a chat turn; robust token refresh |
| **Commercial-rights ambiguity** | Per-model licenses vary; LTX-2 <$10M ARR threshold; "Commercial use" must be verified per model | Log model+version+license per generation; track ARR thresholds |
| **Geopolitical / data-residency** | Top-value models (Kling/Kuaishou, Seedance/ByteDance, Wan/Alibaba, Seedream/Hunyuan) are Chinese-owned; faces/prompts may transit Chinese infra | Region/ownership filter on the router; for enterprise/EU prefer Veo-on-Vertex, self-host, or Anam/Tavus EU regions |
| **Approval bottlenecks** | Meta review, TikTok audit, LinkedIn Partner, YouTube quota — each blocks a channel; not guaranteed | Aggregator fallback from day one; per-Google-project quota sharding; TikTok Draft-mode launch |
| **Remotion license non-compliance** | Legal violation if unpaid above 3 employees / no per-render webhook | Budget + implement from day one |

---

## 5. Must-Have Product Capabilities Implied

1. **Provider-agnostic abstraction layer** — normalized `ImageJob`/`VideoJob`/`AvatarJob`/`VoiceJob`/`PublishJob` interfaces; models/platforms swappable by config string; this is what the skills marketplace wraps.
2. **Async-by-default job orchestration** — submit + `webhook_url`, persist job IDs in the per-project scheduler, poll as fallback, surface progress in WhatsApp/Telegram + desktop/mobile. Never block a chat turn on a multi-minute render.
3. **Per-project cost metering, live estimates, and budget caps** — config-driven cost table refreshed regularly; auto-downgrade to cheaper models; "budget remaining" UI; rate/quota tracking per platform.
4. **Unified consent + moderation + provenance layer (OUR layer, not the vendor's)** — consent capture + identity verification before avatar/voice cloning; uniform no-real-people / no-copyrighted-character / no-impersonation policy pre-dispatch; store and expose C2PA/SynthID; AI-generated labeling; full audit log (model, version, cost, license per generation).
5. **Hybrid tiered routing engine** — cheap-draft-then-upscale; quality/cost re-ranking via GPT + a small eval set to auto-update defaults.
6. **Self-host / BYO-GPU lane behind the same interface** — Wan/LTX-2/FLUX.1-dev/ComfyUI for free tier, privacy, offline/P2P/mobile, and no-ToS-ban failover; UI flips cloud↔local without change.
7. **Geopolitical/data-residency filter on the router** — exclude Chinese-owned models and prefer EU/SOC2/HIPAA/zero-retention vendors when an enterprise/region flag is set.
8. **Per-platform rate-limit/quota tracker + human-in-the-loop publishing** — IG 100/24h, Threads 250/24h, TikTok ~15–25/creator/24h shared, YouTube 1600 units/upload, Pinterest Trial 1,000/day; Draft-mode and link-in-reply handling.
9. **Deterministic assembly layer (Remotion)** — animated/karaoke captions, branded templates, b-roll compositing, with licensing webhook wired in.
10. **Trend-intelligence module** — built on legal/official signals (Metricool, IG/YT insights) + LLM hook/title generation, with scraper sources isolated and risk-flagged.


---

# Completeness Critic — Gaps, Cross-cutting, PRD Outline, Phasing, Differentiators

I'll analyze these four research sections and produce the requested completeness critique. This is a pure synthesis/writing task — the research is fully provided, so I'll write the Markdown directly.

# PRD Completeness Critique & Strategic Outline
## Universal AI-Agent Desktop + Mobile Platform

---

## 1. GAPS & OPEN QUESTIONS

The four sections are strong on engine/comms/skills/media tooling but converge almost entirely on *the build side of one user (a solo creator/developer)*. The biggest gaps are everything that turns a tool into a product: identity, money, multi-user, lifecycle, and the human in the loop.

### 1.1 Business model, pricing & monetization (CRITICAL — barely addressed)
- **How do *we* make money?** Every section says "BYO-key" to dodge ToS — which is correct — but BYO-key means we capture **zero margin on usage**. There is no stated revenue model: subscription tiers? seat pricing? marketplace take-rate? render-markup? The Competitive section quotes everyone's pricing but never proposes ours.
- **Marketplace economics are hand-waved.** The Skills section flags "monetization/billing primitive (greenfield — no standard registry-billing exists)" as a must-have but provides no design: who sets prices, how creators get paid, what our cut is, how refunds/chargebacks/fraud work, tax/VAT, payout rails (Stripe Connect? Telegram Stars 30% cut?). This is a whole sub-product with no owner.
- **Free tier definition.** The Media section proposes a self-host OSS lane "for the free tier" but no section defines what free vs. paid actually gates.

### 1.2 Identity, accounts & multi-tenancy (MISSING)
- The Competitive section lists "SAML/OIDC SSO + SCIM, RBAC" as P0/P1 but **no section designs the account/org/tenant model.** What is the primary entity — user, org, workspace? How do projects/sub-projects (Claude / Claude-Design / Claude-Code) map to tenants and to billing?
- **The "project/sub-project model" from the prompt is never specified.** It's referenced in passing but there's no data model, no inheritance rules (do sub-projects inherit keys/budgets/skills/permissions?), no UX. This is a headline feature with zero definition.
- BYO-key + multi-device + P2P + team sharing have **unreconciled conflicts**: if keys live in the OS keychain (per Architecture §5), how does a teammate or a scheduled cloud job use them? How does a phone run a job that needs a desktop-resident key?

### 1.3 The "switchable effort" feature (UNDER-SPECIFIED vs. its prominence)
- It's a named headline feature. The Competitive section gives the right abstraction (FAST/BALANCED/DEEP/MAX → per-vendor params) and flags the "effort paradox" (high effort flat-or-worse at 4–17× cost). But there's **no UX spec, no per-job override flow, no default-selection policy, no eval-gating mechanism**. Who decides effort — user, scheduler, or an auto-tuner? How does it interact with the reviewer pass?

### 1.4 Reviewer-model value is unvalidated (RISK called out but unresolved)
- Both the Competitive and Skills sections admit Claude *leads* SWE-bench with lower hallucination, so a GPT reviewer's actual lift is **unproven** — yet the GPT-review-model is a headline feature. **There is no eval plan** to prove the cross-vendor reviewer earns its cost and latency. If it doesn't, the entire "GPT review" pillar is decorative.

### 1.5 Onboarding, first-run & non-technical UX (MISSING)
- The target user is ambiguous: the comms/media/avatar/publishing features scream *non-technical creator*, but worktrees/PRs/MCP/effort-sliders scream *senior engineer*. **These are two different products with two different onboardings.** No section resolves who the user is.
- BYO-key onboarding for a non-technical creator (get an Anthropic key, an OpenAI key, a fal.ai key, an ElevenLabs key, set up a Telegram bot…) is a **brutal first-run funnel** that no section addresses.

### 1.6 P2P / local-first is asserted but contradicted (UNRESOLVED)
- The prompt lists P2P as a pillar. Architecture §1.3 then concludes P2P **fails for 15–25% of clients** and recommends a *relay-brokered* model instead — i.e. **not actually P2P.** The Competitive section recommends Automerge+libp2p; Architecture recommends Yjs+relay and reserves Automerge for subsystems. **These two sections disagree on the sync stack and on whether P2P is even real.** Must be reconciled.

### 1.7 Data model & state ownership (FRAGMENTED)
- Each section names its own store (JSONL sessions, Yjs docs, BullMQ/Redis, Postgres, vault, audit log, CRDT) but **no section owns the unified data model.** What is the source of truth for a "project"? How do session state, scheduler state, budget ledger, audit log, and CRDT sync state relate? Conflict resolution across desktop/mobile/cloud is undefined.

### 1.8 Quantitative targets & scale (ABSENT)
- No NFR numbers: how many concurrent projects/agents/scheduled jobs per user? Latency budgets (only the avatar pipeline has <300ms targets)? Render queue depth? Relay throughput? Storage growth (CRDT bloat is flagged but unquantified)? Without these, "enterprise-grade" is unfalsifiable.

### 1.9 Compliance specifics beyond name-drops
- EU AI Act and SOC 2 are named, but **GDPR/CCPA data-subject rights, data retention/deletion, the "right to be forgotten" across CRDT history + audit logs + vendor sub-processors, and a sub-processor list** (every model vendor is one) are absent. Voice/avatar **biometric consent** (BIPA/Illinois) is implied by the Media section but not designed as a flow.

### 1.10 Testing, eval & quality strategy (MISSING)
- For an agent platform, **how do we test agents?** No eval harness, no regression strategy for non-deterministic outputs, no golden-task suite, no way to validate that a skill/model swap didn't regress. The "panel-of-judges for auto-merge" is mentioned but not designed.

### 1.11 Mobile scope ambiguity
- Is the mobile app a **full agent client** (runs agents on-device) or a **remote control** (drives the desktop)? Architecture strongly implies remote-control (relay to desktop daemon), but the prompt says "mobile app + self-hosted server." On-device model execution on a phone is infeasible for Opus-class work — **so mobile is a thin client, which should be stated explicitly** and changes everything about offline mode.

---

## 2. CROSS-CUTTING CONCERNS

These span all sections and need a single owner each in the PRD.

### 2.1 Security (HIGHEST cross-cutting risk)
Three compounding attack surfaces stack into a true "lethal trifecta":
- **Shell-capable agents** (RCE with user privileges) + **third-party skills/MCP servers** (41% no auth, rug-pulls, the `lotusbail` Baileys trojan precedent) + **untrusted inbound comms** (WhatsApp/Telegram messages as injection vectors) + **phone-controlled remote execution** (compromised pairing = remote RCE).
- **Single enforcement model required:** sandboxed per-project dirs, deny-by-default Bash/network rules, PreToolUse hook gating, a *mandatory MCP gateway* between both engine and reviewer and all third-party servers, signed/scanned/continuously-re-scanned marketplace artifacts, and HITL gates on every destructive/irreversible/outbound action. Today these guards are scattered across three sections — the PRD needs **one security architecture chapter** that unifies them.

### 2.2 Secrets & key management
- BYO-keys (Anthropic, OpenAI, fal, ElevenLabs, Telegram, WhatsApp BSP, publishing OAuth tokens × 8 platforms) must be stored **agent-invisibly** (Infisical Agent Vault / Vault dynamic secrets / OS keychain) and survive prompt injection.
- **Unresolved:** key availability across devices and to cloud/scheduled jobs vs. agent-invisibility. OAuth refresh-token lifecycle (TikTok 24h expiry, etc.) needs a rotation service.

### 2.3 Cost governance (the named trust differentiator)
- **Unified budget ledger** across LLM tokens, effort multipliers, container-hours ($0.05), session-hours ($0.08), web-search ($10/1K), image ($0.005–0.24), video (a single 4K+audio minute = **$35–45**), avatar minutes, Remotion render licensing, and per-platform publishing costs (X's $0.20/URL trap).
- Must enforce: hard per-project caps (429 on exceed), pre-run estimates, live meters, auto-downgrade, Batch API (−50%) + prompt caching (~90%) on all scheduled/background runs, and loop guards (`max_iterations`, `max_budget_per_session`). This is **one metering service**, currently described piecemeal in all four sections.

### 2.4 Observability
- OTel GenAI conventions + self-hosted Langfuse, with per-job thinking/reasoning-token telemetry feeding the effort auto-tuner. Needs: distributed tracing across desktop→relay→mobile→cloud renders, the budget ledger as a first-class signal, and immutable audit logs that double as the EU AI Act compliance record.

### 2.5 Offline / failure modes
- **OpenHands self-host** = Anthropic-outage/air-gapped fallback; **OSS media lane** (Wan/LTX-2/ComfyUI) = vendor-outage/ban fallback; **durable scheduler** (checkpoint/resume, Quartz misfire, idempotency keys) = OS-power-event survival; **relay-first** = NAT/CGNAT survival; **async-by-default + webhooks + polling fallback** = render reliability. The PRD needs a **single failure-mode matrix** mapping each dependency to its degradation path, since every section invented its own.

### 2.6 Licensing / ToS (existential, recurring)
- **Never resell consumer subscriptions** (Anthropic banned OpenClaw/OpenCode/Roo/Goose; OpenAI bans Pro abuse) → BYO-key, first-party API only.
- **WhatsApp:** official Cloud API only for anything proactive/enterprise; Meta's Jan 2026 general-purpose-AI ban makes even the official lane legally hostile; unofficial libs = 15–30%/yr ban + supply-chain risk. **Telegram-first** is the unifying answer.
- **Media licensing landmines:** no Midjourney/Suno/Udio API (ToS + active litigation), Sora 2 dead Sept 2026, **Remotion Company License** (must be wired from day one), AGPL-3.0 Postiz copyleft (run network-served, get legal review), per-model commercial-rights + ARR thresholds (LTX-2 <$10M), Chinese-ownership data-residency on Kling/Seedance/Wan/Seedream.
- **The PRD needs a living "Vendor/ToS Register"** — every model ID, price, and ToS term is point-in-time config to re-verify at build, not a constant.

### 2.7 Data model (the missing spine)
- One canonical schema for: **Org → Project → Sub-project → Session/Job**, with budgets, keys, skills, permissions, audit, and CRDT-sync state attached at the right level and with explicit inheritance. Plus retention/deletion semantics that reach into CRDT history and vendor sub-processors. **No section owns this; it must be a dedicated chapter.**

---

## 3. RECOMMENDED PRD OUTLINE

An enterprise-grade outline for the full product PRD. Each line is one section + a one-line description.

1. **Executive Summary & Vision** — The cross-surface orchestration moat (scheduler + mobile + comms + studio) around a compliant first-party-API engine; one-paragraph "why now / why us."
2. **Problem Statement & Target Users** — Resolve the creator-vs-engineer split; define primary/secondary personas and the jobs-to-be-done each.
3. **Goals, Non-Goals & Success Metrics** — Measurable outcomes (activation, retention, cost-per-task, render success rate) and explicit out-of-scope (e.g., on-device Opus, reselling subscriptions).
4. **Business Model & Pricing** — Revenue model (subscription tiers + marketplace take-rate + studio markup over BYO-key), free-tier definition, unit economics.
5. **Product Principles & Constraints** — BYO-key, provider-agnostic, abstract-everything-swappable, security-by-default, transparent budgets, ToS-safe-by-default.
6. **System Architecture Overview** — Electron + UI-agnostic Node service core + typed IPC boundary; the four swappable abstraction layers (model / comms / sync / platform).
7. **Identity, Accounts, Org & Tenancy Model** — User/Org/Project/Sub-project hierarchy, SSO/SCIM/RBAC, inheritance rules for keys/budgets/skills/permissions.
8. **Canonical Data Model & State Management** — Source-of-truth schema, session/scheduler/ledger/audit/CRDT relationships, retention/deletion, conflict resolution.
9. **Agent Engine & Model Layer** — Claude Agent SDK harness, builder/driver/subagent tiers, GPT reviewer (with eval-validation plan), LLM gateway (LiteLLM), provider-abstraction router.
10. **Switchable Effort & Autonomy Controls** — FAST/BALANCED/DEEP/MAX abstraction, per-job override UX, mode-aware defaults, layered autonomy (plan-mode → unattended), HITL gates.
11. **Core Agent Loop (Parity Layer)** — Worktree-per-agent isolation, plan-mode gate, review/merge-to-PR; explicitly framed as table-stakes parity, not differentiation.
12. **Per-Project Scheduler & Durable Execution** — BullMQ/pg-boss, cron, checkpoint/resume, misfire policies, idempotency, background agents pushing to mobile.
13. **Dynamic Skills Marketplace & MCP Capability Layer** — Skill-broker (search/download/reload), MCP gateway, per-job ephemeral identities, continuous security pipeline, marketplace economics & payouts.
14. **Comms Gateway** — Telegram-first (grammY), WhatsApp two-lane (official Cloud API + gated unofficial), unified channel abstraction, rate-limiter, inbound-as-untrusted handling.
15. **Mobile App & Remote-Control Plane** — RN/Expo thin client, relay-brokered E2EE WebSocket, QR pairing, approval/diff UX, push; explicit thin-client (not on-device-agent) scope.
16. **Sync & Offline / Local-First** — CRDT stack decision (reconcile Yjs vs Automerge), relay-first vs true-P2P scope, NAT/TURN strategy, offline degradation.
17. **Creative Media Studio** — Normalized Image/Video/Avatar/Voice job interfaces, fal/Replicate aggregation + first-party + OSS self-host lanes, hybrid tiered routing, async/webhook orchestration.
18. **Auto-Publishing & Trends** — PublishProvider abstraction, per-platform gates/quotas/audits, aggregator + direct hybrid, HITL/draft-mode publishing, legal trend-signal sourcing.
19. **Consent, Moderation & Provenance** — Our-layer uniform policy, biometric consent for avatars/voice, C2PA/SynthID, AI-labeling, per-generation audit.
20. **Security Architecture** — Sandboxing, deny-by-default, hook gating, MCP gateway, secrets/agent-vault, prompt-injection/lethal-trifecta defenses, supply-chain controls.
21. **Cost Governance & Metering** — Unified budget ledger, caps/estimates/live meters, auto-downgrade, batch+caching enforcement, loop guards.
22. **Observability & Audit** — OTel GenAI, Langfuse, distributed tracing, immutable exportable audit logs as compliance record.
23. **Compliance, Legal & Vendor/ToS Register** — EU AI Act, SOC 2→ISO, GDPR/CCPA, biometric law, living vendor/model/price/ToS register, sub-processor list.
24. **Reliability & Failure-Mode Matrix** — Per-dependency degradation paths, fallback engines (OpenHands, OSS media), durable resume.
25. **Quality, Eval & Testing Strategy** — Agent eval harness, golden-task suites, panel-of-judges for auto-merge, model/skill-swap regression gating.
26. **Onboarding & First-Run** — BYO-key funnel, persona-specific paths, pairing/setup flows.
27. **Non-Functional Requirements** — Concurrency, latency budgets, throughput, storage growth, availability targets.
28. **Phasing & Roadmap** — MVP/v1/v2 split (see §4).
29. **Open Questions & Risk Register** — Consolidated unresolved decisions with owners and resolution deadlines.

---

## 4. PROPOSED PHASING

Rationale principle: **ship the compliant core loop + the single sharpest differentiator first; defer everything with a ToS, licensing, or marketplace-economics tail.** Prove the moat (cross-surface orchestration) before broadening the surface.

### MVP — "Compliant agent IDE with a scheduler and a phone leash"
*Goal: prove the orchestration moat on the build side with one persona (technical creator/developer).*
- Electron + Node service core + typed IPC boundary (so a future Tauri/mobile re-shell is cheap).
- Claude Agent SDK engine (Opus builder / Sonnet driver / Haiku subagents), **BYO-key**, LiteLLM gateway.
- Core parity loop: worktree isolation + plan-mode gate + review/merge-to-PR.
- **Per-project scheduler** (BullMQ/pg-boss, durable, idempotent) — *the lead differentiator.*
- **Hard per-project budgets, pre-run estimates, live meters** — *the trust differentiator, day one.*
- **Telegram** triggering + notifications (zero ToS/ban risk; defer WhatsApp entirely).
- **Mobile thin client** (forked Happy Coder relay + Expo): pairing, approve/reject, push.
- Security baseline: sandboxing, deny-by-default Bash/network, PreToolUse gating, OS-keychain BYO-key vault.
- Skills: **filesystem-loaded only** (no marketplace yet), curated first-party set.
- Switchable effort: the FAST/BALANCED/DEEP/MAX abstraction + per-job slider.

*Deferred from MVP and why:* GPT reviewer (unvalidated lift — run the eval first), marketplace (needs the whole economics/security sub-product), media studio (cost + licensing tail), WhatsApp (ToS), P2P (relay covers 80%), SSO/SCIM (no enterprise buyer yet).

### v1 — "Reviewed, extensible, team-ready"
*Goal: turn the proven loop into a defensible, monetizable product.*
- **GPT-5.x reviewer** — *gated on the MVP eval proving real lift*; two-tier review pre-screen; panel-of-judges for auto-merge.
- **Skills marketplace v1**: skill-broker (search/download/reload), MCP gateway (Docker/ContextForge), continuous scan + signing/provenance, **monetization + payout rails**.
- **Creative Media Studio core**: image (fal/Replicate + first-party) + basic video, normalized job interfaces, async/webhook, **studio metering folded into the budget ledger**, OSS self-host lane as free tier.
- **WhatsApp official Cloud API** lane (business/opt-in only); keep unofficial gated/off.
- **Enterprise readiness**: SSO/OIDC + SCIM, RBAC, immutable exportable audit, SOC 2 Type II, BYOK, zero-retention language.
- Observability: OTel + Langfuse, effort auto-tuner from telemetry.
- Project/sub-project model fully realized with inheritance.
- OpenHands self-host fallback.

### v2 — "Full media powerhouse + sovereign + open ecosystem"
*Goal: complete the white-space loop and broaden personas.*
- **Avatar + video studio at scale**: real-time conversational avatars (D-ID/Anam/Tavus), kinetic typography (Remotion + license), self-host lip-sync (MuseTalk) at volume.
- **Auto-publishing to all platforms**: full PublishProvider matrix, audits cleared (TikTok/LinkedIn), aggregator + direct hybrid, trends module.
- **True P2P / local-first** (Automerge + libp2p) beyond relay, for sovereignty/air-gapped tenants.
- **Tauri mobile / cross-framework unification** (spiked in v1) if the boundary held.
- **Open marketplace economy**: third-party creators, revenue share, reputation/curation.
- ISO 27001/42001, regional data residency, full EU AI Act high-risk posture.
- Reserve/advanced model tiers (Fable), multi-engine hosting (ACP/Zed) as lock-in insurance.

---

## 5. TOP 10 DIFFERENTIATORS

What would make this genuinely best-in-class vs Cursor / Conductor / Warp / Factory / Devin. Ranked by defensibility.

1. **The complete cross-surface orchestration loop, owned end-to-end.** Per-project scheduler + background agents that push to mobile + Telegram/WhatsApp triggering + media studio — *together*. Conductor (the closest product) has *none* of these. No competitor ships the full loop; this is the moat.

2. **Transparent, hard-capped cost governance as a trust product.** Pre-run estimates, live token/ACU/render meters, hard per-project caps (429 on exceed), auto-downgrade, batch+caching enforced. A direct answer to Devin's opaque ACUs and Replit's documented $1,000/week bill-shocks — the #1 market complaint, turned into a feature.

3. **True per-project cron scheduler with durable execution.** Survives crashes, OS sleep, and restarts via checkpoint/resume + idempotency. Continue/Warp-Oz/Devin have fragments; *nobody ships it natively per-project.*

4. **Compliant-by-construction (BYO-key, first-party API, Telegram-first).** While competitors flirt with consumer-subscription resale (and Anthropic banned a wave of them in Jan 2026), this platform is ban-safe by design — a survival advantage that compounds as enforcement tightens.

5. **Provider-agnostic abstraction across model, comms, sync, and media.** Every model ID/price/ToS is swappable config. When Sora 2 dies, Opus revs monthly, or Meta bans a channel, the product re-routes instead of breaking. The fast-moving 2026 landscape *rewards* the one platform built to absorb churn.

6. **Mobile-native remote control of long-running agents.** Pair your phone, approve a diff, get pushed the result of a 20-minute background build or a multi-minute render. Cursor/Conductor are desktop-bound; this makes the agent ambient.

7. **An integrated, metered Creative Media Studio inside the agent.** Image/video/avatar/voice/kinetic-typography → auto-publish, all behind one budget ledger and one consent/moderation/provenance layer. No coding-agent competitor touches media; no media tool has an agent engine.

8. **A continuously-secured dynamic skills marketplace.** On-demand skill download per job, behind a mandatory MCP gateway with signing, sandboxing, and *continuous re-scanning* for rug-pulls — plus a real monetization/payout primitive. Rug-pull-resistant security is the hard, defensible part competitors' install-time review misses.

9. **Mode-aware switchable effort with an eval-tuned default.** FAST/BALANCED/DEEP/MAX with a per-job override, defaults auto-tuned from reasoning-token telemetry — directly countering the "effort paradox" (high effort flat-or-worse at 4–17× cost) that competitors bill you for blindly. Claude Code itself hasn't shipped this natively.

10. **Independent cross-vendor review built into the loop (eval-gated).** Claude builds, GPT critiques — catching single-vendor blind spots on every sensitive merge/publish via a panel-of-judges. *Differentiator only if the MVP eval proves real lift;* shipped honestly (and dropped if it doesn't), it's a credibility win competitors' single-vendor loops can't claim.

---

**Critic's bottom line:** The four sections are excellent *technology* research but together they describe a *toolchain*, not yet a *product*. The three things that will actually determine success are almost untouched: **(1) the business/marketplace model (how we make money on a BYO-key platform), (2) the identity/project/sub-project/tenancy data model (the spine everything hangs on), and (3) who the user actually is (creator vs engineer — currently two products in a trenchcoat).** Resolve those three, treat security/cost/ToS as unified cross-cutting chapters rather than per-section footnotes, and phase ruthlessly around the one defensible moat — cross-surface orchestration — and this becomes a genuinely best-in-class platform rather than a feature-rich me-too wrapper.
