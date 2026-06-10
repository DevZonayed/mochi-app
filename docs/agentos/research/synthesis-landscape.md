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
