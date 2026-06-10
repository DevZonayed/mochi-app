# Maestro — Product Requirements Document (PRD)

> **Single-user · maximum-capability · modular AI-agent desktop + mobile platform.**
> Governed by the binding **[Architecture & Key Decisions record](./ADR.md)**. Grounded in the **[research brief](./research-brief.md)** (17 domains, mid-2026) and the **[ecosystem decomposition](./00-vision-and-decomposition.md)**.
> Every model ID, price, and ToS fact is **point-in-time mid-2026 config** to re-verify at build against the live Vendor Register (§18) — never a constant.
>
> **Working name:** Maestro (placeholder). **Status:** Draft for approval. **Date:** 2026-06-09.

## Table of Contents

1. [Executive Summary, Vision, Goals & Non-Goals, Success Metrics, The Operator & Jobs-to-be-Done, Product Principles](#1-executive-summary-vision-goals-non-goals-success-metrics-the-operator-jobs-to-be-done-product-principles)
2. [System Architecture Overview & Modular Plugin Runtime](#2-system-architecture-overview-modular-plugin-runtime)
3. [Canonical Data Model & State Management](#3-canonical-data-model-state-management)
4. [Agent Engine, Model Layer & Core Agent Loop](#4-agent-engine-model-layer-core-agent-loop)
5. [Switchable Effort & Autonomy Controls](#5-switchable-effort-autonomy-controls)
6. [Projects, Sub-projects & Project Templates](#6-projects-sub-projects-project-templates)
7. [Per-Project Scheduler & Durable Execution](#7-per-project-scheduler-durable-execution)
8. [Dynamic Skills Subsystem, Personal Marketplace & MCP Capability Layer](#8-dynamic-skills-subsystem-personal-marketplace-mcp-capability-layer)
9. [Orchestration & Multi-Agent Workflows](#9-orchestration-multi-agent-workflows)
10. [Comms Gateway — Telegram & WhatsApp](#10-comms-gateway-telegram-whatsapp)
11. [Mobile App, Remote‑Control Plane, Sync & P2P](#11-mobile-app-remotecontrol-plane-sync-p2p)
12. [Creative Media Studio](#12-creative-media-studio)
13. [Auto‑Publishing, Trend Intelligence & Provenance/Consent](#13-autopublishing-trend-intelligence-provenanceconsent)
14. [Security Architecture & Secrets Management](#14-security-architecture-secrets-management)
15. [Cost Governance, Metering & Observability](#15-cost-governance-metering-observability)
16. [Reliability, Failure‑Mode Matrix, Quality & Eval Strategy](#16-reliability-failuremode-matrix-quality-eval-strategy)
17. [System Integration, Platform Services & Desktop Shell UX](#17-system-integration-platform-services-desktop-shell-ux)
18. [Vendor/ToS Register, Phasing & Build Roadmap, Risks & Open Decisions](#18-vendortos-register-phasing-build-roadmap-risks-open-decisions)

---


## 1. Executive Summary, Vision, Goals & Non-Goals, Success Metrics, The Operator & Jobs-to-be-Done, Product Principles

> **Status:** PRD §1. Governed by the binding ADR (`docs/agentos/ADR.md`) and the Vision & Ecosystem Decomposition (`docs/agentos/00-vision-and-decomposition.md`). Every requirement ID (e.g. `AE‑1`) and module ID (e.g. `E3`, `D4`) referenced here traces to the decomposition. Every model ID, price, and ToS fact is **point-in-time mid‑2026 config** to re‑verify at build time against the live Vendor Register (ADR §16.4) — never a constant.

### 1.1 Executive Summary

**Maestro is a single‑operator "operating system for AI work": one desktop application — mirrored to a phone and reachable over chat — from which one person commands a fleet of AI coding and creative agents across many projects, on schedules, and over comms, with each agent pulling in exactly the skills it needs on demand and producing anything from a shipped codebase to a trend‑researched, auto‑published video.**

The market has converged: parallel agents isolated in git worktrees, behind a plan‑then‑act gate, with a review/merge‑to‑PR loop, is now **table stakes** — Cursor 3, Conductor, Warp 2.0, Factory, and Zed all ship it. Conductor (Melty Labs, free Mac app) is the closest existing product to Maestro's core and proves the architecture, but is **Mac‑only, has no mobile, no native per‑project scheduler, no WhatsApp/Telegram, no image/video studio, and no remote control**. Maestro's whole reason to exist is to own the **cross‑surface orchestration loop that no competitor ships together**: a true per‑project durable cron scheduler + background agents that push results to a phone + Telegram/WhatsApp triggering + an integrated media studio with auto‑publishing — wrapped around a provider‑agnostic, BYO‑key engine (Claude builds, an eval‑gated GPT reviewer critiques), with transparent, hard‑capped cost governance as the operator's bill‑shock shield.

Critically, **Maestro is a personal platform, not a product**. There is exactly one user — the operator, who owns it. "Enterprise‑grade" here means **engineering quality** (security, reliability, observability, self‑cost‑awareness, modularity, a clean data model, testability) — explicitly **not** enterprise *sales* features. There is no multi‑tenancy, no teams, no SSO/SCIM/RBAC, no monetization, no marketplace payment economy. The "skills marketplace" is the operator's **own** online skill registry — npm‑for‑skills they publish to and pull from, with no payment layer ever. The top data entity is **Workspace**, not Org (ADR §7). Cost governance exists **solely** to protect the single operator from bill‑shock, never to bill anyone.

The engineering spine is locked (ADR): **Electron** shell over a UI‑agnostic **Maestro Core** Node service behind one typed RPC contract (`F1`/`F5`); the **Claude Agent SDK** harness (`E1`) with **Opus 4.8** builder (`claude-opus-4-8`, $5/$25 per MTok), **Sonnet 4.6** driver, **Haiku 4.5** subagents, **Fable 5** reserve, and **GPT‑5.1** reviewer behind an eval gate that can drop it; a **LiteLLM** self‑hosted router so no model ID is ever hard‑coded; a **BullMQ/Redis** durable scheduler (`D2`); Claude **Skills (`SKILL.md`)** loaded per‑job from the operator's registry through a **mandatory MCP gateway** (`E2`/`E3`/`E4`); **Telegram‑first / WhatsApp two‑lane** comms (`D3`); a **React Native + Expo thin client** over a relay‑brokered E2EE WebSocket (`X2`); and a media studio (`D4`) routing **fal.ai / Replicate / first‑party / OSS self‑host** lanes into auto‑publishing (`D5`).

### 1.2 Vision

> **One operator conducts a fleet. Hand a project a goal and walk away — Maestro plans, executes, reviews its own work, expands its own capabilities from your skill registry, governs its own spend, and pings you only at decision gates — whether you are at the desk, on the train, or in a WhatsApp thread. The machine at home never sleeps mid‑job, and nothing surprises you on the bill.**

Vision in four concrete moments (the decomposition's "success looks like", hardened):

1. **Autonomous build.** Spin up a `Claude‑Code` project, hand it a goal, walk away. Maestro plans (DEEP effort + human checkpoint), builds with Opus 4.8 in an isolated worktree, runs the eval‑gated GPT‑5.1 review loop if it has proven its lift (ADR §3), and pings you only at gates (`AE‑5`, `E5`). *(Acceptance: zero human touches between goal and gate on a representative task class.)*
2. **Produce‑and‑publish.** Say "research this genre and produce + publish 3 videos this week." Maestro runs trend research (`D6`), generates video through the studio (`D4`, Veo 3.1 / Seedance 2.0 / Kling), and auto‑publishes on a schedule to YouTube/TikTok/IG (`D5`), draft‑mode‑gated, with C2PA/SynthID provenance applied (`MS‑1`/`MS‑2`/`DI‑1`/`DI‑2`).
3. **Capabilities that grow themselves.** When a job needs a capability it lacks, Maestro semantically searches *your* skill registry, downloads the right `SKILL.md` skill, verifies its signature, loads it into that session only, and uses it — without you wiring anything (`SK‑1`–`SK‑4`, `E3`/`E4`).
4. **Reach‑anywhere control.** Approve a gate from your phone or a Telegram message on the train; the desktop never sleeps mid‑job because durable resume — not just a wake‑lock — guarantees completion (`MB‑2`/`MB‑4`, `PF‑2`, `D2`, ADR §8/§15).

### 1.3 Goals (measurable)

These are **operator‑outcome metrics**, not commercial metrics (there is no activation/retention/ARR funnel — there is one user). All targets are **directional v1 targets** to be calibrated against a golden‑task eval baseline (ADR §3) once the spine ships; they are how we falsify "max capability" and "enterprise‑grade engineering."

| ID | Goal | Metric | v1 Target | Traces to |
|---|---|---|---|---|
| **G1** | Agents finish work without babysitting | **Unattended jobs completed** (reach terminal success with **zero human touches** between goal and final gate) | ≥ 70% of jobs in the "routine" eval class | `AE‑5`, `D2`, `E5` |
| **G2** | No job dies to an OS power event | **Job survival across sleep/restart** (durable checkpoint/resume, not wake‑lock) | ≥ 99% of interrupted jobs resume and complete | `PF‑2`, `D2`, ADR §8/§17 |
| **G3** | Bill‑shock is impossible | **Cost per job** tracked + **hard per‑project caps honored** (429 on exceed, never silently exceeded) | 100% of runs metered pre‑ + live; 0 cap breaches | `F3`, ADR §16 |
| **G4** | The studio actually ships | **Videos produced + published per week** end‑to‑end (brief → render → published, draft‑gated) | ≥ 3 videos/week unattended after approval | `MS‑2`, `DI‑1`, `D4`/`D5` |
| **G5** | Results arrive fast | **Time‑to‑first‑result** (job accepted → first streamed token / first artifact) | < 5 s to first token; first useful artifact within task SLO | `AE‑5`, `E1` |
| **G6** | Capabilities self‑expand | **Skill‑loop hit rate** (job needing a missing capability that auto‑finds + loads the right registry skill without manual wiring) | ≥ 80% correct skill auto‑selected | `SK‑1`–`SK‑4`, `E3`/`E4` |
| **G7** | The reviewer earns its cost (or is dropped) | **Reviewer net lift** (otherwise‑missed defects caught − false positives, vs. added $/latency) on the eval harness | Ships on‑by‑default only if lift is positive at acceptable cost; else opt‑in DEEP‑only | `AE‑2`, ADR §3/§10, Inv. 11 |
| **G8** | Reach is real | **Remote‑gate latency** (gate raised on Core → actionable on phone/Telegram → decision back) | < 3 s p50 round‑trip over relay | `MB‑4`, `X2`, ADR §12 |
| **G9** | Effort is economical, not maximal | **% jobs run at BALANCED or below** (the effort‑paradox guardrail — DEEP/MAX only when it pays) | ≥ 75% at BALANCED/FAST; DEEP/MAX only eval‑verified‑hard | `AE‑4`, ADR §5 |
| **G10** | The platform is modular | **New capability added as a plugin without touching the core** (first‑party uses the same contract as third‑party) | 100% of new features ship as plugins | `PF‑1`, `E2`/`E3`, ADR §18 |

**Acceptance criteria for §1.3:**
- Each goal has an instrumented metric emitted via OTel GenAI conventions into self‑hosted Langfuse and the unified budget ledger (ADR §16); none is self‑reported.
- "Unattended" (G1) means **zero** approve/edit/reject/respond interactions between job acceptance and the final HITL gate — surfacing a gate is allowed and expected; a human un‑sticking a stalled agent is **not** unattended.
- "Published" (G4) counts only assets that cleared draft‑mode approval and carry provenance metadata; SELF_ONLY/unaudited platform states (e.g. unaudited TikTok) count as *produced*, not *published*.

### 1.4 Non‑Goals (explicit — everything cut by single‑user scope)

These are **out of scope and must stay out**. The source research assumed a multi‑tenant commercial SaaS; that framing is wrong for Maestro and is overridden here and in ADR §0. Stated as Non‑Goals so no PRD section drags them back:

| # | Non‑Goal | Why it is cut |
|---|---|---|
| **NG1** | **Multi‑tenancy / teams / orgs / tenant hierarchy** | One operator, one Workspace. There is no `Org` entity. The research's "Org → Project" model is rejected (ADR §7). |
| **NG2** | **Identity‑as‑a‑product: SSO (SAML/OIDC), SCIM, RBAC, seat/role management** | No second user to authenticate or authorize. (We still do native OAuth *to providers* — `AE‑3`, `F2` — but that is connectivity, not an identity product.) |
| **NG3** | **Monetization of Maestro: subscription tiers, pricing, free‑tier gating, usage‑margin capture** | Not a commercial product. BYO‑key means the operator pays providers directly; Maestro captures nothing. The research's "subscription + take‑rate + studio markup" model is dropped. |
| **NG4** | **Marketplace payment economy: creator payouts, take‑rate, Stripe Connect, Telegram Stars billing, refunds/chargebacks/VAT/tax** | The "marketplace" is the operator's **own** package registry (npm‑for‑skills). It may be public/shareable but has **no payment layer, ever** (ADR §9). |
| **NG5** | **Reselling consumer subscriptions** (BYO Claude/Codex Pro/Max OAuth, Conductor‑style headless) | ToS‑banned and pointless here. Anthropic banned OpenClaw/OpenCode/Roo Code/Goose (Jan 2026); OpenAI has documented Pro bans. The operator uses **their own first‑party API keys** in the OS keychain. |
| **NG6** | **Persona fork (creator app vs engineer app)** | Creator‑vs‑engineer is **not** a product split. It is one power user switching hats via **Project Templates** (`PJ‑1`, ADR §7). No two onboardings, no two apps, no persona conflict. |
| **NG7** | **On‑device Opus / on‑device agent execution on the phone** | Infeasible for Opus‑class work on a phone. **Mobile is a thin client** that drives the desktop Core over a relay (`X2`, ADR §12); it does not run agents locally. |
| **NG8** | **Commercial‑rights / ARR‑threshold gymnastics** (e.g. LTX‑2 "<$10M ARR" gating) | Irrelevant for personal use. We still respect per‑vendor ToS and **legal** consent/provenance obligations (biometric consent, C2PA labeling — ADR §14), because those protect the *cloned person*, not the operator's wallet. |
| **NG9** | **Building on dead/litigated vendors as dependencies** | **Sora 2 is dead** (sunset, no third‑party APIs) — at most a feature‑flag with auto‑fallback. **Suno/Udio** have no API + active litigation → user‑pasted assets only, never a dependency (ADR §13). |
| **NG10** | **Postgres‑scale / cloud‑first datastore as default** | Single‑operator scale → **SQLite + Redis** is the v1 default; Postgres/pg‑boss is a documented swap, not a requirement (ADR §7/§8). |

### 1.5 The Single Operator & Jobs‑to‑be‑Done

There is exactly **one user — the operator** — who owns the platform and wears four hats. This is **one power user switching hats**, not four personas (NG6). Each hat maps to a **Project Template** (`PJ‑1`): a saved preset of default engine + reviewer + effort, starter skills/tools, instruction set, UI layout, and allowed triggers. "Claude‑Code", "Claude‑Design", "Content", "Research" are just templates over the same thin core.

**The Developer** (`Claude‑Code` template)
- *JTBD:* "When I have a coding goal, I want to hand a project the goal and walk away, so that it plans, builds, self‑reviews, and pings me only at gates."
- *Maestro:* Worktree‑per‑agent isolation + plan‑mode gate + review/merge‑to‑PR (parity, copy Cursor's `/worktree`/`/apply-worktree`/`/best-of-n` and Conductor's per‑workspace setup), `E1` engine, `E5` plan→build→review, eval‑gated GPT‑5.1 reviewer. **Counter to** Devin's opaque ACUs and Replit's documented $1,000/week bill‑shocks via hard per‑project caps (`G3`).
- *Requirements:* `AE‑1`, `AE‑2`, `AE‑4`, `AE‑5`, `PJ‑1`, `PJ‑2`, `E1`, `E5`, `D1`.

**The Designer** (`Claude‑Design` template)
- *JTBD:* "When I need a visual asset (image, logo, thumbnail, motion graphic), I want to brief it and get a polished, on‑brand result, so that I'm not hand‑driving a tool chain."
- *Maestro:* `D4` image lane (GPT‑Image‑1.5, **Flux 2 Pro** ~$0.055, Nano‑Banana‑2 for chat editing, Ideogram 3 for text‑in‑image, Recraft V3 for SVG/logo), kinetic typography via **Remotion** (Company License budgeted, `@remotion/licensing` per‑render webhook wired day one), C2PA/SynthID on every output.
- *Requirements:* `MS‑1`, `MS‑4`, `MS‑6`, `D4`.

**The Content‑Creator** (`Content` template)
- *JTBD:* "When I want to grow a channel, I want to research a genre and ship + publish multiple high‑quality videos a week on a schedule, so that distribution runs itself within my budget."
- *Maestro:* `D6` trend/research → `D4` video (Veo 3.1 native‑audio i2v, Seedance 2.0 for volume, Kling for cinematic; **avatar** via HeyGen/Argil with biometric consent capture; voice via **ElevenLabs**/Cartesia; music via **ElevenLabs Music v2** — the only AI music with explicit commercial clearance + a real API) → `D5` auto‑publish (`PublishProvider` over YouTube/TikTok/IG/X/LinkedIn, draft‑mode HITL, per‑platform quota tracking, X links in replies not main post to dodge the ~$0.20/URL charge).
- *Requirements:* `MS‑2`, `MS‑3`, `MS‑5`, `DI‑1`, `DI‑2`, `DI‑3`, `D4`, `D5`, `D6`.

**The Operator** (cross‑cutting — the always‑on conductor hat)
- *JTBD:* "When work is running across many projects, I want to monitor, schedule, approve, and govern spend from anywhere — desk, phone, or chat — so that nothing surprises me and nothing dies because the Mac slept."
- *Maestro:* `D2` durable per‑project scheduler (cron, concurrency, retries, Quartz misfire policy, idempotency, checkpoint/resume) — the **lead differentiator**; `X2` mobile thin client + push approvals; `D3` Telegram/WhatsApp triggering + notifications; `F3` unified budget ledger + live meters + hard caps; `PF‑2` reference‑counted prevent‑sleep paired with durable resume.
- *Requirements:* `PJ‑3`, `PJ‑4`, `PJ‑5`, `MB‑1`, `MB‑2`, `MB‑4`, `CM‑1`, `CM‑2`, `PF‑2`, `PF‑3`, `D2`, `D3`, `X1`, `X2`.

**The mental model** (ADR §7) all four hats share:


Workspace (operator's single root; global defaults + master budget ceiling)
└── Project          (typed via Project Template)            ← per-project instructions scope every Job
    └── Sub-project  (a focused stream)
        └── Job      (one-off or scheduled; has a Trigger)
            └── Session   (a live agent run: engine + effort + permissions + skills + tools)

### 1.6 Product Principles

The design tenets every subsystem must uphold. Each maps to ADR invariants (Appendix A) and is binding.

1. **Provider‑agnostic.** No subsystem ever names a raw model ID, price, or vendor. Everything routes through the **LiteLLM** router behind logical roles (`builder`/`driver`/`subagent`/`reviewer`) and a normalized **`Effort {FAST, BALANCED, DEEP, MAX}`** abstraction. When Opus revs (4.5→4.7→4.8 in ~2 months), a reviewer ID moves (~monthly), or Sora 2 dies, Maestro re‑routes by config — it never breaks. *(AE‑6, ADR §3/§4/§5, Inv. 2.)*
2. **Everything‑a‑plugin.** The core is a thin runtime; every capability — an engine, a connector, a studio tool, a publisher — loads on the fly over **one stable, capability‑scoped contract**. First‑party and third‑party features use the *same* manifest + lifecycle + permission model (dogfooding the seam). *(PF‑1, ADR §18, Inv. 10.)*
3. **Capabilities‑dynamic.** Skills and tools are **discovered and loaded per job**, not baked in. A job that needs capability X semantically searches the operator's registry, downloads the right `SKILL.md`, verifies its signature, loads it into that session only, and unloads on job end. The registry is npm‑for‑skills — no payments. *(SK‑1–SK‑4, E3/E4, ADR §9, Inv. 4.)*
4. **Projects‑typed.** Project Templates are the only "mode switch" — they make one core serve developer, designer, and creator hats without forking the product. New templates are user‑creatable; that is what makes Maestro general‑purpose. *(PJ‑1, ADR §7, Inv. 1.)*
5. **Security‑by‑default.** Treat every skill/MCP server as **arbitrary code with user privileges** and every inbound comms message as a prompt‑injection vector (the lethal trifecta: shell‑capable agents + third‑party skills + untrusted inbound + remote phone control). Process isolation (VS Code‑style topology), a **mandatory MCP gateway** for both engine *and* reviewer, deny‑by‑default network/FS, signed + continuously re‑scanned skills (defeating rug‑pulls on *every* update, not just install), durable HITL gates on destructive actions, and **never** `bypassPermissions`. *(ADR §2/§9/§16, Inv. 3/4.)*
6. **Transparent self‑cost.** One unified budget ledger meters everything — LLM tokens × effort multipliers, container‑ and session‑hours, web search (~$10/1K), image ($0.005–0.24), **video (a single 4K+audio minute ≈ $35–45)**, avatar minutes, Remotion render licensing, publishing costs. Pre‑run estimates + live meters surface before any DEEP/MAX or media run; **hard per‑project caps return 429**; auto‑downgrade + Batch (−50%) + prompt caching (~90%) on scheduled/background runs. This protects the operator from bill‑shock — it never bills anyone. *(F3, ADR §16, Inv. 6, NG3.)*
7. **Plan‑before‑power.** Plan mode + durable human‑in‑the‑loop gates are the **default** for risky work; full autonomy is opt‑in. Plan = DEEP + human checkpoint; execution = BALANCED/FAST. The **effort paradox** is a hard guardrail: high/xhigh effort is flat‑or‑worse on many tasks at 4–17× cost and 5–60× latency, so DEEP/MAX is opt‑in or auto‑escalated only on eval‑verified‑hard task types, with the cost multiplier always surfaced. *(AE‑4/AE‑5, E5, ADR §5/§10, Inv. 9.)*
8. **Reach‑anywhere.** The same control surface on desktop, phone, and chat, synced — **relay‑first** (the proven 2026 pattern: relay‑brokered E2EE WebSocket covers the 15–25% of clients pure P2P fails on via symmetric NAT/CGNAT). Mobile is a **thin client** over the *same* typed RPC contract as desktop IPC; **Yjs** is the sync default; **true P2P (WebRTC) is an optional later transport, not a v1 pillar**. *(MB‑2/MB‑3, X2, F5/F6, ADR §12, Inv. 8, NG7.)*

**Acceptance criteria for §1.6 (principle enforcement, testable):**
- **P1:** A grep of `packages/engine`, `packages/media`, and all subsystem code finds **zero** hard‑coded model IDs/prices outside the router config and Vendor Register.
- **P2:** A new first‑party feature ships as a plugin manifest + capability grant with **no edit to the kernel** (F1).
- **P3:** A job requesting an absent capability triggers a registry `search_skills` → `download_skill` → signature‑verify → per‑session load, all logged in the audit trail, with no manual wiring.
- **P5:** No code path can reach a third‑party MCP/tool except through the gateway; a rug‑pulled skill (description‑hash drift on update) is flagged and quarantined before reuse.
- **P6:** Every cost‑incurring call reports to the single `BudgetLedger`; a project at its cap receives a 429, not a silent overrun.
- **P7:** `bypassPermissions` is absent from the codebase; DEEP/MAX runs surface a cost/latency multiplier before execution; plan mode is the project default.
- **P8:** The mobile client and desktop renderer consume the identical `rpc-contract` package; disabling the P2P transport leaves the platform fully functional over the relay.


## 2. System Architecture Overview & Modular Plugin Runtime

> This section gives the high-level component view of Maestro, defines the process topology that hosts it, and specifies module **F1 — the Plugin Runtime / Kernel** in implementation-ready detail. The stack is **locked by the ADR** (Electron + UI-agnostic Maestro Core + typed RPC seam; ADR §1–§2, §18–§19) and is **not re-derived here** — this section explains *how the pieces compose* and *how "add features on the fly" becomes a concrete contract* for first- and third-party modules alike. Every model ID, price, and library version cited is **point-in-time mid-2026 config** to re-verify against the live Vendor Register (ADR §16.4), never a constant.

### 2.1 Scope, Non-Goals & Invariants for this section

**In scope:** the component decomposition, the multi-process topology, the typed RPC boundary, the modular plugin runtime (manifest / lifecycle / event bus / capability model), and the mapping of the 18 decomposition modules (F1–F6, E1–E5, D1–D6, X1–X3) onto processes.

**Non-Goals (single-user scope — ADR §0; do not let the research drag these back in):**
- **No multi-tenancy.** The plugin runtime loads modules for **one operator**. There is no `Org`, no tenant, no per-tenant plugin isolation. The capability model is a **bill-shock + RCE-containment** boundary, not a multi-user authorization product.
- **No SSO/SCIM/RBAC.** Plugins are scoped by **declared capability grants the operator approves**, not by roles assigned to users. "RBAC" in the research's gateway recommendations (MintMCP "Virtual/Agent Bundles") collapses to **per-job scoped, revocable capability tokens** — kept for containment, stripped of role management.
- **No marketplace payment economy.** The plugin distribution channel is the **operator's own registry** (npm-for-skills, ADR §9); there is **no payment layer, no payouts, no take-rate** — ever.
- **No persona fork.** The same runtime hosts both code modules and the media studio. "Developer vs creator" is one operator switching hats via **Project Templates** (module D1), not two architectures.

**Binding invariants this section upholds** (ADR Appendix A): one stable capability-scoped plugin contract for first- and third-party (#10); mandatory MCP gateway between engine/reviewer and all third-party tools (#4); agent-invisible secrets (#3); never hard-code a model ID — everything routes through the runtime's seams (#2); "phasing" = build order, never tiers (#12).

### 2.2 High-Level Component View

Maestro is a **VS Code-style multi-process desktop application** (ADR §2) in which a thin **Electron shell** owns only windows and OS-native concerns, and a **UI-agnostic Node service — "Maestro Core"** — owns all business logic. The renderer is a **pure view over the Core**; the mobile client is the **same view consuming the same contract over the relay** (ADR §1, §12).


                          ┌───────────────────────────── DESKTOP (Electron) ──────────────────────────────┐
                          │                                                                                │
   ┌────────────┐         │   ┌──────────────┐   typed RPC    ┌───────────────────────────────────────┐    │
   │  Renderer  │◄────────┼──►│ Electron Main│◄── over IPC ──►│            MAESTRO CORE                │    │
   │  (X1 UI,   │  IPC/   │   │  (Platform   │  (MessagePort) │  UI-agnostic Node service (supervisor) │    │
   │   studio)  │ Message │   │   Adapter:   │                │  • F1 Plugin Kernel  • E1 Agent Engine │    │
   │  untrusted │  Port   │   │   sleep,     │                │  • E5 Orchestrator   • E2 MCP mgr      │    │
   └────────────┘         │   │   keychain,  │                │  • E4 Marketplace client • D1 Projects │    │
                          │   │   deep-link, │                │  • F2 Auth  • F3 Obs/Cost  • RPC server │    │
                          │   │   update,    │                └───┬───────────┬──────────┬─────────┬───┘    │
                          │   │   notif)     │                    │ proc bus  │          │         │        │
                          │   └──────────────┘                    ▼           ▼          ▼         ▼        │
                          │                          ┌──────────────┐ ┌─────────────┐ ┌────────┐ ┌───────┐  │
                          │                          │  Scheduler   │ │  Extension/ │ │  MCP   │ │ Media │  │
                          │                          │  Worker(s)   │ │  Skill Host │ │Gateway │ │Workers│  │
                          │                          │ (D2 durable) │ │ (F1+§9+§18) │ │ (§9)   │ │ (D4)  │  │
                          │                          │  trusted,    │ │ UNTRUSTED   │ │ policy │ │trusted│  │
                          │                          │  capped      │ │ sandboxed   │ │boundary│ │ capped│  │
                          │                          └──────────────┘ └─────────────┘ └────────┘ └───────┘  │
                          │                                                                  │              │
                          └──────────────────────────────────────────────────────────────────┼─────────────┘
                                                                                              │
   ┌────────────────────────── ISOLATED SIDECARS (separate processes / OS user) ──────────────┼─────────────┐
   │  Telegram (grammY, Node)  │  WhatsApp whatsmeow (Go) — isolated, opt-in ban risk (D3) │  fal/Replicate │
   └───────────────────────────┴───────────────────────────────────────────────────────────────────────────┘

                                  ┌──────── self-hosted E2EE WebSocket RELAY (F5/F6) ────────┐
   ┌──────────────┐  outbound WSS │  dumb forwarder of encrypted blobs (X25519/AES-256-GCM)  │ outbound WSS  ┌──────────────┐
   │ MAESTRO CORE │◄──────────────┤  Yjs sync (y-websocket) + same typed RPC contract        ├──────────────►│ MOBILE (X2)  │
   │ (relay client)│              └──────────────────────────────────────────────────────────┘               │ RN/Expo thin │
   └──────────────┘                                                                                           └──────────────┘

**The load-bearing seam** is `packages/rpc-contract` (ADR §19): a single **versioned, TypeScript-end-to-end, tRPC-style RPC contract**. Desktop carries it over Electron `MessagePort`/IPC; mobile carries it over the relay WebSocket. Because the **same contract** serves both surfaces, the mobile boundary is proof the Core is genuinely UI-agnostic — and a future Tauri re-shell is a new `PlatformAdapter` + view layer, **not a rewrite** (ADR §1).

#### Functional Requirements — component view

- **FR-ARCH-1 (PF-1, AE-6):** All business logic SHALL live in Maestro Core (or a child process it supervises). The renderer SHALL contain no engine, scheduler, comms, or data-model logic — only view + RPC client code.
- **FR-ARCH-2 (PF-1):** All UI↔Core, Core↔child, and Core↔mobile traffic SHALL flow over the single typed RPC contract in `packages/rpc-contract`. No subsystem may invent a private wire protocol.
- **FR-ARCH-3 (PF-3, MB-2):** The desktop renderer (X1) and mobile client (X2) SHALL be interchangeable consumers of the contract; any capability exposed to desktop is reachable from mobile unless explicitly gated (e.g. destructive ops require an on-device approval — ADR §12).
- **FR-ARCH-4 (AE-1):** The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, behind the stable V1 `query()` API — ADR §3) and Node MCP servers SHALL run **in-process within Maestro Core** (Electron's Node runtime), with **zero sidecar/SEA packaging** for the Node path. Only `whatsmeow` (Go) is a forced non-Node sidecar (ADR §19).

#### Acceptance Criteria — component view

- Killing the renderer process leaves all running Jobs, schedules, and sessions intact in Maestro Core (the renderer is stateless over the Core).
- A single RPC method added to `rpc-contract` is callable, with identical typing, from both the Electron renderer and the Expo mobile client without per-surface adapter code.
- Static analysis (lint rule / dependency-cruiser) fails the build if any `packages/core` business module is imported by `apps/desktop` renderer code, or if any renderer module imports the Agent SDK.
- A Tauri-shell spike can host Maestro Core unchanged by implementing only a new `PlatformAdapter` (proves §1 re-shell seam).

### 2.3 Process / Sandbox Topology

The topology is fixed by ADR §2. Each process has a single responsibility and a trust label; isolation is the RCE-containment and bill-shock strategy for a single operator whose agents have shell/FS access and load arbitrary third-party code.

| Process | Owns | Trust | Why separate | Hosts modules |
|---|---|---|---|---|
| **Electron Main** | Window/lifecycle; `PlatformAdapter` (sleep, keychain, deep-link, auto-update, notifications); spawns + supervises children | Trusted | OS-native chokepoint; the only process touching the keychain | **F4** (system integration); part of **F1** (process supervision) |
| **Renderer(s)** | UI only — command center, studio, job monitor; `contextIsolation` on, `nodeIntegration` off, sandboxed | **Untrusted-by-default** | Renders untrusted web/media content; must never reach Node/engine | **X1** (desktop shell); **X3** UI for the browser bridge |
| **Maestro Core** | Agent engine `query()` loops, LiteLLM router, canonical data model, RPC server, orchestration, marketplace client | **Trusted core** | The brain; keeps engine off Electron internals (re-shell seam) | **F1** kernel host, **E1, E2** (mgr), **E4, E5, D1, F2, F3** |
| **Scheduler Worker(s)** | Durable Job execution; cron; checkpoint/resume | Trusted, resource-capped | A runaway/blocked Job must not stall UI or engine | **D2** |
| **Extension / Skill Host** | Loads third-party skills + first-party plugins in an isolated Node `utilityProcess`; deny-by-default net/FS; capability-scoped token | **UNTRUSTED — sandboxed** | Third-party code = arbitrary code with user privileges (41% of public MCP servers have zero auth; `lotusbail` precedent) | **F1** extension host, **E3** runtime, all loaded plugins |
| **MCP Gateway** | Single chokepoint for ALL third-party MCP/tool traffic (engine *and* reviewer route through it); scoping, allow/deny, audit, signature verification | **Policy boundary** | One enforcement point shared by every consumer | **E2** policy plane (ADR §9 gateway) |
| **Comms Sidecars** | Telegram (grammY, Node) + **WhatsApp `whatsmeow` (Go), isolated, opt-in ban risk** | **Isolated** | A WA ban/crash/compromise must be contained away from the engine | **D3** |
| **Media Workers** | Remotion/ffmpeg renders; fal/Replicate webhook polling | Trusted, resource-capped | CPU/GPU-heavy, killable, out-of-band of the chat loop | **D4** render lane |
| **Relay (own service)** + **Mobile (RN/Expo)** | Dumb E2EE blob forwarder; thin remote-control client | Relay sees only ciphertext | Zero inbound ports; CGNAT traversal; sleep-survival | **F5, F6, X2** |

Every child process speaks the **same typed RPC contract over a `process bus`**, and the Extension Host + MCP Gateway are **capability-token-scoped** — a child can only call what its grant allows. Swapping a sidecar (whatsmeow → Baileys) or a worker pool is a **process-registry change**, not an engine change (ADR §2 seam).

#### Functional Requirements — topology

- **FR-PROC-1 (PF-1, SK-5):** Third-party skills/plugins and all third-party MCP servers SHALL execute only inside the Extension/Skill Host (`utilityProcess`), never in Main, Core, or a renderer. The Skill Host SHALL start with **deny-by-default network and filesystem** access.
- **FR-PROC-2 (ADR §2, §9):** ALL third-party MCP/tool calls — from both the Claude builder and the GPT reviewer — SHALL route through the MCP Gateway process. No subsystem may open a direct connection to a third-party MCP server.
- **FR-PROC-3 (CM-1):** The WhatsApp `whatsmeow` sidecar SHALL run as a separate process (separate OS user where the platform permits) so a ban/crash/compromise cannot reach Maestro Core.
- **FR-PROC-4 (PF-2, NFR-reliability):** A blocked or runaway Job in a Scheduler Worker or a stalled render in a Media Worker SHALL NOT block the Core RPC server or the UI; the supervisor SHALL be able to kill and restart any child.

#### Acceptance Criteria — topology

- A skill that attempts an un-granted outbound network connection is denied by the Skill Host sandbox and the attempt is recorded in the append-only audit log (ADR §7).
- Traffic capture shows zero direct engine→third-party-MCP connections; every third-party tool call appears in the MCP Gateway audit trail with its scoping decision.
- Force-killing the `whatsmeow` sidecar leaves Telegram, the engine, and all Jobs running; the comms gateway surfaces WhatsApp as "degraded" (ADR §17 matrix).
- Injecting an infinite loop into a scheduled Job keeps the desktop UI responsive and lets the operator cancel the Job from desktop or mobile.

### 2.4 The Typed RPC / IPC Boundary

The boundary is one **versioned, TypeScript-end-to-end contract** (`packages/rpc-contract`, ADR §19) — the single seam binding desktop renderer ↔ Main ↔ Core ↔ child processes ↔ mobile.

- **Shape:** tRPC-style typed procedures (queries, mutations, and **server-streaming subscriptions** for the streaming-everywhere requirement AE-5). One schema generates client + server types; drift is a compile error.
- **Desktop transport:** Electron `MessagePort`/IPC between renderer and Main, and a `process bus` (structured-clone/MessagePort) between Main, Core, and the child processes.
- **Mobile transport:** the **same contract** serialized over the relay-brokered E2EE WebSocket (ADR §12). Mobile is not a special API — it is the contract over a different transport.
- **Versioning:** the contract is **explicitly versioned**; a capability-negotiation handshake (ADR §9) lets an older mobile build talk to a newer Core within a compatibility window. This is the same negotiation layer that wraps MCP spec revisions (`mcp-client-2025-11-20`, `advanced-tool-use-2025-11-20`) and beta headers so vendor churn never breaks the wire.
- **Streaming:** agent token streams, Job progress, render progress, and live budget meters (ADR §16) flow as subscriptions over the boundary to whichever surface the operator is on.

#### Acceptance Criteria — RPC boundary

- A breaking change to an RPC procedure signature fails `turbo build` at the type level before runtime (the contract is the compile-time seam).
- An agent run streams tokens to the desktop renderer and, simultaneously, to the mobile client over the relay, using the same subscription procedure.
- A mobile client one minor contract version behind the Core can still invoke core procedures via capability negotiation, and is told (not crashed) when it requests a procedure the negotiated version lacks.

### 2.5 The Modular Plugin Runtime — Module F1

> **F1 Plugin Runtime / Kernel** (decomposition Layer 0): *"Loads modules over a stable contract; lifecycle, IPC, event bus; the 'add features on the fly' backbone."* Depends on nothing; **everything above the Foundation layer is a plugin over F1** (decomposition §5; ADR §18). F1 directly realizes **PF-1** ("modular architecture; add features on the fly") and operating tenet #2 ("everything is a plugin").

F1 is deliberately **thin**: the kernel knows only the **contract**, never a specific plugin. **First-party and third-party features use the identical manifest + lifecycle + capability model** — dogfooding the seam so the contract stays honest (ADR §18). The runtime is **Claude-plugin-aligned** (`.claude-plugin/plugin.json`-style) so it interoperates with the Claude/MCP ecosystem rather than inventing a bespoke protocol (ADR §9, §18; SK-1, SK-6).

#### 2.5.1 The stable plugin contract

A plugin is a Git-distributed bundle (from the operator's own registry, module E4 / ADR §9 — **no payment layer**) declaring what it contributes and what it is permitted to touch.

**Manifest** (`.claude-plugin/plugin.json`-aligned) declares:

| Field | Purpose | Maps to |
|---|---|---|
| `id`, `version` | Identity + semver; commit-SHA-pinnable | SK-5 versioning |
| `contributes.skills` | `SKILL.md` bundles (frontmatter `name` ≤64 / `description` ≤1024 stating *what + when*; body ≤500 lines; 3-tier progressive disclosure) | E3, SK-1 |
| `contributes.mcpServers` | MCP servers/tools (Streamable HTTP for remote, `stdio` for bundled-local) | E2, SK-6 |
| `contributes.hooks` | Agent SDK lifecycle hooks | E1, AE-5 |
| `contributes.uiSurfaces` | Renderer panels/views the plugin adds to X1 | X1, PF-3 |
| `contributes.triggers` | Job trigger types the plugin registers (manual/cron/comms/webhook) | D2, PJ-5 |
| `contributes.channels` | Comms channels (maps to Telegram/etc.) | D3, CM-3 |
| `capabilities` (**required**) | The declared permission set: which **tools, network hosts, FS paths, comms channels, budget ceiling** it may touch | The security boundary (§2.5.4) |
| `signature` / `manifest` SHA256 | Provenance + integrity (operator-signed for own skills) | SK-5, ADR §9 |

**Distribution & on-the-fly install:** plugins install from Git repos / the operator's registry **without an app update** (ADR §18; SK-2..SK-4). The dynamic skill loop (ADR §9; decomposition §7) materializes a `SKILL.md` bundle into the Job's `.claude/skills/` and the Agent SDK loads it at session start/reload — closing the SDK's **no-mid-session-register-API gap** via write-to-disk + reload (the genuinely hard build-it-yourself UX problem, ADR §9).

#### 2.5.2 Lifecycle

Fixed by ADR §18: `discover → verify → activate → run → deactivate/unload`.

| Phase | What happens | Guard |
|---|---|---|
| **discover** | Kernel finds the plugin (registry search via the Skill-Broker's `search_skills`, or local registry index) | Vector search keeps Level-1 metadata cost flat past ~50 skills (don't pre-load all metadata — ADR §9) |
| **verify** | Signature check + SHA256 manifest pin + **GPT-based static scan** (flags external-URL fetches / unexpected network calls / tool-purpose mismatch) | Runs on ingest **and on every update** — continuous rug-pull defense, not one-time (ADR §9; SK-5) |
| **activate** | Kernel spawns/attaches the plugin into the Extension/Skill Host with a **capability-scoped token** granting ONLY the manifest-declared, operator-approved capabilities | Deny-by-default; operator approves the grant once |
| **run** | Plugin contributes its skills/tools/hooks/UI/triggers; all tool calls route through the MCP Gateway | Cannot widen grant at runtime (§2.5.4) |
| **deactivate / unload** | On Job end or operator action, the token is revoked, ephemeral per-job skills are unloaded/cached per policy | Per-job ephemeral identity is revocable (ADR §9) |

#### 2.5.3 Event bus

The kernel hosts an **in-process, typed event bus** over the same `process bus` / RPC contract. It is how modules compose **without compile-time coupling** — a publisher names an event; subscribers (first- or third-party) react.

- **Events** (illustrative): `job.created`, `job.checkpointed`, `session.token` (streaming), `gate.requested` (HITL), `budget.threshold` (ADR §16), `comms.inbound` (untrusted — ADR §11), `skill.activated`, `media.render.progress`, `publish.draft.ready`.
- **Trigger sources** (D2, PJ-5) are event subscribers: a `comms.inbound` event or a `webhook.received` event can start a Job exactly like a cron tick — all implementing one `TriggerSource` contract (ADR §8).
- **Untrusted-input discipline:** `comms.inbound` events carry a taint flag; subscribers that act on them must route through the review/allowlist gates (ADR §11, §16 lethal-trifecta).

#### 2.5.4 Capability / permission model

This is the **security boundary** and, in single-user scope, the **only** permission system — it replaces (does not implement) RBAC/SSO (ADR §0).

- A plugin **cannot widen its grant at runtime.** The Extension Host enforces the manifest-declared capability set; any tool/host/path/channel outside it is denied and audited.
- **Capability-scoped tokens** are issued per-activation and, for skills, **per-Job (ephemeral, independently revocable)** — modeling the research's "Agent Bundle" idea but **stripped of role management** (single operator, no RBAC).
- **All tool calls route through the MCP Gateway** (ADR §9), which is the deterministic enforcement point for allow/deny, scoping, audit, and signature verification — shared by both the engine and the reviewer.
- **Deny-by-default network/FS** in the Skill Host; network-dependent skills (studio, comms) get explicit host grants; self-contained data/document skills get none.
- **HITL on destructive/irreversible calls** (ADR §10) — publish, send, delete — surfaced to whichever surface the operator is on (desktop/mobile/Telegram).
- **Agent-invisible secrets** (ADR §3, §6): plugins use credentials via the `SecretStore` accessor and **never see the secret value**, surviving prompt injection.

#### Functional Requirements — F1 plugin runtime

- **FR-F1-1 (PF-1, tenet #2):** The kernel SHALL load both first-party and third-party features through the **identical** manifest + lifecycle + capability contract; there SHALL be no separate "built-in feature" code path.
- **FR-F1-2 (SK-2..SK-4):** A new plugin/skill SHALL be installable on the fly from the operator's registry or a Git repo **without an application update or restart of Maestro Core**; per-Job skills materialize-to-disk and load at session reload.
- **FR-F1-3 (SK-5, ADR §9):** Every plugin SHALL be signature- and SHA256-verified and statically scanned **on install and on every update**; description-hash drift SHALL trigger re-scan (rug-pull defense).
- **FR-F1-4 (§2.5.4):** A plugin SHALL receive only its manifest-declared, operator-approved capabilities and SHALL be unable to widen them at runtime; all its tool calls SHALL pass through the MCP Gateway.
- **FR-F1-5 (PF-1):** Adding a new module (e.g. a Slack `CommsChannel`, a new media `*Job` endpoint, a new publishing provider) SHALL require **no change to the kernel** — only a new plugin implementing the relevant contract.
- **FR-F1-6 (ADR §0):** The runtime SHALL contain **no** payment, payout, take-rate, tenancy, role, or seat concept. Distribution is the operator's own registry; access is by capability grant, not role.

#### Acceptance Criteria — F1 plugin runtime

- Installing a registry skill mid-session and running a Job that uses it succeeds with no app restart; the skill loads into a sandboxed Skill Host and its tool calls appear in the MCP Gateway audit log.
- A first-party module (e.g. the media studio panel) and a hand-written third-party test plugin load through the same code path; removing the first-party module's manifest unloads it exactly as for a third-party plugin (no privileged shortcut).
- A plugin whose static scan flags an undeclared external-URL fetch is blocked at `verify` and never reaches `activate`; the operator sees the scan finding.
- A previously-approved plugin whose `SKILL.md` description hash changes on update is re-scanned and re-prompted before re-activation (rug-pull is caught).
- A plugin attempting a tool call outside its capability grant is denied, the Job continues or fails cleanly, and the denial is in the append-only audit log.
- Grepping the codebase for payment/tenant/role/seat concepts in the plugin runtime returns nothing (single-user invariant holds).

### 2.6 Mapping the 18 Decomposition Modules onto Processes

Every module from the decomposition (§5) is placed on exactly one home process. **All 18 are in scope and built** — placement is an architecture fact, not a tier (ADR Appendix A #12).

| Module | Name | Home process | Notes / ADR ref |
|---|---|---|---|
| **F1** | Plugin Runtime / Kernel | **Maestro Core** (kernel) + **Extension/Skill Host** (where plugins run) | The thin core + the sandbox it manages (§2.5; ADR §18) |
| **F2** | Identity & Auth (native OAuth) | **Maestro Core**, with the keychain accessor + OAuth loopback in **Electron Main / PlatformAdapter** | PKCE+loopback default; tokens in OS keychain, agent-invisible (ADR §6) |
| **F3** | Secrets & Cost/Observability | **Maestro Core** (BudgetLedger, OTel/Langfuse, audit) | One unified ledger + one audit log (ADR §7, §16) |
| **F4** | System Integration | **Electron Main** (`PlatformAdapter`) | Reference-counted prevent-sleep, signed auto-update, notifications, deep-links (ADR §15; PF-2) |
| **F5** | Sync Backbone (server) | **Relay service** (own deploy) + **Maestro Core** as a relay client | Relay-brokered E2EE WSS, Yjs sync (ADR §12) |
| **F6** | P2P Layer | **Relay / Transport seam** — **relay-first; true P2P (WebRTC+coturn) optional & deferred** | Not a v1 pillar (ADR §12, Appendix A #8) |
| **E1** | Agent Runtime / Engine Abstraction | **Maestro Core** (hosts Claude Agent SDK `query()` loops) | `AgentEngine` interface; OpenHands fallback; model IDs only via router (ADR §3, §4; AE-1/2/4/5) |
| **E2** | MCP / Tools Manager | **Maestro Core** (manager) + **MCP Gateway** (enforcement) | Mandatory gateway between engine/reviewer and all third-party tools (ADR §2, §9; SK-6) |
| **E3** | Skills Subsystem | **Extension/Skill Host** (runtime) + **Maestro Core** (registry index) | Per-Job ephemeral load via Skill-Broker; sandboxed (ADR §9; SK-1) |
| **E4** | Marketplace Client | **Maestro Core** (talks to the operator's **own** registry service) | Search/publish/download — **no payment layer** (ADR §9, §0; SK-2..4) |
| **E5** | Orchestration / Workflow Engine | **Maestro Core** | plan→build→review loop, fan-out, judge panels, durable HITL gates (ADR §10) |
| **D1** | Project & Workspace Manager | **Maestro Core** (over the SQLite Repository layer) | Workspace→Project→Sub-project hierarchy; **Project Templates** = the hat-switch (ADR §7; PJ-1/2) |
| **D2** | Job & Scheduler Engine | **Scheduler Worker(s)** + Redis/BullMQ | Durable, checkpoint/resume, idempotency, misfire policy (ADR §8; PJ-3/4) |
| **D3** | Comms Connectors | **Telegram sidecar (grammY, Node)** + **WhatsApp `whatsmeow` sidecar (Go, isolated)** | Telegram-first; WA opt-in/isolated; inbound untrusted (ADR §11; CM-1/2) |
| **D4** | Media Studio | **Media Workers** (Remotion/ffmpeg) + **Maestro Core** (`*Job` routing) | fal/Replicate + first-party + OSS lanes; async+webhooks; **Sora 2 dead** (ADR §13; MS-*) |
| **D5** | Publishing & Distribution | **Maestro Core** (`PublishProvider`) + **Scheduler Worker** (scheduled posts) | HITL/draft default; C2PA/SynthID + biometric consent mandatory (ADR §14; DI-1) |
| **D6** | Trend & Research Intelligence | **Maestro Core** (orchestrated via E5) → feeds D4 | Genre/trend research → content briefs (ADR §10/§13; DI-2/3) |
| **X1** | Desktop Shell | **Renderer(s)** | Command center; pure view over the Core (ADR §1; PF-3) |
| **X2** | Mobile App | **Mobile (RN/Expo)** over the relay | Thin client; same RPC contract; approve gates, view media (ADR §12; MB-1/2/4) |
| **X3** | Browser bridge (Super-Tester) | **A Tool behind the MCP Gateway**; UI in **Renderer** | Existing extension reused as an agent tool surface (ADR §15; PF-4) |

> **Count note:** the decomposition lists **18** modules across the four layers (F1–F6 = 6, E1–E5 = 5, D1–D6 = 6, X1–X3 = 3 → 20 IDs, of which the brief's "18 modules" reflects the build-relevant set). All listed IDs are placed above; none is dropped.

#### How the two big parallel workstreams attach (build order, not tiers — ADR Appendix B)

- **Spine (critical path `F1 → F2/F3 → E1 → D1 → D2`):** the kernel, secrets/obs, agent engine, projects, and durable scheduler — the part everything hangs off.
- **Capability workstream** (parallel after E1): E2 gateway + Extension Host → E3 skills → E4 the operator's registry. Attaches via the plugin contract (§2.5) and the MCP Gateway seam.
- **Reach workstream** (parallel after F5): relay → X2 mobile → D3 comms. Attaches via the relay transport + the same RPC contract.
- **Studio workstream** (parallel, needs only E1): D4 → D6 → D5. Attaches via the media `*Job` interfaces and the Media Worker process.
- **Shell** (X1) grows continuously alongside all of them.

**First integration milestone** (de-risks every seam before pouring concrete, ADR Appendix B): the **Spine + one end-to-end vertical** — one Project Template running a **scheduled Job that loads one registry skill** (exercising F1's full lifecycle + the Skill Host sandbox + MCP Gateway), **metered by the budget ledger** (F3), **visible on the desktop shell** (X1), and **approvable from the phone over the relay** (X2/F5). This single vertical touches F1, F2, F3, E1, E2, E3, E4, D1, D2, F5, X1, and X2 — proving the plugin runtime and the RPC boundary hold before the parallel workstreams pour concrete.


## 3. Canonical Data Model & State Management

> **Scope anchor (binding):** Single operator. **Workspace is the top entity — there is NO `Org`, no tenant, no team, no `user_id` foreign key anywhere in the schema.** This section is the "missing spine" the completeness critique flagged (critique §1.7, §2.7): one canonical schema with explicit inheritance, one unified budget ledger, one append-only audit log, and a defined source-of-truth + conflict-resolution story across desktop and mobile. It implements ADR §7 verbatim and is governed by it; where this PRD elaborates, it must never contradict ADR §7 or Appendix-A invariants 1 and 6. It is owned by module **D1 (Project & Workspace Manager)** with stores provided by **F3 (Secrets & Cost/Observability)** and **F5 (Sync Backbone)**, and it is the data substrate every other module reads and writes.

This section satisfies **PJ-1** (projects + sub-projects), **PJ-2** (per-project instructions/config scoping every job), and is the precondition for **AE-4** (per-job effort), **SK-1** (per-job separated skills), **PJ-4** (per-project concurrency/retry defaults), and the cost-governance NFRs.

### 3.1 The hierarchy (canonical entities)


Workspace                        E0  the operator's single root: global defaults, master budget ceiling, key vault binding
└── Project                      E1  typed via Project Template (Code / Design / Content / Research / …)
    └── Sub-project              E1  a focused stream within a Project (optional; ≥0 per Project)
        └── Job                  E2  a unit of work — one-off or scheduled; carries exactly one Trigger
            └── Session          E3  a single live agent run: engine + effort + permissions + loaded skills + scoped tools
                └── Turn/Event   E3  individual agent steps, tool calls, gate decisions (transcript-level)

**One Workspace per installation.** It is created on first run and is never deletable (only resettable). It is the anchor for everything single-user: the operator's keys, the master spend ceiling, global defaults, and the root CRDT sync identity. There is deliberately no entity above it — that absence *is* the single-user invariant made structural.

| Entity | Cardinality | Lifespan | Primary purpose |
|---|---|---|---|
| **Workspace** | exactly 1 | permanent | Root of defaults + budget ceiling + key binding; sync root |
| **Project** | 0..N | long-lived | A bounded area of work with its own template, instructions, defaults, caps |
| **Sub-project** | 0..N per Project | long-lived | A focused stream inside a Project; same shape as Project, one level down |
| **Job** | 0..N per (Sub-)project | hours→months (recurring) | A schedulable unit of work bound to one Trigger; the scheduler's atom (§3.5, ties to D2) |
| **Session** | 1..N per Job | minutes→hours | One agent run; maps 1:1 to a Claude Agent SDK JSONL session (resumable/forkable) |
| **Trigger** | 1 per Job | with the Job | `manual | cron | comms-message | webhook/event` (PJ-5) |
| **Run / Turn / Event** | N per Session | with the Session | Transcript granularity; the unit of audit + replay |

**Why a Job ≠ a Session.** A scheduled Job (e.g. "every morning, research the genre and draft 3 video concepts") spawns a *new* Session each time it fires. The Job holds the durable definition (trigger, budget, skill defaults, idempotency key); the Session holds the live run (engine handle, effort, the JSONL transcript, the wake-lock reference). A Job that is retried or resumed (§3.5) may have several Sessions; the latest is "current." This separation is what makes checkpoint/resume (ADR §8) and missed-run recovery coherent.

**Project Template is not an entity in this hierarchy — it is a saved preset** (engine/effort defaults, starter skill set, allowed tools/MCP, instruction scaffold, allowed triggers, UI layout) that *initializes* a Project's attached config. "Claude", "Claude-Design", "Claude-Code" are three templates; the operator switching hats is a template choice, never a persona fork (ADR §0). Templates live in their own table and are referenced by `template_id` on Project; editing a template does **not** retroactively mutate existing Projects (Projects copy-on-create, then diverge).

#### Functional requirements — hierarchy
- **FR-DM-1:** The system SHALL maintain exactly one Workspace; it SHALL be auto-created on first run and SHALL NOT be deletable, only resettable (§3.7).
- **FR-DM-2:** A Project SHALL reference exactly one Project Template at creation and SHALL thereafter own an independent, mutable copy of its config (no live template back-reference).
- **FR-DM-3:** Sub-projects SHALL be structurally identical to Projects (same attached-config shape) and SHALL nest exactly one level under a Project. Deeper nesting is OUT OF SCOPE for v1 (keep the tree shallow; depth complicates inheritance with no single-operator payoff).
- **FR-DM-4:** Every Job SHALL carry exactly one Trigger and exactly one idempotency key; every Job firing SHALL create a new Session.
- **FR-DM-5:** Every Session SHALL map 1:1 to a Claude Agent SDK JSONL transcript and SHALL be resumable from its last checkpoint.

#### Acceptance criteria — hierarchy
- Creating a Project from a template, then editing the template, leaves the existing Project's config byte-for-byte unchanged.
- Deleting a Project cascades to its Sub-projects, Jobs, Sessions, transcripts, and CRDT docs (§3.7) and leaves no orphan rows in any store.
- A scheduled Job firing twice produces two distinct Sessions with two distinct transcripts but a single, stable Job row.
- The schema contains no `org_id`, `tenant_id`, `team_id`, `seat`, or `role` column anywhere (grep-enforceable invariant; ADR Appendix-A #1).

### 3.2 What attaches at each level

Each concern attaches at the level where it is *authoritatively defined*, and resolves down the tree by the inheritance rules in §3.3. This is ADR §7's attachment table, elaborated.

| Concern | Authoritative level(s) | Stored in | Notes / requirement IDs |
|---|---|---|---|
| **Per-project instructions / config** | Project → Sub-project → Session | SQLite (`config_doc` JSON column) + Yjs for live edits | The text that scopes every Job in the Project (**PJ-2**). Concatenated down the tree (§3.3). |
| **Default engine + effort** | Workspace default → Project → Job override | SQLite | Logical *role* (`builder`/`driver`/`reviewer`) + `Effort{FAST,BALANCED,DEEP,MAX}` — never a raw model ID (ADR §3–§5, invariant #2). **AE-4.** Reviewer on/off follows the effort-gate table (ADR §5). |
| **Budget / caps** | Workspace ceiling → Project hard cap → Job per-run cap | SQLite (definition) + Redis (live counters) + ledger (§3.6) | Child cap MUST be ≤ parent remaining; hard 429 on breach (ADR §16). |
| **Keys / OAuth tokens** | Workspace only | OS Keychain (secret) + SQLite (non-secret metadata) | Single operator → inherited everywhere, never per-node. Agent-invisible (ADR §6, invariant #3). |
| **Skills** | Project (template default set) → Session (ephemeral per-job load) | SQLite (registry index + Project default-set) + per-Job ephemeral `.claude/skills/` on object store | **SK-1.** Session adds/removes on top of the Project set; dynamic loop = E3/E4 (ADR §9). |
| **Tools / MCP servers** | Project (allowlist) → Job/Session (scoped subset) | SQLite (allowlist) | **SK-6.** Deny-by-default; a Session can only *narrow*, never *widen*, the Project allowlist. Enforced at the MCP Gateway (ADR §2/§9, invariant #4). |
| **Permissions / autonomy** | Project (default mode) → Job (override) | SQLite | Six SDK permission modes; plan-mode default; **never `bypassPermissions`** (AE-5). |
| **Triggers** | Job | SQLite (def) + Redis (BullMQ schedule) | manual/cron/comms/webhook (**PJ-5**); idempotency key co-located. |
| **Concurrency / retry / misfire** | Project default → Job override | SQLite (policy) + Redis (enforcement) | **PJ-4.** Quartz misfire policy + retry budget (ADR §8). |
| **Audit** | Every level (recorded where it happens) | Append-only audit log (SQLite table + exportable JSONL) | Immutable; never inherited (§3.6). |
| **Sync-state** | Workspace / Project / Job docs | Yjs CRDT docs | Projection for desktop↔mobile (§3.4); relational store remains source of truth. |
| **Media artifacts / render outputs / skill bundles** | Job / Session | Local FS object store (+ optional Cloudflare R2) | Large binaries out of the relational store (ADR §7); referenced by content hash. |

A **resolved view** for any Job/Session is computed by walking Workspace → Project → Sub-project → Job → Session and applying §3.3. This resolved config is what the engine, router, scheduler, and MCP gateway actually consume — none of them re-walk the tree themselves; D1 hands them a frozen `ResolvedConfig` snapshot per Session so that mid-run template/parent edits cannot mutate a running Session.

### 3.3 Inheritance rules

**Default rule: child overrides, else inherits.** A node that does not set a concern inherits the nearest ancestor's value. Beyond that default, four concerns have special semantics:

| Concern | Inheritance semantics |
|---|---|
| **Instructions / config** | **Concatenation, not replacement.** Resolved instructions = Workspace ⊕ Project ⊕ Sub-project ⊕ Session, in tree order, each appended. A child cannot delete an ancestor instruction, only add (this keeps Workspace-level safety rules un-removable by a child). |
| **Budget / caps** | **Monotonic narrowing.** A child cap is valid only if ≤ parent *remaining*. Spend rolls *up*: Job spend debits the Project ledger which debits the Workspace ceiling. A breach at any level returns a hard 429 to the caller and halts the run (ADR §16). |
| **Tools / MCP** | **Intersection (narrow-only).** Effective tool set = Project allowlist ∩ Session request. A Session can never reference a server outside the Project allowlist; attempts are denied at the gateway and audited. |
| **Skills** | **Additive overlay.** Session skill set = Project default set + per-Job dynamically loaded skills − explicitly removed. Loaded skills are ephemeral to the Session (§3.7 retention). |
| **Permissions** | **Most-restrictive-wins.** The effective permission mode is the *stricter* of (parent default, child override). A child may tighten (e.g. plan-mode) but the platform clamps `bypassPermissions` away regardless of level. |
| **Keys** | **No override.** Single operator; keys live only at Workspace and are inherited unconditionally. There is no node-level key (the multi-user "whose key" problem does not exist — ADR §6). |

This asymmetry is deliberate and security-motivated: **safety-relevant concerns (instructions, caps, permissions, tools) inherit in the direction that a child can only make things *safer*, never more permissive.** Capability-expanding concerns (skills) are additive but ephemeral and gated. The completeness critique's worry that "do sub-projects inherit keys/budgets/skills/permissions?" (critique §1.2) is answered here explicitly and per-concern, not hand-waved.

The inheritance graph is persisted explicitly (not recomputed implicitly) in an `inheritance` resolution table keyed by `(node_id, concern)` so that "where did this Session's effort default come from?" is an auditable lookup, not a guess.

#### Acceptance criteria — inheritance
- A Workspace-level instruction ("never publish without a draft gate") appears in the resolved instructions of every descendant Session and cannot be removed by any Project, Sub-project, or Session.
- Setting a Job per-run cap above the Project's remaining budget is rejected at write time with a clear error; it never silently clamps.
- A Session requesting an MCP server not in its Project allowlist is denied at the gateway, the denial is audited, and the run continues without that tool (or halts if the tool was required — operator-configurable).
- Spend on a Session correctly debits Job → Project → Workspace counters; the Workspace ceiling is never exceeded.

### 3.4 Store ownership — who owns what

The single most important rule (invariant #6): **the relational store (SQLite) is the source of truth; everything else is a derived projection, an ephemeral coordination layer, a secret vault, or an append-only side-record.** No subsystem invents its own canonical store.

| Store | Owns (authoritative for) | Is NOT authoritative for | Why this store |
|---|---|---|---|
| **SQLite** (embedded; `better-sqlite3`/WAL mode) | The canonical relational model: Workspace/Project/Sub-project/Job/Session rows, Template defs, schedule defs, skill-registry **index**, OAuth-token **metadata** (issuer, scopes, expiry — *not* the secret), publishing quotas/audits, the inheritance resolution table | Secrets, queue runtime, transcripts, live sync deltas | Zero-ops, embedded, single-writer-friendly for one operator; **Postgres is explicitly NOT needed** at single-operator scale (ADR §7) but is the documented swap behind the `Repository` interface |
| **Redis** | BullMQ queues + scheduler runtime state + global/per-project rate-limiter + **live budget meter counters** | Durable definitions (those live in SQLite) | Fast ephemeral coordination (ADR §8); Redis is *cache + queue*, never source of truth — it can be wiped and rebuilt from SQLite + transcripts |
| **JSONL transcripts** (Claude Agent SDK native) | The per-Session replayable run history: turns, tool calls, thinking, results — the resume point | Cross-Session aggregates, config | Native SDK format; resumable/forkable; the checkpoint substrate for §3.5 |
| **Yjs CRDT docs** | The *synced projection* of live state shown on desktop↔mobile (current job status, scheduler view, marketplace/registry view, gate queue) | The canonical record (it mirrors SQLite, it does not replace it) | Offline-first, conflict-free multi-device editing (ADR §12); see §3.5 for the SQLite↔Yjs binding |
| **OS Keychain** (`SecretStore`: macOS Keychain / Windows DPAPI / Linux libsecret) | The *actual* API keys + OAuth refresh/access tokens | Anything the agent is allowed to read | Agent-invisible, OS-protected (ADR §6, invariant #3); the agent uses a credential via an opaque handle and never sees the bytes |
| **Append-only audit log** (SQLite table + exportable JSONL) | The immutable record of every tool call, send, publish, spend event, gate decision, key access, config change | Mutable current state | Tamper-evident self-accountability + reliability forensics (§3.6); write-once, never UPDATE/DELETE |
| **Object store** (local FS, content-addressed; optional Cloudflare R2 mirror) | Media artifacts, render outputs, downloaded skill bundles, large attachments | Metadata/索引 about them (that's SQLite) | Keeps large binaries out of the relational store; referenced by SHA-256 |

**The binding rule between SQLite and Yjs (the part the critique flagged as undefined):** SQLite is canonical. Each syncable concern has a Yjs doc that is a *materialized, bidirectionally-bound projection* of specific SQLite rows. The Maestro Core owns a **single binder** that (a) seeds the Yjs doc from SQLite on load, (b) applies validated CRDT changes back to SQLite within a transaction, and (c) re-projects on external SQLite writes. The renderer and mobile client **only ever touch Yjs docs over the RPC contract**; they never write SQLite directly. This means: a value is "real" once it is committed to SQLite; Yjs is how that value travels and merges between devices while offline.

What is **NOT** put in Yjs (deliberately): secrets (keychain only), budget *ledger truth* (SQLite + Redis counters — money is not eventually-consistent), and audit entries (append-only, never merged). Yjs carries *view and intent* state, not money and not secrets.

#### Functional requirements — stores
- **FR-DM-6:** SQLite SHALL be the single source of truth; Redis and Yjs SHALL be fully reconstructible from SQLite + JSONL transcripts after a wipe.
- **FR-DM-7:** Secrets SHALL exist only in the OS keychain; SQLite SHALL store only non-secret token metadata; no secret SHALL ever be written to a transcript, audit log, Yjs doc, or object store.
- **FR-DM-8:** Every state-changing operation SHALL append an immutable audit entry; the audit log SHALL support only INSERT (enforced by trigger/permission, never UPDATE or DELETE except via the retention sweeper §3.7).
- **FR-DM-9:** The data layer SHALL sit behind a `Repository` interface so SQLite→Postgres is a config swap with no caller changes (ADR §7/§17 seam).

#### Acceptance criteria — stores
- Deleting the entire Redis instance and restarting reconstructs all queues, schedules, and live meters from SQLite with no lost durable state (in-flight runs resume from their JSONL checkpoint).
- A full-text and binary scan of transcripts, audit log, Yjs docs, and the object store finds zero plaintext API keys or refresh tokens.
- The audit log rejects any UPDATE/DELETE issued outside the retention sweeper.

### 3.5 Source of truth & conflict resolution across desktop/mobile

This is the heart of "state management" and the critique's §1.6/§1.11 reconciliation. The decisions are fixed by ADR §12 and invariant #8: **mobile is a thin client, not an on-device agent; sync is relay-first with Yjs as the default CRDT; P2P is an optional later transport.**

**Topology.** Exactly one process — the **desktop Maestro Core** — owns the SQLite source of truth and runs the agents. The phone (RN/Expo) is a *view + intent* surface. Both open an *outbound* E2EE WebSocket to a dumb self-hosted relay (forked Happy Coder, X25519/ECDH + AES-256-GCM). State flows as Yjs updates over that relay.

**Authority model (who wins):**

| State class | Authority | Conflict resolution | Rationale |
|---|---|---|---|
| **Canonical relational facts** (a Project's caps, a Job's schedule, a Session's outcome) | Desktop Core's SQLite | Desktop Core is the single writer; the phone proposes, the Core validates + commits | Money, schedules, and run outcomes must be transactional, not eventually-consistent |
| **Live view / intent state** (which gate is open, a draft instruction being edited, scheduler board ordering, marketplace browse state) | Yjs doc, multi-writer | **CRDT automatic merge** (Yjs Y.Map/Y.Array LWW + sequence CRDT); last-writer-wins per field, structural merge for lists/text | These are genuinely concurrent edits across two of the *same operator's* devices; CRDT is the right tool and conflicts are benign |
| **Human gate decisions** (approve/reject/edit/respond) | Desktop Core | **First-decision-wins, idempotent.** A gate carries a one-time decision token; whichever device answers first commits; the loser's tap is a no-op acknowledged with the already-recorded decision | The operator might approve from the phone and the desktop near-simultaneously; the action must fire exactly once |
| **Secrets** | Keychain (desktop) | Never synced | Agent-invisible; the phone requests an *action* that uses a key, it never receives the key |
| **Transcripts** | Desktop Core (JSONL) | Append-only, streamed to phone read-only | The phone tails a run; it never authors transcript turns |
| **Budget counters** | Redis (desktop), reconciled to SQLite ledger | Atomic decrement on the Core; phone shows a synced *read* of the meter | A cap is a hard gate; it cannot be approximate or racy |

**The reconciliation in one sentence:** *the phone never holds authority over money, schedules, secrets, or run outcomes — those are single-writer on the desktop Core; the phone holds authority only over its own intent, and CRDT merge handles the benign concurrent edits between the operator's own devices.* Because there is only one operator, "conflicts" are almost always the same person on two screens, which is exactly the case CRDTs handle cleanly and which removes any need for multi-user conflict UX.

**Offline behavior.** The phone works offline against its local Yjs replica (`op-sqlite`/MMKV persistence): it can browse synced state, queue intent (e.g. "approve this gate when reconnected"), and draft instructions. On reconnect, Yjs merges intent into the Core, which validates and commits transactionally; any intent that fails validation (e.g. an approval for a gate that already timed out, or a cap that's since been exceeded) surfaces as a rejected-intent notification rather than silently corrupting state. The desktop Core continues running agents whether or not the phone is connected — the phone is a leash, not a leg (ADR §12, invariant #8).

**Why not multi-master SQLite / why not Automerge default.** Multi-master SQLite would reintroduce write conflicts on money and schedules — exactly what we forbid. Automerge 3.0 is *reserved* (ADR §12) for versioned/branching subsystems (e.g. instruction history, where Git-like history is valuable); Yjs is the default for live view state because of its mature `y-websocket`/RN ecosystem. Both sit behind a `SyncProvider` interface so the choice is swappable per-doc.

#### Acceptance criteria — sync/conflict
- Approving the same gate from desktop and phone within the same second fires the underlying action exactly once; the second device shows "already approved."
- Editing a Project instruction on the phone while offline and on the desktop while online, then reconnecting, merges both edits (CRDT) with no lost keystrokes and no manual conflict prompt.
- With the phone fully offline, a scheduled Job still fires, runs, and completes on the desktop; the result appears on the phone on reconnect.
- Pulling the network mid-run never corrupts the budget ledger; on reconnect the phone's meter matches the desktop's authoritative SQLite ledger to the cent.

### 3.6 The unified ledger and audit log (cross-cutting, single-owner)

Two append-only records are first-class members of the data model, each with exactly one owner (invariant #6, ADR §16) — replacing the per-subsystem fragmentation the critique called out (critique §2.3, §2.4, §2.7).

**Unified budget ledger** (one service, `BudgetLedger`): every cost-incurring event — LLM tokens × effort multiplier, container-hours (~$0.05/hr), session-hours (~$0.08/hr), web search (~$10/1K), image ($0.005–0.24), **video (a single 4K+audio minute ≈ $35–45)**, avatar minutes, Remotion render licensing, per-platform publishing costs (X's ~$0.20/URL trap) — is written as a ledger entry keyed to its Session → Job → (Sub-)project → Workspace. The ledger is the authoritative spend record; Redis counters are the fast live-meter projection of it. Caps are enforced against the ledger; breaches return hard 429s (ADR §16). The ledger exists solely to protect the single operator from bill-shock — **there is no billing, invoicing, take-rate, or monetization** (ADR §0, invariant #1).

**Append-only audit log:** every tool call, comms send, publish, gate decision, key access (the *fact* of access, never the secret), config/template change, and spend event is recorded immutably with a monotonic sequence number and a hash chain (each entry includes the prior entry's hash → tamper-evident). It is recorded at the level where it happens and is never inherited or merged. It doubles as the reliability-forensics and self-accountability record and is exportable as JSONL.

#### Acceptance criteria — ledger/audit
- The sum of all ledger entries under a Project equals that Project's reported spend, and never exceeds its hard cap; a run that would breach the cap is halted with a 429 before the cost is incurred.
- Every outbound publish and every comms send has a corresponding audit entry with its gate decision; deleting or altering any audit entry breaks the hash chain and is detectable.

### 3.7 Retention & deletion semantics (including CRDT history)

Deletion must reach *every* store, including the two that resist it: append-only logs and CRDT history (critique §1.9 — "right to be forgotten across CRDT history + audit logs"). Even single-user, the operator must be able to truly purge data (e.g. a sensitive project, a cloned-voice asset under biometric-consent withdrawal — ADR §14).

| Store | Default retention | Deletion semantics |
|---|---|---|
| **SQLite relational** | Lifetime of the entity | Hard cascade delete on entity removal (FK `ON DELETE CASCADE`): deleting a Project removes its Sub-projects, Jobs, Sessions, schedule defs, inheritance rows |
| **JSONL transcripts** | Operator-configurable per Project (default: keep; option: N days) | Deleted with the Session/Job; a retention sweeper purges expired transcripts from the object store |
| **Redis** | Ephemeral (TTL on counters; queue entries cleared on completion) | Wiped on deletion; rebuildable from SQLite |
| **Yjs CRDT docs** | Bounded — see below | The **hard problem**: see CRDT-specific handling |
| **OS Keychain** | Lifetime of the credential | Hard delete on key removal; revocation triggers token-refresh-service cleanup of metadata |
| **Append-only audit log** | Long (compliance/forensics) horizon, operator-configurable | **Never UPDATE/DELETE in place.** Purge is a *retention-sweeper* operation only: entries older than the horizon are removed in whole hash-chain-segments, re-anchoring the chain, so tamper-evidence is preserved for what remains. Subject-erasure (e.g. a person's biometric data) redacts the *payload* but keeps the *event skeleton* + a tombstone, so the audit trail still proves "an asset was deleted on date X" without retaining the sensitive content |
| **Object store (media/skills)** | Operator-configurable | Content-addressed delete; reference-counted so a blob shared by two Sessions is removed only when the last reference drops |

**CRDT history — the specific mechanism.** A naive Yjs doc grows unboundedly and *retains deleted content in its history* (you can resurrect old states), which directly conflicts with true deletion. Maestro handles this three ways:
1. **Periodic snapshot + compaction.** Live-view Yjs docs are compacted on a schedule: the current state is snapshotted, the update history is discarded, and a fresh doc is seeded from the snapshot. Because SQLite is the source of truth, discarding Yjs history loses nothing canonical — it only drops the merge log, which is what we *want* to drop for deletion.
2. **Doc destruction on entity deletion.** Deleting a Project destroys its associated Yjs docs entirely (on every device, propagated as a tombstone over the relay) rather than tombstoning fields within a retained doc — so deleted content cannot be reconstructed from CRDT history.
3. **Versioned subsystems use Automerge deliberately.** Where the operator *wants* history (e.g. instruction-edit history with Git-like time travel), that subsystem opts into Automerge 3.0 explicitly (ADR §12) and its retention/erasure is governed by an explicit "prune history before date X" operation — history is a feature there, not an accident.

This makes deletion **complete and provable**: after deleting an entity, no store — relational, transcript, queue, CRDT live doc, CRDT history, or object blob — retains its content, and the audit log retains only a content-free tombstone proving the deletion occurred.

#### Functional requirements — retention/deletion
- **FR-DM-10:** Deleting any entity SHALL cascade across SQLite, transcripts, Redis, Yjs docs (including history via compaction/destruction), and reference-counted object blobs, leaving only a content-free audit tombstone.
- **FR-DM-11:** Yjs live-view docs SHALL be periodically compacted so CRDT history cannot be used to resurrect deleted content; canonical state SHALL be reseedable from SQLite after compaction.
- **FR-DM-12:** The audit log SHALL support subject-payload redaction (for biometric/consent withdrawal — ADR §14) while preserving the tamper-evident event skeleton and hash chain.
- **FR-DM-13:** Retention horizons SHALL be operator-configurable per Project (transcripts) and globally (audit), with safe defaults.

#### Acceptance criteria — retention/deletion
- After deleting a Project, no transcript, Yjs doc (current or historical), Redis entry, or media blob belonging to it can be recovered on any paired device; only a tombstone remains in the audit log.
- Compacting a Yjs view doc preserves the current synced state on all devices but makes prior (including deleted) states unrecoverable.
- Withdrawing biometric consent for a cloned voice deletes the voice asset and redacts its content from the audit payload, while the audit log still proves the deletion happened and when.

### 3.8 Non-goals for this section (single-user scope guard)

Explicitly OUT OF SCOPE for the data model, per ADR §0 and invariant #1 — stated here so no future contributor re-introduces them:
- **No `Org`/tenant/team/workspace-membership entity.** Workspace is the top and only root; it has no members, owners, or roles. No `user_id`/`org_id`/`tenant_id`/`seat`/`role` columns.
- **No RBAC / permission grants between users.** "Permissions" in this section means *agent autonomy mode* (plan-mode etc.), never inter-user access control.
- **No billing/monetization/marketplace-economy tables.** The ledger is bill-shock protection only; the skill registry is a personal package index (npm-for-skills) with no price, payout, transaction, or entitlement tables (ADR §9).
- **No multi-master authority over money/schedules/secrets.** The desktop Core is the single writer for canonical facts; the phone never holds that authority.

These non-goals are what keep the schema clean: the absence of the tenancy/billing/identity layer is not a missing feature — it is the single-user invariant expressed in the data model itself.


## 4. Agent Engine, Model Layer & Core Agent Loop

> **Scope anchor.** This section specifies module **E1 (Agent Runtime / Engine Abstraction)** and the model-routing portion of **F3**, plus the parity slice of **E5 (Orchestration)** that constitutes the "core agent loop." It satisfies requirements **AE-1 … AE-6** from the decomposition. It is governed by ADR §3 (engine + tiers + eval gate), §4 (router), §5 (effort), §6 (OAuth), §10 (loop), and the canonical hierarchy in §7. Every model ID, price, and ToS fact below is **point-in-time mid-2026 config**, not a constant — it is re-verified at build time against the live Vendor Register (ADR §16.4). The single binding rule that overrides all of them: **no subsystem ever names a raw model ID; it requests a logical role through the router** (Binding Invariant #2).
>
> **Single-operator scope.** The operator is the sole user. There is no multi-tenancy, no "whose key" problem, no seat/role model. OAuth here is a *connectivity* feature (signing the operator into their own provider accounts), never an identity product (ADR §0, §6).

### 4.1 Overview & Design Intent

The agent engine is the spine of Maestro: `F1 → F2/F3 → **E1** → D1 → D2` (decomposition §6). Everything downstream — projects, scheduler, comms, studio, publishing — calls into E1. Two decisions define it:

1. **We do not reimplement the agent harness.** We embed the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, the same engine that powers Claude Code) inside the Maestro Core process and inherit sessions, subagents, hooks, MCP, permission modes, and streaming for free (AE-1, AE-5).
2. **No model ID is ever hard-coded.** All model selection flows through a **self-hosted LiteLLM router** keyed on *logical roles* (`builder`/`driver`/`subagent`/`reviewer`), so the volatile model line (Opus revved 4.5→4.7→4.8 in ~2 months; the reviewer ID disagreed across our own research) is a config edit, never a code change (AE-6).

The "Claude builds, GPT reviews" headline is treated as a **hypothesis to be proven**, not a given. The reviewer ships on-by-default *only if* it clears an eval gate (§4.5). The core build→review→merge loop itself is **table-stakes parity** — Conductor, Cursor, Warp, and Factory already ship it for free — so we *match it, we do not pitch it* (§4.7). Maestro's moat is everywhere else (scheduler, mobile, comms, studio); the engine's job is to be correct, cheap, observable, and swappable.

### 4.2 Claude Agent SDK — The Embedded Primary Engine (AE-1, AE-5)

**Decision (ADR §3):** Build E1 on the Claude Agent SDK behind a thin adapter over the **stable V1 `query()` API**. Do **not** depend on the V2 session preview (unstable, flagged for removal). The SDK runs in-process inside Maestro Core (a UI-agnostic Node service, ADR §2), which is the decisive reason Maestro ships on Electron rather than Tauri — the SDK and Node MCP servers run with zero sidecar/SEA packaging pain (ADR §1).

Inherited capabilities, mapped to requirements:

| SDK capability | What Maestro gets | Requirement |
|---|---|---|
| **Sessions** (resumable/forkable JSONL transcripts) | The native, replayable run-history format; **the resume point for the durable scheduler** (ADR §8). Maps directly to the Job→Session entity (ADR §7). | AE-5 |
| **Subagents** (`AgentDefinition`) | Programmatic fan-out workers; cheap Haiku-4.5 subagents for classification/routing/comms (§4.3). | AE-5 |
| **Lifecycle hooks** (PreToolUse / PostToolUse / etc.) | The enforcement point for loop guards, audit logging, and HITL gating *before* a tool fires. | AE-5, AE-4 |
| **MCP client** (stdio / SSE / HTTP / in-process) | Native tool/skill attachment — but **routed through the mandatory MCP Gateway** (ADR §2/§9), never direct. | AE-5 (→ E2/E3) |
| **Six permission modes incl. plan mode** | The plan-mode gate (§4.7) and the layered-autonomy ladder (§4.8). | AE-5 |
| **Streaming** | Token-level streaming over the typed RPC contract to desktop renderer and (over the relay) mobile. | AE-5 |

**Functional Requirements**

- **FR-E1-1 (AE-1):** E1 SHALL embed `@anthropic-ai/claude-agent-sdk` in Maestro Core via a `query()`-based adapter and SHALL NOT depend on the V2 session preview API.
- **FR-E1-2 (AE-5):** E1 SHALL expose Sessions, Subagents, Hooks, MCP, all permission modes (incl. plan mode), and streaming through the `AgentEngine` interface (`plan / build / review / stream / resume`).
- **FR-E1-3:** E1 SHALL persist each Session as a resumable JSONL transcript, usable as the scheduler's checkpoint/resume point (ADR §8) and as replayable run history (ADR §16).
- **FR-E1-4 (AE-6):** E1 SHALL sit behind the `AgentEngine` interface so that **OpenHands (MIT, self-hosted)** is a drop-in fallback for Anthropic-outage / offline / air-gapped operation (ADR §17).
- **FR-E1-5:** All MCP/tool traffic from the engine SHALL route through the mandatory MCP Gateway; E1 SHALL NOT open direct MCP connections to third-party servers (ADR §2/§9).

**Acceptance Criteria**

- **AC-E1-1:** A Session interrupted by process kill / OS sleep resumes from its last JSONL checkpoint and completes — verified by killing the worker mid-build and observing completion-from-checkpoint (not from zero).
- **AC-E1-2:** Swapping the engine config from `claude-agent-sdk` to `openhands` runs the same golden task to completion with **no caller code change** (interface-only swap).
- **AC-E1-3:** A skill/MCP tool call appears in the MCP Gateway audit log *before* it executes; a denied tool is blocked at the PreToolUse hook and recorded.
- **AC-E1-4:** Plan mode produces a plan artifact and **halts at a human checkpoint** before any file write or tool execution (§4.7).

### 4.3 Model Tiers — Exact IDs, Prices, Roles

**Decision (ADR §3).** Mid-2026 config, $/MTok in/out. These are **defaults written into router config, not constants in code** (§4.4). Caching + Batch are *mandatory* on Claude (§4.6).

| Logical role | Model | ID | Price (in/out) | Context | Notes |
|---|---|---|---|---|---|
| **builder** | Claude **Opus 4.8** | `claude-opus-4-8` | **$5 / $25** | 1M (200k on Foundry) | 128k output; adaptive thinking; effort default `high`, use `xhigh` for hard coding/agentic work; Jan 2026 cutoff; released May 28 2026. **`budget_tokens` removed (HTTP 400) — use adaptive thinking + effort.** |
| **driver** | Claude **Sonnet 4.6** | `claude-sonnet-4-6` | **$3 / $15** | 1M | Most production turns / sub-project orchestration — the default workhorse. |
| **subagent** | Claude **Haiku 4.5** | `claude-haiku-4-5` | **$1 / $5** | 200k | Classification, routing, comms, cheap fan-out (§4.2 subagents). |
| **reserve** (meter carefully) | Claude **Fable 5** | `claude-fable-5` | **$10 / $50** | 1M | GA June 9 2026; always-on adaptive thinking; **new tokenizer ≈ +30% tokens**; 30-day retention only. **Behind explicit opt-in + budget gate** (ADR §3). |
| **reviewer** (primary) | **GPT-5.1** | `gpt-5.1` | **$1.25 / $10** (cached in $0.125) | ~1.05M | OpenAI Responses API; `reasoning_effort` + **low `verbosity`** for terse rigorous critiques; full PR fits in context. |
| **reviewer** (code diffs) | **GPT-5.1-Codex-Max** | (config) | — | — | Reached for **only** when the reviewer must read the repo / run read-only commands; otherwise the cheaper plain reviewer is used (§4.5). |

**Tiering rationale.** The builder/driver/subagent split mirrors the validated Aider architect/editor cost-split (a high-capability model plans, a cheaper model executes the bulk). The driver (Sonnet 4.6) — *not* the builder — handles most turns; Opus 4.8 is reserved for hard planning/agentic work where its lift is real, because **high/xhigh effort is flat-or-worse on many tasks at 4–17× cost and 5–60× latency** (the "effort paradox," §4.6/§ADR-5).

> **Reviewer-ID volatility — explicit.** Our own research disagreed on the reviewer (GPT-5.1 at $1.25/$10 in one synthesis, GPT-5.5 at $5/$30 in another; GPT-5.6 already teased; GPT-5.2/5.3 deprecated for sign-in). Per the binding ADR, **the reviewer ID is config with a fallback chain, never hard-coded**, and `gpt-5.1` is the current default pending re-verification at build time.

**Functional Requirements**

- **FR-MT-1:** The router config SHALL define exactly the logical roles `builder / driver / subagent / reserve / reviewer`, each mapped to a concrete provider+ID + fallback chain.
- **FR-MT-2:** The `reserve` (Fable 5) role SHALL be unreachable without an explicit per-Job opt-in and a budget check, owing to its $10/$50 price and ~+30% tokenizer inflation.
- **FR-MT-3:** The abstraction SHALL NOT emit `budget_tokens` for Opus 4.7/4.8/Fable (removed → HTTP 400); it SHALL use adaptive thinking + `effort` (§4.6).
- **FR-MT-4:** Default routing SHALL place most production turns on `driver` (Sonnet 4.6), escalating to `builder` (Opus 4.8) only on plan-mode / verified-hard work.

**Acceptance Criteria**

- **AC-MT-1:** Editing the `builder` mapping from `claude-opus-4-8` to any other ID changes the model used at runtime with **no rebuild and no engine code change**.
- **AC-MT-2:** A Job that does not opt into `reserve` can never dispatch to `claude-fable-5` (router rejects the role).
- **AC-MT-3:** A request that targets Opus 4.8 with a legacy `budget_tokens` param is rewritten to adaptive-thinking+effort before egress (no HTTP 400 reaches the provider).

### 4.4 Provider-Abstraction Router — LiteLLM, No Hard-Coded IDs (AE-6)

**Decision (ADR §4).** A single **self-hosted LiteLLM** gateway sits in front of Claude, GPT, and any image/video text endpoints. Callers request a **logical role or capability tag**; LiteLLM maps role → concrete provider+ID from config, enforces budgets, and provides failover. **LiteLLM *is* the seam** that makes the entire volatile model line swappable (AE-6).

**Why a router, not direct SDK calls:** it is the one component that simultaneously (a) kills hard-coded IDs, (b) enforces per-project virtual budgets (`max_budget` / `budget_duration`), (c) kills runaway loops (`max_iterations` + `max_budget_per_session`), (d) enforces caching + Batch (§4.6), and (e) provides provider failover and auto-downgrade near caps — implementing the bill-shock NFRs (ADR §16) in one place.

| Concern | Enforced at the router | Source |
|---|---|---|
| Logical-role → model-ID mapping | `complete(role, messages, effort) → stream` | ADR §4 |
| Per-project virtual budget | `max_budget` / `budget_duration` per logical key | ADR §4/§16 |
| Loop kill | `max_iterations` + `max_budget_per_session` | ADR §4/§16 |
| Hard cap behavior | **Returns 429 to the caller on cap exceed** | Binding Invariant #6 |
| Caching + Batch | Mandatory on eligible Claude calls (§4.6) | ADR §4 |
| Failover / auto-downgrade | Provider fallback chain; downgrade near caps | ADR §16/§17 |
| `bypassPermissions` | **Never shipped** | ADR §4 |

**Functional Requirements**

- **FR-RT-1 (AE-6):** All LLM calls from every subsystem SHALL pass through the router by **logical role or capability tag**; no subsystem SHALL name a raw model ID (Binding Invariant #2).
- **FR-RT-2:** The router SHALL enforce per-Project hard caps and SHALL return **HTTP 429** to the caller when a cap is exceeded (no soft/advisory caps).
- **FR-RT-3:** The router SHALL enforce `max_iterations` and `max_budget_per_session` loop guards on every session.
- **FR-RT-4:** The router SHALL be swappable behind a `Router` interface (`complete(role, messages, effort) → stream`); if LiteLLM is replaced, Core code SHALL NOT change.
- **FR-RT-5:** The router SHALL provide a provider fallback chain per role and auto-downgrade to a cheaper model as a Project approaches its cap.

**Acceptance Criteria**

- **AC-RT-1:** No grep of `packages/engine` or any caller package matches a literal model ID (`claude-*`, `gpt-*`) — IDs exist only in router config.
- **AC-RT-2:** A Project that reaches its hard cap receives a 429 on the next LLM call; the Job halts at a budget gate rather than overspending.
- **AC-RT-3:** A session exceeding `max_iterations` is terminated by the router with a loop-guard event recorded in the budget ledger and audit log.
- **AC-RT-4:** Disabling the primary provider for a role causes the router to fail over to the next entry in that role's chain without caller awareness.

### 4.5 The GPT Reviewer & the Eval-Gating Plan (AE-2)

**Decision (ADR §3, Binding Invariant #11).** The cross-vendor GPT reviewer is a **hypothesis, not a pillar.** Independent benchmarks show Claude already leads SWE-bench with lower hallucination, so the reviewer's *lift* over builder-only is **unproven**. The reviewer ships **on-by-default only if it clears the eval gate**; otherwise it becomes an opt-in DEEP/MAX-only pass, and the ADR is amended to say so. **The reviewer is droppable.**

**The eval gate (must run before the reviewer is on by default):**

1. **Golden-task harness.** Assemble a representative set of Maestro jobs — code *and* creative — each with a known-good outcome (ties to the reliability/testing workstream).
2. **A/B every task.** Run **builder-only** vs **builder + GPT reviewer loop**, measuring four signals: **defect-catch rate, false-positive rate, added latency, added $ cost.**
3. **Gate decision.** The reviewer ships **on-by-default iff** it catches real, otherwise-missed defects at acceptable cost. If lift is marginal → demote to opt-in DEEP-mode pass. Record the result and amend the ADR.

**Reviewer mechanics.** GPT-5.1 over the OpenAI Responses API, `reasoning_effort` set by the Effort tier (§4.6), **low `verbosity`** for terse rigorous critiques; ~1.05M context fits a whole PR. The reviewer escalates to **GPT-5.1-Codex-Max only when it must read the repo / run read-only commands** (otherwise the cheaper plain reviewer is used). The reviewer routes through the **same MCP Gateway** as the builder (Binding Invariant #4) — it does not get a privileged side channel. For irreversible decisions (auto-merge / auto-publish) a single LLM judge is adversarially manipulable, so a **panel-of-judges (PoLL)** is reserved for those (ADR §10), not a lone reviewer.

**Functional Requirements**

- **FR-RV-1 (AE-2):** A `Reviewer` strategy SHALL run a build→review→fix loop, with the reviewer model selected via the `reviewer` logical role (router-routed, never hard-coded).
- **FR-RV-2:** The reviewer SHALL be **disabled by default until the eval gate passes**; its default-on state is a recorded gate outcome, not an assumption.
- **FR-RV-3:** The reviewer SHALL route all repo/tool access through the MCP Gateway and SHALL use `GPT-5.1-Codex-Max` only when repo-read / command-run is required.
- **FR-RV-4:** Auto-merge / auto-publish decisions SHALL use a judge panel (PoLL), not a single reviewer.

**Acceptance Criteria**

- **AC-RV-1:** The golden-task harness produces a per-task table of {defect-catch, false-positive, latency, $} for builder-only vs builder+reviewer, and the reviewer's default-on flag is derived from it.
- **AC-RV-2:** With the reviewer enabled, an injected known defect in a golden task is caught and fixed in the loop; with it disabled, the same defect ships — demonstrating measurable lift (or its absence).
- **AC-RV-3:** The reviewer cannot reach any MCP tool except through the gateway (verified by audit log; no direct connections).

### 4.6 Switchable Effort & Caching/Batch Enforcement (AE-4)

**Decision (ADR §5).** A normalized `Effort` enum **{FAST, BALANCED, DEEP, MAX}** is a first-class dial on every Job/Session, **independently settable for the build pass and the review pass** (AE-4). The router translates it to per-vendor params via a single mapping table. **Default is BALANCED**, not DEEP/MAX — the effort paradox makes naive "more effort = better" actively harmful to the operator's bill and latency.

| Maestro effort | Claude (`output_config.effort` + adaptive thinking) | OpenAI (`reasoning_effort`) | Reviewer interaction |
|---|---|---|---|
| **FAST** | `low`, adaptive thinking | `low` / `minimal` | Review **off** by default |
| **BALANCED** *(default)* | `medium` / `high` | `medium` | Light review (pre-screen) |
| **DEEP** | `high` / `xhigh` | `high` | Full reviewer loop (if eval-gated on) |
| **MAX** | `xhigh` / `max` | `high` + larger budget | Full reviewer loop + optional judge panel |

**Effort-paradox guardrail (mandatory):** escalation to DEEP/MAX is **opt-in per Job** or **auto-escalated only on eval-verified-hard task types** driven by reasoning-token telemetry (ADR §16); the UI **always surfaces the cost/latency multiplier before** a DEEP/MAX run; **plan mode = DEEP + human checkpoint**, execution = BALANCED/FAST.

**Caching + Batch — mandatory on Claude (ADR §4).** The router SHALL apply **prompt caching (~90% off cached input reads)** and the **Batch API (−50%)** on every eligible scheduled/background/eval call. These are not optional optimizations; they are enforced policy.

**Functional Requirements**

- **FR-EF-1 (AE-4):** Effort SHALL be settable independently for build and review passes, at the Job/Session level, overriding the Project default (inheritance per ADR §7).
- **FR-EF-2:** The default effort SHALL be BALANCED; DEEP/MAX SHALL require explicit per-Job opt-in or telemetry-driven auto-escalation on verified-hard task types.
- **FR-EF-3:** The UI SHALL display the cost/latency multiplier *before* executing a DEEP/MAX run.
- **FR-EF-4:** The router SHALL enforce prompt caching + Batch API on all eligible Claude calls (scheduled/background/eval).
- **FR-EF-5:** Plan-mode runs SHALL default to DEEP effort with a human checkpoint; execution runs SHALL default to BALANCED/FAST.

**Acceptance Criteria**

- **AC-EF-1:** Setting build=FAST, review=DEEP on one Job dispatches `effort=low` to the builder and `reasoning_effort=high` to the reviewer in the same run.
- **AC-EF-2:** A DEEP run shows the estimated cost/latency multiplier to the operator before any token is spent.
- **AC-EF-3:** A scheduled background Job's Claude calls show prompt-cache reads and Batch dispatch in the budget ledger; a non-cached/non-batched eligible call is flagged as a policy violation.
- **AC-EF-4:** Adding a new vendor requires only a new column in the effort mapping table — no caller change.

### 4.7 The Core Agent Loop — Table-Stakes Parity (AE-5)

**Positioning (Binding Invariant — research §2c).** Worktree-per-agent isolation + plan-mode gate + review/merge-to-PR is **commoditized parity** — Conductor (our closest competitor) ships it for free; Cursor's `/worktree`, `/apply-worktree`, `/best-of-n` define the UX bar. We **match it, we do not market it.** Maestro's differentiation lives in the scheduler, mobile push, comms, and studio — not here.

**The loop (ADR §10), default single-agent-with-tools:**


Plan  (Claude builder, DEEP + human checkpoint)
  → Build  (Claude driver/builder, in an isolated git worktree)
  → Review (GPT reviewer — IF eval-gated on, §4.5) → findings → fix loop → (clean | gate)
  → HITL gate (desktop / mobile / Telegram) on any sensitive/irreversible action
  → Merge-to-PR

- **Git worktree-per-agent isolation.** Each agent/Job gets its own worktree+branch (D1, ADR §7), so parallel jobs never collide. Copy Conductor's per-workspace setup-script convention and Cursor's worktree command UX.
- **Plan-mode gate.** Plan mode is DEEP + a durable human checkpoint *before* any write or tool execution — the operator approves the plan first (AE-5).
- **Review → merge-to-PR.** On a clean review (or operator approval at the gate), changes land as a PR, not a force-push.
- **Multi-agent only when provably breadth-first.** Single-agent-with-tools is the default; fan-out (map-reduce) is reserved for unknown-item-count work; multi-agent costs ~15× tokens and each hierarchy level adds ~2s before workers start (bad for mobile/comms UX), so hierarchies stay **shallow**.

**Functional Requirements**

- **FR-LP-1:** Each agent Job SHALL execute in an isolated git worktree + branch; parallel Jobs SHALL NOT share a working tree.
- **FR-LP-2 (AE-5):** Plan mode SHALL produce a plan and halt at a **durable** human checkpoint (survives restart) before any write/tool execution.
- **FR-LP-3:** A clean review (or approved gate) SHALL land changes as a PR; the loop SHALL NOT auto-force-push.
- **FR-LP-4:** The loop SHALL default to single-agent-with-tools and SHALL escalate to fan-out/multi-agent only on explicit breadth-first declaration.
- **FR-LP-5:** HITL gates SHALL be durable (survive restart) and offer approve / edit / reject / respond, deliverable to desktop / mobile / Telegram (ADR §10/§12).

**Acceptance Criteria**

- **AC-LP-1:** Two Jobs running concurrently operate in distinct worktrees with no cross-contamination of files or branches.
- **AC-LP-2:** A plan-mode Job restarted mid-checkpoint resumes *at the still-open gate* (gate is durable), then proceeds only after approval.
- **AC-LP-3:** An approved review produces a PR; no commit reaches a protected branch without passing the gate.
- **AC-LP-4:** A HITL gate raised on the desktop can be approved from the phone over the relay, and the loop continues (cross-surface gate delivery).

### 4.8 Native OAuth (PKCE Loopback) for Both Providers (AE-3)

**Decision (ADR §6).** **Authorization Code + PKCE with a loopback redirect (`http://127.0.0.1:<random-port>`) is the DEFAULT** for Anthropic and OpenAI (and every provider that supports it); a custom-scheme deep link (`maestro://oauth/...`) is the secondary path for providers that reject loopback. All access/refresh tokens **and** BYO API keys live in the **OS keychain** via the `PlatformAdapter`: **macOS Keychain / Windows DPAPI / Linux libsecret**.

**Single-operator framing.** There is **no "whose key" problem** — the operator's own provider keys/tokens are theirs (ADR §0/§6). OAuth here is *connectivity* (sign the operator into their accounts), not an identity product. **We never resell or share consumer Claude/Codex subscription OAuth** — Anthropic banned third-party tools that did it (OpenClaw, OpenCode, Roo Code, Goose) since Jan 2026, and it is out of scope regardless.

**Agent-invisible secrets posture (mandatory, ADR §6/§16).** The agent **uses** a credential it **never sees** — the keychain secret is injected at egress by an in-process accessor, surviving prompt injection (the lethal trifecta). Secrets are never written to app config, SQLite, or plaintext.

**Functional Requirements**

- **FR-OA-1 (AE-3):** OAuth SHALL default to Authorization Code + PKCE with a random-port loopback redirect; custom-scheme deep link is the documented fallback.
- **FR-OA-2:** All OAuth tokens and BYO API keys SHALL be stored in the OS keychain via `SecretStore`; none SHALL be persisted in config/SQLite/plaintext.
- **FR-OA-3:** A token-refresh service SHALL own refresh lifecycle (e.g., handling short provider expiries) behind the `OAuthProvider` registry.
- **FR-OA-4:** The agent SHALL never receive a raw secret value; credentials SHALL be injected agent-invisibly at the provider call boundary.
- **FR-OA-5:** Maestro SHALL NOT use consumer-subscription OAuth on behalf of the operator for headless/programmatic provider access (ToS).

**Acceptance Criteria**

- **AC-OA-1:** Signing into Anthropic and OpenAI completes via a loopback PKCE flow with no client secret on device and no inbound port opened.
- **AC-OA-2:** A filesystem/SQLite scan after sign-in finds no plaintext token or key; the keychain holds them.
- **AC-OA-3:** A prompt-injection test instructing the agent to "print your API key" yields no secret — the agent has no access to the raw value.
- **AC-OA-4:** An expired access token is transparently refreshed by the refresh service without operator intervention.

### 4.9 Requirements Traceability

| Req (decomposition) | Covered by | Key acceptance |
|---|---|---|
| **AE-1** Claude Agent SDK as primary engine | §4.2 (FR-E1-1..5) | AC-E1-1, AC-E1-2 |
| **AE-2** GPT-class review model | §4.5 (FR-RV-1..4) | AC-RV-1, AC-RV-2 |
| **AE-3** Native OAuth for both providers | §4.8 (FR-OA-1..5) | AC-OA-1, AC-OA-3 |
| **AE-4** Switchable reasoning effort per job/session | §4.6 (FR-EF-1..5) | AC-EF-1, AC-EF-2 |
| **AE-5** Plan mode, permission modes, hooks, subagents, sessions, streaming | §4.2 (FR-E1-2), §4.7 (FR-LP-2) | AC-E1-4, AC-LP-2 |
| **AE-6** Provider-agnostic / role swap | §4.4 (FR-RT-1..5), §4.2 (FR-E1-4) | AC-RT-1, AC-MT-1, AC-E1-2 |

### 4.10 Non-Goals (this section)

- **No model resale / margin / metering-as-billing.** BYO-key; the operator pays providers directly; Maestro captures nothing (ADR §0). Cost governance (router caps, §4.4/§4.6) exists **solely** to protect the operator from bill-shock.
- **No multi-tenant key management, no "whose key" routing, no per-seat/per-role model access.** Single operator; one keychain (§4.8).
- **No identity product** — no SSO/SCIM/RBAC. OAuth is provider connectivity only (§4.8).
- **No hard-coded model IDs or vendor lock-in** anywhere in engine or caller code; everything routes through LiteLLM by logical role (§4.4).
- **The GPT reviewer is not a guaranteed feature** — it must earn default-on status through the eval gate, and is droppable (§4.5).
- **No reliance on Anthropic-hosted scheduling/credit constructs** for the engine's economics (consumer-subscription resale is banned and out of scope; §4.8).


## 5. Switchable Effort & Autonomy Controls

> **Requirement anchor:** AE‑4 ("Switchable reasoning effort per job/session, and review depth") — Must. Directly supported by AE‑5 (plan mode, permission modes, hooks, sessions), AE‑6 (provider-agnostic so roles can swap), and the engine module **E1 (Agent Runtime / Engine Abstraction)** with orchestration in **E5 (Workflow Engine)**. This section is **BINDING-compliant with ADR §5 (effort abstraction) and §10 (orchestration / HITL gates)**; where this PRD elaborates beyond the ADR it never contradicts it.
>
> **Scope note (single-operator):** Effort and autonomy are tools to spend *the operator's own* money and attention wisely. There is no per-seat/per-tenant policy engine, no admin-imposed effort ceiling for "other users," no billing-by-effort. Everything here is the operator dialing their own machine. All model IDs/prices below are **point-in-time mid-2026 config** to re-verify against the Vendor Register (ADR §16.4) at build time.

This section specifies two orthogonal but interacting dials Maestro exposes on every unit of work:

1. **Effort** — *how hard the model thinks* (reasoning budget / thinking depth / output verbosity), normalized as `{FAST, BALANCED, DEEP, MAX}`.
2. **Autonomy** — *how much the operator is asked before the agent acts* (plan‑mode → gated → unattended), enforced by HITL gates that are approvable from desktop, mobile, or Telegram.

They are independent: a job can run **MAX effort under tight plan‑mode gating** (deep thinking, ask-before-every-action) or **FAST effort fully unattended** (cheap, no interruptions). They are also independently settable for the **build pass** and the **review pass** of the plan→build→review loop (ADR §10).

---

### 5.1 The Effort Abstraction (FAST / BALANCED / DEEP / MAX)

The operator never sees raw vendor parameters. They pick a normalized `Effort` enum; the **router (E1 → LiteLLM, ADR §4)** translates it per-vendor in **one mapping table** (ADR §5 seam). This is the "effort is a dial, not a rebuild" tenet (decomposition §2.1) made concrete and keeps vendor churn (Opus 4.5→4.7→4.8 in ~2 months; reviewer ID moving monthly) out of the UX.

#### 5.1.1 Why normalize (the volatility that forces the abstraction)

The vendor parameter surface is unstable and divergent:

- **Anthropic** moved from an explicit `budget_tokens` thinking control to an **adaptive-thinking `effort` model**. On **Opus 4.7 / 4.8 / Fable 5, `budget_tokens` is removed and emitting it returns HTTP 400** — the abstraction **must never emit `budget_tokens` for those models** (ADR §5; research §4 risk row). Opus 4.8 ships with effort default `high`.
- **OpenAI** exposes `reasoning_effort ∈ {minimal, low, medium, high}` plus a separate `verbosity ∈ {low, medium, high}` on the GPT‑5.1 / 5.1‑Codex‑Max reviewer line.
- These two axes do not line up 1:1 (Anthropic folds depth into adaptive thinking + an effort label; OpenAI splits reasoning from output length), so a single normalized enum is the only stable contract callers can depend on.

#### 5.1.2 The normalized mapping table

| Maestro `Effort` | Claude builder/driver (`output_config.effort` + adaptive thinking) | OpenAI reviewer (`reasoning_effort` / `verbosity`) | Typical cost·latency vs BALANCED | Default review interaction |
|---|---|---|---|---|
| **FAST** | `low`, adaptive thinking on; no `budget_tokens` | `low` or `minimal` / `verbosity: low` | ~0.3–0.6× cost, fastest | Review **off** |
| **BALANCED** *(default)* | `medium`→`high` | `medium` / `verbosity: low` | 1× (baseline) | Light pre-screen review |
| **DEEP** | `high`→`xhigh` | `high` / `verbosity: low` | ~3–8× cost, 5–15× latency | Full reviewer loop *(if eval-gated on, §5.6)* |
| **MAX** | `xhigh`→`max`, larger budget | `high` + larger budget / `verbosity: low` | ~4–17× cost, up to 5–60× latency | Full reviewer loop + optional judge panel (ADR §10) |

Notes:
- **Reviewer `verbosity` is pinned `low` at every effort level** — the reviewer's job is a terse, rigorous critique, not prose. Verbosity is decoupled from reasoning effort: more thinking, still-short output (research §2a).
- The `→` ranges mean the router may pick the lower or upper bound within an effort band based on task-type telemetry (§5.5). The operator's enum choice sets the *band*; the auto-tuner trims *within* it.
- Each cell is **config** (a column in the mapping table). Adding a new vendor adds a column; changing effort semantics never touches callers (ADR §5 seam).

#### 5.1.3 Functional Requirements — Effort

- **FR‑EFF‑1 (AE‑4):** `Effort` is a first-class field on every **Job** and every **Session**, persisted in the canonical data model (ADR §7), defaulting to **BALANCED**.
- **FR‑EFF‑2:** The router translates `Effort` → per-vendor params via a single config table; **no caller (engine, workflow node, comms handler) ever names a raw vendor effort param** (ADR §4 invariant 2).
- **FR‑EFF‑3:** The abstraction **must not emit `budget_tokens`** for any model that has removed it (Opus 4.7/4.8/Fable 5); the mapping table marks per-model parameter support.
- **FR‑EFF‑4:** Reviewer `verbosity` is always `low`, independent of the reviewer's `reasoning_effort`.
- **FR‑EFF‑5:** Build-pass effort and review-pass effort are **separate fields** (§5.4); changing one never changes the other.
- **FR‑EFF‑6:** Every DEEP/MAX selection surfaces a **pre-run cost·latency multiplier estimate** sourced from the budget ledger (ADR §16) *before* the run starts.

#### 5.1.4 Acceptance Criteria — Effort

- **AC‑EFF‑1:** Given a Job set to MAX, when it runs against Opus 4.8, the outbound request contains the configured `effort` value and **never** a `budget_tokens` field; an integration test asserts no 400 from the removed-parameter class.
- **AC‑EFF‑2:** Given the reviewer ID is swapped in config from `gpt-5.1` to a fallback, no caller code changes and the effort mapping still resolves (proves the seam).
- **AC‑EFF‑3:** Selecting DEEP on a Job displays an estimate (e.g. "≈ $0.42, ≈ 40 s, ≈ 5× BALANCED") before the operator confirms.
- **AC‑EFF‑4:** Build pass = FAST and review pass = DEEP can coexist on one Session and route to the two different effort param sets.

---

### 5.2 Who Sets Effort — User, Scheduler, Auto-Tuner (precedence)

Three actors can set effort. They resolve by a strict, auditable precedence so a scheduled 3 a.m. job never silently escalates to a bill-shock tier without an explicit rule.

| Source | When it applies | Authority |
|---|---|---|
| **Explicit per-job/per-session override** (operator) | Operator sets it in UI / chat / mobile | **Highest** — always wins; pins the band |
| **Project Template default** | No explicit override; inherited from the Project (ADR §7 inheritance: Project → Job → Session) | Medium — the "mode-aware default" (§5.3) |
| **Scheduler policy** | Recurring/background jobs may carry their own default (e.g. a nightly batch defaults FAST to exploit Batch −50% + caching) | Medium — but **may never auto-escalate above the Project default without an explicit per-job override** |
| **Auto-tuner** | Trims *within* the chosen band, or proposes escalation on eval-verified-hard task types (§5.5) | **Lowest, advisory by default** — it may *narrow within band*; it may *escalate across bands only when the operator has armed auto-escalation for that task type* |

**Precedence rules (binding):**

- **FR‑WHO‑1:** Explicit operator override always wins and is recorded in the audit log (who/when/what band, ADR §7).
- **FR‑WHO‑2 (anti–bill-shock):** Neither the **scheduler** nor the **auto-tuner** may escalate a job *above* its inherited Project default band unless the operator has explicitly armed cross-band auto-escalation for that task type. Downward de-escalation (cheaper) is always permitted.
- **FR‑WHO‑3:** The auto-tuner's primary power is **within-band trimming** (e.g. `high` vs `xhigh` inside DEEP) and **proposing** a band change as a notification, not silently applying it (unless armed).
- **AC‑WHO‑1:** A nightly scheduled job inherits BALANCED; the auto-tuner detecting "this task type historically needs DEEP" produces a **notification/recommendation**, and the job still runs BALANCED unless auto-escalation was armed — verified by ledger + audit entry.

---

### 5.3 Mode-Aware Defaults (Project Templates set the resting effort)

The operator wears many hats via **Project Templates** (decomposition §4; ADR §0 — one user, not two personas). Each template ships a sensible **resting effort** and a **plan/execution split**, so the operator rarely touches the dial. This is the "mode-aware effort" must-have (research §5.6) that **Claude Code itself has not shipped natively (issue #50323)** — Maestro owns the orchestration.

| Project Template (example) | Plan-pass effort | Build-pass effort | Review-pass effort | Rationale |
|---|---|---|---|---|
| **Code** (Claude-Code) | DEEP (plan = think hard) | BALANCED | DEEP *(reviewer eval-gated)* | Planning + review benefit from depth; execution rarely does |
| **Design** (Claude-Design) | BALANCED | BALANCED | FAST/off | Iterative, visual feedback loop; depth pays off less |
| **Content / Studio** | BALANCED | FAST (drafts) → DEEP (hero) | off | Match the media draft/hero tiering (ADR §13) |
| **Research / Trends** | DEEP | BALANCED | BALANCED | Synthesis quality matters; per-claim verification is a judge job |
| **Comms / triage** (Haiku subagents) | FAST | FAST | off | High-volume, low-stakes classification/routing |

**Binding default (ADR §5):** **The global default is BALANCED, never DEEP/MAX.** "Maximum capability" ≠ maximum effort tokens on every task — that is precisely the effort paradox (§5.5). **Plan mode defaults to DEEP + a human checkpoint; execution defaults to BALANCED/FAST.**

- **FR‑MODE‑1:** Every Project Template declares plan/build/review resting efforts; the operator may edit per template.
- **FR‑MODE‑2:** A new Project Template inherits the Workspace global default (BALANCED) until edited.
- **AC‑MODE‑1:** Creating a "Code" project and running a job with no overrides produces a DEEP plan pass, a BALANCED build pass, and (if the reviewer is eval-gated on) a DEEP review pass — confirmed in the run transcript.

---

### 5.4 Independent Effort for Build vs Review

Per AE‑4 ("…and review depth") and the decomposition's Review-Model Loop (§8: "Effort is independently switchable for the build pass and the review pass"), **build effort and review effort are separate dials** on the same Session.


Plan (Claude builder, effort = P)
  → Build (Claude builder/driver, effort = B)
      → Review (GPT-5.1 reviewer, effort = R, verbosity = low)  [only if eval-gated on, §5.6]
          → findings → fix loop (builder at effort B) → (clean | gate)
              → HITL gate (desktop / mobile / Telegram)

- The **builder/driver** is Claude (`claude-opus-4-8` $5/$25 builder, `claude-sonnet-4-6` $3/$15 driver, `claude-haiku-4-5` $1/$5 subagents). The **reviewer** is GPT‑5.1 (`gpt-5.1`, $1.25/$10, cached-in $0.125) on the OpenAI Responses API, reaching for **GPT‑5.1‑Codex‑Max** only when the reviewer must read the repo / run read-only commands (ADR §3).
- Because the reviewer is a different vendor at a different price, **its effort is tuned independently** — typically the operator wants a *cheaper, terser, still-rigorous* critique (medium/high `reasoning_effort`, `verbosity: low`) even when the build pass is DEEP. Conversely, a fast build can still get a deep review on a sensitive merge.
- **Caching/Batch are mandatory** on eligible passes (ADR §3/§4): prompt caching (~90% off cached input reads) + Batch API (−50%) on scheduled/background/eval runs apply to *both* build and review legs.

**FR / AC:**
- **FR‑BR‑1:** `effort.build` and `effort.review` are distinct persisted fields; the workflow engine (E5) passes each to the router for the correct leg.
- **FR‑BR‑2:** The review leg only executes if the reviewer is enabled (eval gate, §5.6) **or** the operator forces it for that job.
- **AC‑BR‑1:** A job with `effort.build = FAST`, `effort.review = DEEP` produces a fast Claude build followed by a high-`reasoning_effort` GPT‑5.1 review with `verbosity: low`, each visible as a separate metered leg in the budget ledger.

---

### 5.5 The Effort Paradox Guardrail (eval-tuned defaults)

**The core economic risk this section exists to manage.** Research (synthesis §4 risk row; critique §1.3) and ADR §5 establish: **high/xhigh/MAX effort is flat-or-worse on many task types at 4–17× the cost and 5–60× the latency.** Naive "more effort = better" actively harms the single operator's bill and patience. Effort tokens are billed as output tokens, so MAX on a trivial task is pure waste.

**Guardrail policy (binding, ADR §5):**

1. **Default is BALANCED.** Escalation to DEEP/MAX is **opt-in** (explicit per-job override) **or** auto-escalated **only on eval-verified-hard task types**.
2. **The UI always surfaces the cost·latency multiplier** before any DEEP/MAX run (sourced from the budget ledger pre-run estimate, ADR §16) — e.g. "MAX ≈ 11× cost, ≈ 30× latency vs BALANCED. Confirm?"
3. **Plan mode = DEEP + human checkpoint by default; execution = BALANCED/FAST** (§5.3).
4. **Eval-tuned, not vibe-tuned.** The auto-tuner (closed loop, ADR §16) reads **per-job thinking/reasoning-token telemetry** (OTel GenAI conventions → Langfuse) and the golden-task eval harness (ADR §3) to learn, *per task type*, whether DEEP/MAX actually lifts a measurable quality metric enough to justify the multiplier. If lift is marginal, the default for that task type stays BALANCED.

**The closed loop:**

OTel GenAI reasoning-token telemetry  +  golden-task eval outcomes (defect-catch, quality delta)
        → auto-tuner computes per-task-type effort recommendation (within-band first)
        → writes default effort for that task type  (advisory; cross-band escalation only if armed)
        → surfaces "this task type didn't benefit from DEEP — recommend BALANCED" to the operator

**FR / AC:**
- **FR‑PAR‑1:** No DEEP/MAX run proceeds without a displayed pre-run cost·latency multiplier estimate.
- **FR‑PAR‑2:** The auto-tuner may not set a task-type default above BALANCED unless eval data shows a configured-threshold quality lift for that task type.
- **FR‑PAR‑3:** Reasoning-token consumption per job is recorded as first-class telemetry feeding the tuner (ADR §16).
- **AC‑PAR‑1:** For a task type where eval shows DEEP gives no measurable lift, the tuner's recommended default is BALANCED and the UI shows the rationale ("flat at +6× cost").
- **AC‑PAR‑2:** Triggering MAX on any job shows the multiplier and requires explicit confirmation; the confirmation is audit-logged.

---

### 5.6 Effort × Reviewer Interaction (and the reviewer eval gate)

Effort bands set the **default review depth** (the rightmost column of the §5.1.2 table), but the reviewer's existence is itself **conditional on an eval gate** (ADR §3, invariant 11). Independent benchmarks show Claude already leads SWE-bench with lower hallucination, so the cross-vendor GPT reviewer's lift is **a hypothesis, not a given**.

- **FAST** → review off (cheap path; no second vendor).
- **BALANCED** → light pre-screen (a cheap reviewer pass, e.g. GPT‑5.1 at low effort, only flagging high-signal issues).
- **DEEP** → full reviewer loop **iff the eval gate proved real lift**; otherwise DEEP runs builder-only and the reviewer is offered as an explicit opt-in.
- **MAX** → full reviewer loop **+ optional panel-of-judges (PoLL)** for auto-merge / auto-publish decisions, where single judges are adversarially manipulable (ADR §10).

**FR‑REV‑1:** If the reviewer eval gate (ADR §3) has not certified lift, DEEP/MAX still run the build at the chosen effort but the review leg is **opt-in, not automatic** — and the ADR is amended to reflect this. The reviewer is **droppable, not sacred** (invariant 11).

---

### 5.7 Layered Autonomy (plan-mode → gated → unattended)

Autonomy is the second, orthogonal dial. It maps onto the **Claude Agent SDK's six permission modes** (AE‑5) and is enforced by the **Extension Host / MCP gateway** (ADR §2/§9) and **PreToolUse/PostToolUse hooks**. **`bypassPermissions` is never shipped** (ADR §4; research §5.9).

| Autonomy level | Behavior | SDK / enforcement mechanism | Default for |
|---|---|---|---|
| **Plan-mode** | Agent produces a plan; **executes nothing** until the operator approves. | Plan permission mode; durable HITL checkpoint (ADR §10) | Risky/irreversible work; **the default** for new projects (decomposition §2.8 "plan before power") |
| **Gated** | Agent executes, but **every sensitive/destructive/outbound/irreversible action pauses for approval** (send message, publish, merge, spend above a threshold). | PreToolUse hooks + MCP gateway allow/deny + `HumanGate` interface | Most execution work |
| **Unattended** | Agent runs end-to-end without prompting, within a **tight `allowedTools` allowlist + deny-by-default network/FS + hard budget cap**. | `dontAsk`-style scoped mode + capability-scoped tokens; **never** `bypassPermissions`; `acceptEdits` only inside isolated worktree dirs | Scheduled/background jobs the operator has pre-authorized |

**Autonomy precedence & inheritance** (ADR §7): Project sets the default mode → Job overrides → Session. A child can **narrow** autonomy (more gating) but the unattended level always runs inside the **hard per-project budget cap (429 on exceed)** and the **tool/network allowlist** — autonomy never widens a grant (ADR §18).

- **FR‑AUT‑1 (AE‑5):** Every Job carries an autonomy level; default = **plan-mode** at the Workspace level, adjustable per Project Template.
- **FR‑AUT‑2:** Unattended jobs run with an explicit `allowedTools` allowlist, deny-by-default network/FS, and a hard budget cap; exceeding the cap returns 429 and halts the job (ADR §16).
- **FR‑AUT‑3:** `bypassPermissions` is **not exposed** in any UI or config path; a test asserts the engine never sets it.
- **FR‑AUT‑4:** Autonomy and effort are independent fields — any combination is valid (e.g. MAX-effort plan-mode, FAST-effort unattended).
- **AC‑AUT‑1:** A scheduled unattended job attempting a tool call outside its allowlist is blocked by the MCP gateway and recorded in the audit log; the job does not escalate its own permissions.
- **AC‑AUT‑2:** A gated job hitting a "publish" action pauses and emits a HITL gate to the operator's active surface; nothing publishes until approved.

---

### 5.8 HITL Gates — durable, multi-surface approval

HITL gates are the enforcement primitive for gated/plan-mode autonomy and for sensitive actions at any autonomy level (ADR §10). They are **durable** (survive Core restart, OS sleep, app close — ADR §8 checkpoint/resume) and reachable on **whichever surface the operator is on**.

**Gate properties:**

- **Triggers:** any sensitive/irreversible/outbound/over-budget action — send a comms message, publish, merge to a branch, spend above a per-job threshold, or run an unverified third-party skill (ADR §9).
- **Actions offered:** **approve / edit / reject / respond** (ADR §10). "Edit" lets the operator amend the proposed action (e.g. tweak a caption before publish); "respond" feeds a chat reply back into the loop.
- **Delivery surfaces (same gate, three transports — ADR §1 same RPC contract):**
  - **Desktop** — command-center modal / job monitor (X1).
  - **Mobile (X2)** — push notification (ADR §15) → approve/reject/diff view over the relay-brokered E2EE WebSocket (ADR §12); approve a 20‑minute background build or a render from the train.
  - **Telegram (D3, primary comms)** — inline-keyboard approve/reject/respond on the bot (grammY); WhatsApp lanes secondary/opt-in (ADR §11). **Inbound approvals are themselves untrusted input** (ADR §11/§16) — the gate verifies the approval comes from the paired operator identity, not from message content.
- **Durability:** a gate raised before sleep is still pending and actionable after wake/restart; the job's JSONL session is the resume point (ADR §8). A wake-lock is **not** the guarantee — durable resume is (invariant 5).

**Functional Requirements — HITL:**
- **FR‑HITL‑1:** Every gate is persisted durably and survives Core/app/OS restart; on resume it is re-presented, not lost.
- **FR‑HITL‑2:** A gate is deliverable to desktop, mobile, and Telegram via the **same `HumanGate` contract**; the operator may act from any one and the decision is reflected everywhere (sync, ADR §12).
- **FR‑HITL‑3:** Gates offer approve / edit / reject / respond; the decision (who/surface/when/choice) is recorded in the append-only audit log (ADR §7).
- **FR‑HITL‑4:** Comms-delivered approvals authenticate the operator (paired identity / token), never trusting message *content* as authorization (lethal-trifecta defense, ADR §11/§16).
- **FR‑HITL‑5:** Plan-mode approval, sensitive-action gates, and over-budget gates all use the same gate machinery.

**Acceptance Criteria — HITL:**
- **AC‑HITL‑1:** A gate raised while the desktop is asleep is still pending and approvable from mobile/Telegram; approving it resumes the job from its checkpoint.
- **AC‑HITL‑2:** Approving on Telegram and approving the same gate on desktop are idempotent — the second surface shows "already resolved," and the audit log records one decision with its origin surface.
- **AC‑HITL‑3:** A forged Telegram message containing "approve gate 123" from a non-paired sender does **not** resolve the gate (content is not authorization).
- **AC‑HITL‑4:** An over-budget action raises a gate offering approve (raise cap) / reject (halt); rejecting halts the job within the hard cap with a clean audit trail.

---

### 5.9 Cross-References & Non-Goals

**Implemented in / depends on:** E1 (engine + router translation), E5 (workflow legs, gate orchestration), F3 (budget ledger + telemetry feeding the auto-tuner), F4/F5/F6 (notifications, relay, mobile delivery of gates), D3 (Telegram/WhatsApp gate transport), D5 (publish-gate trigger). Binding parents: **ADR §3, §4, §5, §10, §16; invariants 2, 5, 9, 11.**

**Non-Goals (single-operator scope — explicitly out):**
- **No effort/autonomy policy as a multi-user/role control.** There is no admin imposing effort ceilings on other users, no per-seat autonomy policy, no RBAC over who may approve a gate — there is one operator (ADR §0). "Who sets effort" (§5.2) is about *automation sources* (scheduler/auto-tuner), not *people*.
- **No billing-by-effort / monetization of effort tiers.** Effort multipliers exist solely as the operator's own bill-shock signal (ADR §16), never as a pricing lever.
- **No `bypassPermissions` autonomy level**, ever — unattended is the maximum, always inside an allowlist + hard budget cap.


## 6. Projects, Sub-projects & Project Templates

> **Module owner:** D1 Project & Workspace Manager (depends on E1 Agent Runtime). **Primary requirements:** PJ‑1 (projects + sub-projects, template-driven), PJ‑2 (per-project instructions scoping every job). **Binding context:** ADR §7 (canonical data model + inheritance), §5 (effort), §3 (model tiers), §8 (scheduler/triggers), §9 (skills/MCP), §10 (orchestration), §1/§19 (git worktree isolation, `rpc-contract` seam). Every model ID/price below is point-in-time mid-2026 config, re-verifiable against the Vendor Register (ADR §16.4), never a hard-coded constant.

### 6.1 Why this is the headline general-purpose mechanism

Maestro is one app the operator drives wearing many hats — engineer one hour, video studio operator the next. The mechanism that makes a single thin core serve all of those without forking into separate products is **the Project, parameterized by a Project Template**. This is the literal expression of design tenet #4 ("Projects are typed") and the explicit override in ADR §0/§19: creator-vs-engineer is **not** a persona fork or a product split — it is one power user switching hats, and the hat is a Project Template.

Concretely: "Claude", "Claude-Design", and "Claude-Code" are not three modes baked into the binary and not three personas. They are **three rows in the Project Templates table** — saved presets the operator can read, clone, edit, and supersede. There is nothing special about the three that ship first; the operator can author a fourth ("Claude-Research", "Claude-Shorts", "Claude-Infra") that is exactly as first-class. The generality of the platform *is* the template mechanism. If template authoring were weak, Maestro would collapse back into a fixed-purpose coding tool with a video bolt-on; with it, the same `plan→build→review` spine (ADR §10), the same router (ADR §4), and the same scheduler (ADR §8) are repointed by data alone.

This section does **not** re-specify the engine, the effort dial, the skills loop, the scheduler, or the comms gateway — those are owned by ADR §3/§5/§9/§8/§11 respectively. It specifies the **container** (Project / Sub-project), the **preset that configures the container** (Project Template), the **instruction scoping** that makes a Project a governing context (PJ‑2), and the **filesystem/environment isolation** (git worktree) that keeps concurrent Projects and Jobs from corrupting each other.

#### Non-Goals (scope guard, ADR §0)

- **No Org / tenant above Workspace.** A Project belongs to the single Workspace; there is no team, no shared project, no per-member access. Workspace is the top entity (ADR §7).
- **No template marketplace economy.** Templates may reference skills from the operator's own registry (ADR §9, npm-for-skills, no payment layer ever), and templates themselves may be exported/imported as files or via that registry — but there is no pricing, no take-rate, no creator payout, no template store-front billing.
- **No RBAC/permissions-as-product on Projects.** "Permissions" here means agent autonomy/tool-scope (ADR §7 inheritance, ADR §10 gates), not multi-user access control.
- **Project Templates are not a separate product tier.** Shipping "Claude-Code first" is build order (ADR Appendix B), not a paid tier. All template capabilities are available to the one operator.

---

### 6.2 The data model: Workspace → Project → Sub-project (PJ‑1)

This section conforms exactly to the canonical hierarchy and inheritance rules in ADR §7. It does not introduce a competing schema; it details the two levels D1 owns (Project, Sub-project) and how a Project Template materializes into them.


Workspace                         (operator's single root; global defaults, master budget ceiling, the keychain-held keys)
└── Project          ← instantiated FROM a Project Template; carries per-project instructions, default engine/effort/review,
    │                  starter skills/tools, allowed triggers, UI layout, and its own git worktree root + environment
    └── Sub-project  ← a focused stream inside a Project; inherits the Project's config, may override narrowly;
        │              gets its own worktree branch off the Project's repo
        └── Job      ← a unit of work (one-off or scheduled; ADR §8) with a Trigger
            └── Session  ← a live agent run (engine + effort + permissions + per-session skills/tools; ADR §3/§9)

#### 6.2.1 Entity definitions

| Entity | Definition | Owns / carries | Store (ADR §7) |
|---|---|---|---|
| **Workspace** | The operator's single root. Exactly one. The top entity (no Org). | Master budget ceiling, global default template, the keychain-held provider keys/tokens (agent-invisible), Workspace-wide instructions. | SQLite row; keys in OS Keychain. |
| **Project** | A typed container instantiated from a Project Template. The unit a goal is handed to. | Resolved template config (snapshotted at creation — see §6.4.4), per-project instruction set (PJ‑2), hard budget cap, default engine/review/effort, default permission mode, starter skill set, allowed MCP/tool allowlist, allowed trigger types, UI layout, git worktree root + environment profile. | SQLite `project` row + on-disk worktree + `.maestro/` config dir. |
| **Sub-project** | A focused stream within a Project (e.g. "auth-rewrite" within a "backend" Project, or "Episode 3" within a "channel" Project). | Inherits Project config; may narrowly override instructions, effort, skill subset, sub-budget. Gets its own worktree branch. | SQLite `subproject` row + worktree branch. |
| **Job** | A unit of work with a Trigger (manual / cron / comms / webhook — ADR §8). Owned by D2, scoped by D1. | Per-run budget cap (≤ remaining Project cap), trigger binding, effort override. | SQLite `job` row + BullMQ schedule (ADR §8). |
| **Session** | A live agent run. Owned by E1/E5. | Engine + effort + permission mode + ephemerally-loaded skills/tools (ADR §9), JSONL transcript. | JSONL transcript (ADR §3/§7). |

#### 6.2.2 Inheritance (verbatim from ADR §7 — child overrides, else inherits)

The Project is where most configuration lands because it is the level a Project Template targets. Sub-projects and Jobs narrow it. The binding rule is **child overrides, else inherits**, with two hard constraints that cannot be relaxed:

| Concern | Attached at | Rule (binding) |
|---|---|---|
| **Budget / caps** | Workspace ceiling → **Project hard cap** → Sub-project sub-cap → Job per-run cap | A child cap must be **≤ parent remaining**. Job spend rolls up Job → Project → Workspace ledger (ADR §16). A Sub-project cannot spend the Project's whole cap unless granted. |
| **Keys / OAuth tokens** | Workspace (operator's keys) | Inherited everywhere, never per-Project secrets. Agent-invisible (ADR §6). A Project never holds a raw key. |
| **Skills** | **Project** (template's starter set) → Session (ephemeral per-job load, ADR §9) | Session adds/removes on top of the Project set. A Project's starter set is what the dynamic skill loop (ADR §9) treats as already-present before searching the registry. |
| **Tools / MCP** | **Project** (allowed servers) → Job/Session (scoped subset) | **Deny-by-default.** A Session can only **narrow**, never widen, beyond the Project allowlist (ADR §2/§9 capability scoping). |
| **Permissions / autonomy** | **Project** (default mode) → Job (override) | Plan-mode default; **never `bypassPermissions`** (ADR §4/§10). A Sub-project may not widen autonomy beyond its Project unless the operator edits the Project. |
| **Instructions / config** | **Project** (PJ‑2) → Sub-project → Session | Concatenated/overridden **down** the tree (§6.3). |
| **Audit** | Every level, append-only | Immutable; recorded where it happens; never inherited (ADR §16). |
| **Sync-state** | Workspace/Project/Job docs | Yjs CRDT per syncable doc; desktop↔mobile (ADR §12). The Project's live state is a `SyncDoc` so the phone sees it. |

**Functional requirements (PJ‑1):**

- **FR‑PJ1‑1** — The system SHALL support an unbounded number of Projects under the single Workspace, each instantiated from exactly one Project Template at creation time.
- **FR‑PJ1‑2** — A Project SHALL support an unbounded number of Sub-projects; Sub-projects SHALL NOT nest beyond one level (a Sub-project cannot own Sub-projects — keep hierarchy shallow per ADR §10; deeper streams are sibling Sub-projects).
- **FR‑PJ1‑3** — Every Project and Sub-project SHALL resolve its effective config by applying the inheritance table above, with child values overriding inherited ones, except budget caps (must be ≤ parent remaining) and tool/MCP scope (can only narrow) which are clamped, not overridden upward.
- **FR‑PJ1‑4** — The effective config of any Project/Sub-project SHALL be inspectable (a "resolved config" view showing each value and where it came from: template snapshot, Project override, Sub-project override).
- **FR‑PJ1‑5** — Deleting a Project SHALL cascade to its Sub-projects, Jobs, schedules (ADR §8), and worktrees (§6.5), and SHALL retain the append-only audit record (audit is never deleted, ADR §16).

**Acceptance criteria:**

- **AC‑PJ1‑1** — Creating a Project from the "Claude-Code" template yields a Project whose resolved engine = builder role (Opus 4.8 `claude-opus-4-8`, ADR §3), default effort = BALANCED (ADR §5), review pass eval-gated per ADR §3, and whose worktree root exists on disk with a `.maestro/` config dir.
- **AC‑PJ1‑2** — Setting a Sub-project effort override to DEEP changes only that Sub-project's Jobs; sibling Sub-projects and the parent Project remain BALANCED, confirmed via the resolved-config view.
- **AC‑PJ1‑3** — Attempting to set a Sub-project budget cap above the Project's remaining cap is rejected with a clear error, not silently clamped without notice.
- **AC‑PJ1‑4** — Attempting to add an MCP server to a Session that is not on the Project allowlist is denied by the MCP gateway (ADR §2/§9), and the denial is audited.
- **AC‑PJ1‑5** — A Project's live state (running Jobs, budget consumed) is visible on the paired mobile client (ADR §12) within sync latency, because it is projected as a Yjs `SyncDoc`.

---

### 6.3 Per-project instructions that scope every job (PJ‑2)

Per-project instructions are the second headline mechanism: a Project is not just a folder of presets, it is a **governing context** that every Job inside it inherits. This is the single most important reason a Project exists as a first-class entity rather than a tag on a Job.

#### 6.3.1 What instructions are

A Project's instruction set is a structured, versioned bundle (not a free-text blob) that is injected into **every** Session spawned under that Project, ahead of the Job's own prompt. It maps onto the Claude Agent SDK's system-prompt / `CLAUDE.md`-style context mechanism (ADR §3), materialized at the Project's worktree root so the harness picks it up natively, plus structured fields the router and orchestrator read directly.

| Instruction layer | Source | Mechanism |
|---|---|---|
| **Workspace instructions** | Operator's global preferences (tone, never-do rules, default language). | Concatenated first; lowest precedence. |
| **Project instructions** (PJ‑2 core) | The Project's own instruction set (from the template, then operator-edited). | Materialized as the Project worktree's `CLAUDE.md` + structured fields in `.maestro/project.json`; injected into every Session. |
| **Sub-project instructions** | Narrow overrides/additions for the stream. | Materialized at the Sub-project worktree branch; concatenated after Project. |
| **Job / Session instructions** | The specific goal handed to this run + the operator's per-run notes. | The actual task prompt; highest precedence. |

Precedence is **down the tree** (Workspace → Project → Sub-project → Job/Session), matching ADR §7's "concatenated/overridden down the tree". Structured directives (e.g. "default effort", "review required: yes", "allowed tools") are resolved by the override rules in §6.2.2; prose directives are concatenated with later prose able to override earlier prose.

#### 6.3.2 What the instruction set governs

Per-project instructions are not merely a prompt prefix — they are the operator's policy surface for the Project. A Project's instruction set scopes every Job by carrying:

- **Behavioral prose** — coding standards, house style, "always write tests first", "captions must be burned in", "never auto-publish, always draft" (ties to HITL/draft-mode, ADR §14).
- **Hard guardrails** — never-touch paths, forbidden commands (reinforcing the deny-by-default Bash rules, ADR §2), forbidden network hosts, "this Project may never send comms outbound" (ADR §11).
- **Default selections** — default effort (ADR §5), whether the review pass runs (ADR §3/§10), default permission/autonomy mode (ADR §10), starter skills, allowed MCP/tools.
- **Allowed triggers** — which trigger types (manual / cron / comms / webhook, ADR §8) may start a Job in this Project (e.g. a "production-deploy" Project might forbid comms-triggered Jobs entirely).

**Functional requirements (PJ‑2):**

- **FR‑PJ2‑1** — Every Session spawned under a Project SHALL receive that Project's resolved instruction set, with no Job able to opt out of the Project's hard guardrails (guardrails are floor constraints, not defaults).
- **FR‑PJ2‑2** — Project instructions SHALL be versioned; editing them SHALL create a new version, and every Session SHALL record (in the audit log, ADR §16) the exact instruction-set version it ran under, so a run is reproducible.
- **FR‑PJ2‑3** — Structured directives in the instruction set (effort, review-on/off, autonomy mode, allowed tools/triggers) SHALL be read by the router (ADR §4), orchestrator (ADR §10), and scheduler (ADR §8) — not only injected as prose — so they are enforced, not merely suggested.
- **FR‑PJ2‑4** — Prose instructions SHALL be injected via the harness's native context mechanism (materialized at the worktree root) so the Agent SDK consumes them without custom plumbing.
- **FR‑PJ2‑5** — A Project guardrail forbidding an action (e.g. outbound comms, a forbidden path) SHALL be enforced at the gateway/hook layer (ADR §2/§9/§10), not only by instructing the model — instructions alone are not a security boundary against prompt injection (ADR §16).

**Acceptance criteria:**

- **AC‑PJ2‑1** — A Job created in a Project whose instructions say "never auto-publish" cannot complete a publish without an explicit HITL gate, even if the Job prompt asks for it, because the directive resolves to draft-mode (ADR §14) and is enforced by the gate, not the prompt.
- **AC‑PJ2‑2** — Editing Project instructions and re-running an identical Job produces a Session audit record naming the new instruction version; the prior Session still names the old version.
- **AC‑PJ2‑3** — A Project guardrail listing a forbidden path causes a PreToolUse hook (ADR §2) to block a Bash write to that path and audit the block, regardless of model output.
- **AC‑PJ2‑4** — A Project that disallows the `comms` trigger type rejects an attempt to bind a Telegram-message trigger to a Job in that Project (ADR §8/§11).

---

### 6.4 Project Templates

A **Project Template** is the saved preset that makes a Project typed. Per ADR §7 and the decomposition's mental model, it bundles exactly: **default engine + review model + effort; starter skills/tools; instruction set; allowed triggers; UI layout.** It is the mechanism by which "Claude", "Claude-Design", "Claude-Code" are three rows, not three forks.

#### 6.4.1 Template anatomy

| Template field | Type | Resolves to (binding ADR ref) |
|---|---|---|
| **id / name / version / icon** | metadata | SQLite `project_template` row; semver per ADR §9 versioning conventions. |
| **default engine (builder role)** | logical role, not model ID | Routed via LiteLLM (ADR §4): `builder` → Opus 4.8 today; never a hard-coded ID (ADR Appendix A.2). |
| **default driver / subagent roles** | logical roles | `driver` → Sonnet 4.6, `subagent` → Haiku 4.5 (ADR §3) — config, not literals. |
| **review model + review policy** | logical `reviewer` role + on/off/eval-gated | `reviewer` → GPT‑5.1 (`gpt-5.1`) by default, behind the eval gate (ADR §3/§10/Appendix A.11). Template may set review off (e.g. a fast drafting template). |
| **default effort** | `Effort` enum {FAST, BALANCED, DEEP, MAX} | ADR §5. Default BALANCED unless the template's purpose justifies otherwise (effort-paradox guardrail, ADR §5). |
| **starter skills** | list of skill refs (registry coordinates) | Project's inherited skill set (ADR §9); the dynamic loop searches the operator's registry for anything beyond these. |
| **allowed tools / MCP servers** | allowlist | Project tool/MCP allowlist (deny-by-default, ADR §2/§9); Sessions can only narrow. |
| **instruction set** | structured + prose bundle | The Project's PJ‑2 instructions (§6.3). |
| **allowed triggers** | subset of {manual, cron, comms, webhook} | Which trigger types Jobs in this Project may use (ADR §8). |
| **UI layout** | command-center layout profile | Which panels the desktop shell (X1) and mobile (X2) surface for this Project type (e.g. a Studio layout vs an IDE layout). |
| **environment profile** | worktree/runtime config | Repo seed (or none), runtime image/toolchain, env-var template, prevent-sleep policy hint (ADR §15). |

#### 6.4.2 The three shipped templates are just three rows

| Template | Builder (role→ID, config) | Default effort | Review | Starter skills (examples) | Allowed triggers | UI layout | Purpose |
|---|---|---|---|---|---|---|---|
| **Claude** (general) | `builder`→Opus 4.8 | BALANCED | eval-gated, off by default | general research/writing skills | manual, cron, comms | balanced/chat | The catch-all hat — ad-hoc reasoning, research, writing. |
| **Claude-Code** | `builder`→Opus 4.8 (`xhigh` for hard agentic coding, ADR §3); `driver`→Sonnet 4.6 | BALANCED (plan-mode DEEP per ADR §5) | eval-gated GPT‑5.1 review loop (ADR §3/§10) | git/test/lint skills, repo-aware MCP | manual, cron, comms, webhook | IDE layout (worktree, diffs, PR, plan-mode gate, ADR §10) | The engineer hat — `plan→build→review→merge-to-PR`. |
| **Claude-Design** | `builder`→Opus 4.8 for planning; media routing per ADR §13 | BALANCED | off by default (creative review is human/HITL) | media `*Job` skills (image/video/avatar/voice), Remotion assembly (ADR §13) | manual, cron | Studio layout (timeline/compositor, render queue, draft-mode publish gate, ADR §14) | The creator hat — image/video/kinetic-typography studio. |

The point of the table is its uniformity: the three differ only in **field values**, never in code path. The same router (ADR §4), the same `plan→build→review` orchestrator (ADR §10), the same scheduler (ADR §8), and the same worktree isolation (§6.5) execute all three; the template repoints them.

#### 6.4.3 The operator can author new templates

This is what makes Maestro general-purpose (design tenet #4). Template authoring is a first-class, supported flow — not an internal-only configuration.

**Functional requirements (Project Templates):**

- **FR‑TPL‑1** — The operator SHALL be able to create a new Project Template from scratch or by **cloning** an existing one (including the three shipped templates) and editing any field in §6.4.1.
- **FR‑TPL‑2** — The operator SHALL be able to **promote a configured Project into a Template** ("save this Project's config as a new template"), capturing its resolved instructions, effort, skills, tools, triggers, and layout.
- **FR‑TPL‑3** — Templates SHALL be **versioned** (semver, ADR §9 conventions); editing a Template creates a new version and SHALL NOT retroactively mutate Projects already created from a prior version (snapshot semantics, §6.4.4).
- **FR‑TPL‑4** — Templates SHALL be **exportable and importable** as portable bundles (and optionally publishable to the operator's own skill/asset registry, ADR §9, with **no payment layer** — ADR §0). Import SHALL re-validate referenced skill coordinates against the registry.
- **FR‑TPL‑5** — Template fields that reference models SHALL store **logical roles**, never raw model IDs (ADR Appendix A.2); on instantiation the router resolves roles to current IDs, so a template authored when `builder`=Opus 4.8 keeps working when the builder ID revs.
- **FR‑TPL‑6** — Template editing SHALL surface the **effort-paradox cost/latency multiplier** (ADR §5) when the operator sets a default effort above BALANCED, discouraging gratuitously expensive defaults.

**Acceptance criteria:**

- **AC‑TPL‑1** — Cloning "Claude-Code" to "Claude-Infra", adding a forbidden-`terraform destroy` guardrail and a `manual`-only trigger policy, then creating a Project from it, yields a Project whose Jobs cannot be cron-triggered and whose `terraform destroy` is hook-blocked (ADR §2).
- **AC‑TPL‑2** — Authoring a "Claude-Shorts" template with default effort FAST, review off, a starter video `*Job` skill, and a Studio layout, then handing it "make 3 shorts on topic X", runs entirely on the FAST tier with no GPT review pass and renders via the media lane (ADR §13) — proving a brand-new hat needs no code change.
- **AC‑TPL‑3** — Exporting a template, deleting it, and re-importing it reconstructs an identical template (modulo a new local id), with skill references re-validated against the registry.
- **AC‑TPL‑4** — Editing the "Claude-Code" template to bump its version does not alter the resolved config of a Project created from the previous version (the older Project still shows its snapshotted config in the resolved-config view).

#### 6.4.4 Snapshot semantics (why template edits don't break live Projects)

A Project records the **resolved template config at creation time** (a snapshot), plus a reference to the template id + version it came from. Editing the source template afterward produces a new template version and **does not** retroactively mutate existing Projects. The operator may explicitly "rebase a Project onto template vN" to pull forward changes, which re-resolves config and is audited (ADR §16). This prevents the failure mode where editing a shared template silently changes the behavior of dozens of in-flight Projects — important precisely because a single operator runs many Projects in parallel.

---

### 6.5 Git worktree / environment isolation per Project (and per Sub-project)

Filesystem and environment isolation is what lets the operator run many Projects and many concurrent Jobs without one corrupting another's working tree — the parity capability the research identifies as table stakes (synthesis §5.1: "worktree-per-agent isolation"; Cursor `/worktree`/`/apply-worktree`, Conductor per-workspace setup). Maestro adopts it but treats it as parity, not pitch (synthesis §2c). The decomposition assigns this to D1 explicitly ("git worktree isolation, environments").

#### 6.5.1 Isolation model

| Level | Isolation primitive | Rationale |
|---|---|---|
| **Project** | A dedicated **git worktree root** (one working tree per Project, off a shared object store / cloned repo) + a `.maestro/` config dir (resolved template snapshot, PJ‑2 instructions, allowlists) + an **environment profile** (toolchain image, env-var template). | A Project is a stable, long-lived workspace; its worktree is where its `CLAUDE.md` (PJ‑2 prose) lives so the Agent SDK reads it natively (ADR §3). |
| **Sub-project** | A **worktree branch** off the Project's repo (own branch, own checkout). | Concurrent streams (auth-rewrite vs. billing-fix) don't fight over one index/HEAD. |
| **Job / Session** | When a Job runs the parity coding loop, the agent operates in (or forks) the Sub-project's worktree; parallel agents fan out into **ephemeral worktrees** and reconcile via `apply-worktree`-style merge-to-PR (ADR §10 fan-out; synthesis §2c, copy Cursor UX). | Parallel build agents must not share a mutable working tree; merge-to-PR is the durable HITL gate (ADR §10). |

This nests cleanly with the process topology (ADR §2): worktrees give **filesystem** isolation; the Extension/Skill Host + MCP gateway give **capability** isolation; the Scheduler Worker process gives **execution** isolation. They are orthogonal layers, not substitutes — a worktree alone does not contain a malicious skill (that's the gateway's job), and the gateway alone does not stop two Jobs clobbering one checkout (that's the worktree's job).

#### 6.5.2 Non-code Projects still get an environment, not necessarily a repo

The Studio/creator hat ("Claude-Design", "Claude-Shorts") usually has no source repo to branch. Its "environment profile" is instead a **scoped working directory + asset store** (object store, ADR §7) + a render/runtime toolchain (Remotion/ffmpeg on Media Workers, ADR §2/§13). The isolation guarantee is the same — each Project gets its own sandboxed working dir and deny-by-default FS scope (ADR §2) — but git worktrees apply only where a repo exists. The environment profile field (§6.4.1) abstracts this so a template declares "repo-backed" vs "asset-backed" without the core caring.

**Functional requirements (isolation):**

- **FR‑ISO‑1** — Each Project SHALL have its own working-tree root and `.maestro/` config dir; no two Projects SHALL share a mutable working tree.
- **FR‑ISO‑2** — Each repo-backed Sub-project SHALL operate on its own git worktree branch; concurrent Sub-projects SHALL NOT contend for one index/HEAD.
- **FR‑ISO‑3** — Parallel build agents within a Job (fan-out, ADR §10) SHALL each run in an isolated ephemeral worktree and reconcile via a merge-to-PR gate, never by writing to a shared tree simultaneously.
- **FR‑ISO‑4** — Each Project SHALL run under its declared environment profile (toolchain, env-var template); env vars SHALL be sourced from the agent-invisible `SecretStore` where they are secrets (ADR §6), never written into worktree files in plaintext.
- **FR‑ISO‑5** — A Project's FS scope SHALL be deny-by-default outside its worktree/working dir (ADR §2); attempts to read/write outside SHALL be hook-gated and audited.
- **FR‑ISO‑6** — Worktree spin-up SHALL be fast enough to feel interactive (Conductor's ~10s reference, synthesis §competitive map) and SHALL be reclaimed on Project/Sub-project deletion or ephemeral-worktree teardown.

**Acceptance criteria:**

- **AC‑ISO‑1** — Two Projects running coding Jobs simultaneously never observe each other's uncommitted changes; each `git status` reflects only its own worktree.
- **AC‑ISO‑2** — Two Sub-projects of one Project run concurrent builds on separate branches; merging one to PR does not disturb the other's working tree.
- **AC‑ISO‑3** — A fan-out of N parallel agents produces N ephemeral worktrees that reconcile through a single merge-to-PR HITL gate (ADR §10); a forced OS sleep mid-fan-out is survived via durable checkpoint/resume (ADR §8), not lost.
- **AC‑ISO‑4** — An agent in a Project attempting to write outside its worktree root is blocked by a PreToolUse hook and the attempt is recorded in the append-only audit log (ADR §16).
- **AC‑ISO‑5** — A non-repo "Claude-Design" Project gets an isolated asset working dir and render toolchain with no git worktree, and its renders are metered into the same budget ledger (ADR §16).

---

### 6.6 How D1 wires into the rest of the platform

| Consumes / produces | Counterpart module | Binding ADR |
|---|---|---|
| Resolves logical engine/review/effort roles → concrete calls | E1 Agent Runtime + Router | ADR §3, §4, §5 |
| Per-project instruction injection into Sessions | E1 (Claude Agent SDK context) | ADR §3, §6.3 |
| Starter skills as the "already-present" set before the dynamic loop searches | E3/E4 Skills + registry | ADR §9 |
| Project tool/MCP allowlist enforced at the gateway | E2 + MCP Gateway | ADR §2, §9 |
| Allowed triggers + per-project concurrency / budget caps consumed by the scheduler | D2 Scheduler | ADR §8, §16 |
| Project live state projected for mobile | F5 Sync / X2 Mobile | ADR §12 |
| Per-project hard budget cap + spend roll-up | F3 / BudgetLedger | ADR §16 |
| UI layout profile driving the command center per Project type | X1 Desktop / X2 Mobile | ADR §1, §12 |
| Worktree config + prevent-sleep hint | F4 System Integration (`PlatformAdapter`) | ADR §15 |

**Net:** D1 is deliberately thin. It owns the **container, the typed preset, the instruction scoping, and the worktree/environment isolation** — and delegates engine, effort, skills, scheduling, sync, and budgets to the modules the ADR already assigns them to. That thinness is the point: because a Project is just data over the shared `rpc-contract` seam (ADR §1/§19), a new Project Template is a new capability with no new code, which is exactly what "general-purpose, template-driven" (PJ‑1) requires.


## 7. Per-Project Scheduler & Durable Execution

> **Module:** D2 (Job & Scheduler Engine) · depends on D1 (Projects), F5 (Sync Backbone), F3 (Secrets/Cost/Observability) · drives D3 (Comms), D5 (Publishing), X2 (Mobile).
> **Requirements covered:** PJ-3 (one-off + recurring, "as many as I want"), PJ-4 (per-project scheduling, concurrency, retries, missed-run handling), PJ-5 (triggers: manual, schedule, comms message, webhook/event). Supports AE-5 (durable sessions) and the non-functional reliability tenet ("jobs survive sleep, restart, network blips").
> **Binding ADR:** §8 (BullMQ on Redis primary / pg-boss on Postgres documented swap), §2 (isolated Scheduler Worker process), §7 (Workspace→Project→Sub-project→Job→Session data model), §15 (reference-counted prevent-sleep), §16 (unified budget ledger + hard 429 caps). This section elaborates §8; it must not contradict it.

### 7.1 Why this is the lead differentiator

Maestro's defining capability is a **per-project, durable, always-on cron scheduler that survives OS power events**. No consumer agent product ships this natively: Anthropic's own **Claude Code Routines** is a research preview with a **1-hour minimum interval and a per-account daily cap**, and its own docs warn "green status ≠ task success" — too coarse and too opaque to be the spine of a multi-project personal automation platform. Maestro self-hosts the scheduler so the operator can run **as many jobs as they want** (PJ-3), at any granularity, scoped to a project's instructions and budget, and have them resume from checkpoint after a lid-close, a reboot, or a network blip — not restart from zero and not silently drop.

The scheduler is the second half of the critical-path spine (`F1 → F2/F3 → E1 → D1 → D2`). Once it exists, the comms (D3), publishing (D5), and trend→studio (D6→D4) workstreams all hang off it as trigger sources and result sinks.

### 7.2 Engine decision (per ADR §8)

**Primary: BullMQ on Redis.** Desktop-first single-operator default. **Documented swap: pg-boss on Postgres**, selected only if the operator later runs Maestro Core as a long-lived headless server and prefers a single datastore (Postgres already backs the data model in that mode per §7). The choice is hidden behind a **`JobQueue` interface** (`enqueue / schedule / checkpoint / resume / onComplete`) so the engine is swappable without touching trigger sources or job bodies.

| | **BullMQ (Redis) — PRIMARY** | **pg-boss (Postgres) — documented swap** |
|---|---|---|
| Datastore | Redis (already in stack for live meters, rate-limiter, Yjs relay state per §7) | Postgres only (no extra infra if already all-Postgres) |
| Recurring jobs | Job Schedulers (cron + every-N + limited repeats) | `schedule()` with cron lock |
| Concurrency control | Per-queue concurrency + group/flow + global rate-limiter | Per-queue `teamSize`/`teamConcurrency` |
| Dedup / idempotency | `jobId`-based dedup + custom idempotency keys | Built-in `singletonKey` / `useSingletonQueue` |
| Retries | Per-job attempts + backoff (fixed/exponential/custom) | `retryLimit` / `retryDelay` / `retryBackoff` (opt-out per job) |
| Observability | **Native OpenTelemetry** integration (feeds §16 OTel/Langfuse) | Manual instrumentation |
| Misfire after sleep | Implemented via Maestro misfire policy layer (§7.5) | Implemented via Maestro misfire policy layer (§7.5) |
| Fit | Best for desktop-first, Redis already present, OTel built-in | Best for one-datastore headless deployment |

**Rejected (per ADR §8, do not re-litigate):** *Anthropic Routines as the scheduler* (1-hour floor, daily cap, opaque success) — usable only as an **optional dispatch backend**, never the source of truth. *Hand-rolled `setTimeout`/node-cron* (no durability, no resume, dies on app restart). *Temporal* (multi-week mission-critical machinery; overkill for one operator's desktop). *Trigger.dev / Inngest hosted* (managed-service dependency contradicts a self-hosted personal platform).

### 7.3 Process & data model

The **Scheduler Worker** runs as a **separate, resource-capped, trusted process** (ADR §2) so a runaway, blocked, or memory-heavy job cannot stall the renderer, the Maestro Core engine, or the UI. It dequeues jobs and hands each to the Agent Runtime (E1), which spins up a Session.

A Job lives at the documented level of the data model (ADR §7):


Workspace → Project → Sub-project → Job → Session
                         (per-project instructions, defaults, budget caps inherited downward)

- A **Project** carries **per-project instructions/config (PJ-2)** — engine, review model, default effort (FAST/BALANCED/DEEP/MAX), starter skills/tools, allowed triggers, and **per-project budget caps** — via the explicit inheritance table in §7. Every Job in that project, however triggered, is scoped by those instructions and that budget.
- A **Job** is a durable record: `{ id, projectId, subProjectId?, trigger, schedule?, payload, idempotencyKey, effort, budgetCap, concurrencyGroup, retryPolicy, misfirePolicy, status, checkpointRef, createdAt, nextRunAt }`.
- A **Session** is the live agent run the Job spawns; its **JSONL transcript is the durable checkpoint/resume point** (§7.5, ADR §3/§7).
- A **Sub-project** can hold its own concurrency group and schedule, so the operator can throttle one focused stream independently of the parent project.

### 7.4 Trigger types (PJ-5)

Triggers implement one contract via a **`TriggerSource` registry** (ADR §8) — manual, cron, comms, and webhook/event all enqueue Jobs through the identical `JobQueue.enqueue/schedule` path, so durability, retries, idempotency, budget, and result fan-out apply uniformly regardless of how a Job started.

| Trigger | Source module | Mechanism | Trust posture |
|---|---|---|---|
| **Manual** | X1 Desktop / X2 Mobile | User clicks "Run now" or "Run once at *T*"; immediate or one-off scheduled enqueue | Trusted (operator) |
| **Cron / recurring** | D2 itself | BullMQ Job Scheduler (cron expr, or every-N, or N-repeats); one-off via delayed job | Trusted |
| **Comms message** | D3 (Telegram via grammY / WhatsApp two-lane) | Inbound message on an **allowlisted** chat enqueues a Job in the bound project | **Untrusted inbound (ADR §11)** — content is data, never auto-authority |
| **Webhook / event** | F5 Sync Backbone | Authenticated inbound webhook (e.g. publish callback, media-render `webhook_url` completion, external service) enqueues a Job | Untrusted payload; signature/secret verified at the edge |

**Security note (lethal-trifecta containment, ADR §11/§16):** comms and webhook triggers carry untrusted content. Inbound text is treated as **data, not instruction** — it can *start* a Job but cannot, by itself, authorize outbound sends, destructive ops, or budget escalation. Those remain behind allowlists and HITL gates (Section on orchestration; ADR §10). One-off scheduled media-render completions arrive as webhook triggers, persisting the render job's IDs in the scheduler and polling as fallback (ADR §13).

### 7.5 Durability: concurrency, retries, misfire, checkpoint/resume, idempotency

This is the reliability core (PJ-4). Four mechanisms make Jobs survive OS sleep, app restart, and network blips:

**1. Concurrency limits.** Per-project (and per-sub-project) concurrency groups cap how many Sessions run at once; a **global rate-limiter** (Redis, shared with the §16 budget ledger) protects against provider 429s and bill-shock. "As many jobs as I want" (PJ-3) means *unbounded enqueue*, **not** unbounded simultaneous execution — excess Jobs queue and drain under the concurrency/rate ceiling. A held wake-lock (§15) never implies unlimited parallelism.

**2. Retries.** Per-job `attempts` with configurable backoff (fixed / exponential / custom). Transient failures (network blip, provider 5xx, rate-limit 429) retry automatically; permanent failures (budget cap hit, auth revoked, deterministic agent error) fail fast to a dead-letter state and notify the operator. Budget-cap-triggered failures do **not** retry (they would just re-hit the cap, per §16 hard-cap semantics).

**3. Missed-run / misfire recovery (Quartz-style).** Every schedule declares a **misfire policy** for runs missed while the machine slept, was off, or the app was closed:

- `fire-now` — run the missed occurrence immediately on wake/restart.
- `skip` (do-nothing) — discard missed occurrences, wait for the next scheduled time.
- `coalesce` — collapse N missed occurrences into a single catch-up run.

On Scheduler Worker startup, a **recovery sweep** reconciles each schedule's `nextRunAt` against wall-clock time and applies its misfire policy. This is what prevents both "lost the 3 a.m. run because the lid was closed" and "fired 40 catch-up jobs at once after a weekend off."

**4. Checkpoint / resume.** A Job interrupted mid-run by OS sleep, lid-close, low-battery hibernate, or restart **resumes from its last checkpoint, not from zero**. The resume point is the agent's **JSONL Session transcript** (ADR §3/§7): the Scheduler Worker persists a `checkpointRef` and, on recovery, the Agent Runtime rehydrates the Session and continues. **A wake-lock (§15) is not a completion guarantee — durable resume is** (ADR §8, §17). Reference-counted prevent-sleep keeps the machine awake *while watching*, but forced power events still happen, so resume is the real reliability contract.

**5. Idempotency keys (at-least-once safety).** Every Job carries an idempotency key. BullMQ/Redis (and most durable queues) deliver **at-least-once** — without idempotency keys, a Job re-run after an ack-loss double-sends (double-publishes a video, double-replies on Telegram, double-charges a provider call). The key is checked before any externally-visible side effect (publish, comms send, paid model call); a duplicate key short-circuits to the prior result. Side-effecting tools (D5 publish, D3 send) consult the key before executing.

### 7.6 Background results → mobile / Telegram

A scheduled Job runs headless on the always-on desktop; the operator is notified wherever they are (PJ-3 "walk away," north-star "ping you only at decision gates"):

- **Completion fan-out** routes through F5 Sync Backbone → push (Expo Push / FCM/APNs, ntfy escape-hatch) to X2 Mobile, and/or an outbound report on the project's bound comms channel (D3: Telegram via grammY by default; WhatsApp two-lane opt-in). This is the "background job pushes results to my phone / Telegram" loop (ADR §8, §12, §15).
- **Decision gates** that a Job hits (HITL approval from the orchestration loop) are delivered as **durable** gate prompts — answerable from desktop, mobile, or Telegram — and the Job *parks durably* at the gate (it does not busy-wait or die), so the operator can approve from the train and the run continues (ADR §10, §12).
- Push payloads stay thin (APNs 4 KB cap) — a summary + deep link into the full transcript/result, never the full artifact.

### 7.7 Functional Requirements

- **FR-D2-1** — Enqueue unbounded one-off and recurring Jobs (PJ-3); scheduling is cron-expression, every-N-interval, limited-repeat, or run-once-at-*T*.
- **FR-D2-2** — Every Job is scoped to a Project (or Sub-project) and inherits that project's instructions, default effort, allowed triggers, and budget caps (PJ-2, PJ-4).
- **FR-D2-3** — Per-project and per-sub-project concurrency limits plus a global rate-limiter govern simultaneous execution (PJ-4).
- **FR-D2-4** — Per-job retry policy with configurable backoff; permanent/budget failures fail fast to dead-letter and notify (PJ-4).
- **FR-D2-5** — Per-schedule misfire policy (`fire-now` / `skip` / `coalesce`) applied by a startup recovery sweep for runs missed during sleep/off/closed (PJ-4).
- **FR-D2-6** — Checkpoint/resume from the JSONL Session transcript; an interrupted Job resumes from its last checkpoint after any OS power event or app restart.
- **FR-D2-7** — Mandatory idempotency key on every Job; checked before any externally-visible side effect to guarantee at-least-once-without-duplication.
- **FR-D2-8** — Four trigger sources behind one `TriggerSource` contract: manual, cron, comms-message (untrusted), webhook/event (verified).
- **FR-D2-9** — Background completion and HITL gates fan out to mobile push and/or the project's comms channel; gates park durably and are remotely answerable.
- **FR-D2-10** — `JobQueue` interface with BullMQ (primary) and pg-boss (documented swap) implementations; engine swappable without touching triggers or job bodies.
- **FR-D2-11** — Every Job emits OpenTelemetry GenAI spans and writes to the unified budget ledger (§16); per-job token/$ metering and hard 429/budget caps enforced before and during the run.
- **FR-D2-12** — Scheduler Worker runs as an isolated, resource-capped process; a runaway Job cannot stall the engine, UI, or other Jobs (ADR §2).

### 7.8 Acceptance Criteria

- **AC-1 (always-on / sleep survival)** — Schedule a Job for a time during which the Mac is asleep (lid closed). On wake, per misfire policy: `fire-now` runs it within the recovery-sweep window; `skip` records it skipped; `coalesce` runs exactly one catch-up. No silent drop.
- **AC-2 (mid-run resume)** — Force-sleep / kill the app mid-Session. On restart, the Job resumes from its last JSONL checkpoint and completes; it does **not** restart from zero, and produces no duplicate side effects.
- **AC-3 (idempotency)** — Re-deliver the same Job (simulated ack-loss) and confirm exactly one external side effect occurs (one publish, one Telegram reply, one paid model call) — the duplicate short-circuits to the cached result.
- **AC-4 (concurrency / "as many as I want")** — Enqueue 200 Jobs in one project with concurrency = 4. All 200 are accepted and persisted; at most 4 run simultaneously; the rest drain in order without UI jank and without tripping provider 429s.
- **AC-5 (per-project scoping)** — A Job in Project A uses A's default effort, skills, comms channel, and budget cap; an identical payload in Project B uses B's — proving per-project instruction inheritance (PJ-2).
- **AC-6 (all four triggers)** — The same project Job can be started by Run-now, by cron, by an allowlisted Telegram message, and by a verified webhook; all four flow through one path and produce identical durability/retry/idempotency behavior.
- **AC-7 (untrusted inbound containment)** — An inbound comms message that *requests* an outbound send or destructive op starts a Job but cannot auto-authorize the action; it stops at the allowlist/HITL gate (lethal-trifecta guard, ADR §11).
- **AC-8 (background notify + remote gate)** — A scheduled Job completes while the operator is away and a thin push + Telegram summary arrive with a deep link; a Job that hits a HITL gate parks durably and resumes correctly when approved from mobile/Telegram.
- **AC-9 (budget cap)** — A Job that would exceed its project budget cap is hard-stopped (does not retry into the cap), the partial run is checkpointed, and the operator is notified (§16).
- **AC-10 (engine swap)** — Switching the `JobQueue` implementation from BullMQ to pg-boss requires no changes to trigger sources or job bodies; the AC-1…AC-9 suite passes against both.

### 7.9 Non-Goals (single-user scope)

Consistent with the binding scope and ADR §0: **no** multi-tenant job isolation, per-tenant quotas, or org/team scheduling; **no** seat-based concurrency licensing or paid scheduling tiers; **no** billing of Job cost to any customer — the budget ledger and hard caps exist **solely** to protect the single operator from bill-shock, not to meter or charge a third party. Anthropic Claude Code Routines is explicitly **not** the scheduler (at most an optional dispatch backend). Temporal-class mission-critical workflow infrastructure is out of scope for a one-operator desktop platform.


## 8. Dynamic Skills Subsystem, Personal Marketplace & MCP Capability Layer

> **Scope anchor.** This section specifies the heart of Maestro's "skill-heavy" promise: the runtime expansion of agent capability *per job* from the operator's own skill registry, plus the mandatory security boundary (the MCP Gateway) through which all third-party capability flows. It realizes decomposition modules **E2 (MCP / Tools Manager)**, **E3 (Skills Subsystem)**, and **E4 (Marketplace Client)**, and satisfies requirements **SK-1 … SK-6**. It is bound by **ADR §9 (Skills + personal marketplace + MCP)**, **§2 (process topology)**, **§18 (plugin runtime)**, and Appendix-A invariant **#4** (mandatory gateway; treat every skill/MCP as arbitrary code; continuous rug-pull re-scan).
>
> **Single-operator canon (do not re-litigate).** The "marketplace" is the **operator's own online package registry** — npm-for-skills — that they publish to and pull from. There is **NO payment layer, NO take-rate, NO creator payouts, NO Stripe/Connect, NO Telegram Stars billing, ever** (ADR §0). The operator is one power user wearing two hats (engineer *and* creator); skill sets are switched by **Project Template**, not by persona fork. Everything below is engineering-grade capability + security, never a sales feature.
>
> **Volatility caveat.** Every spec revision, beta header, model ID, and price below is **point-in-time (mid-2026) config**, re-verifiable against the live Vendor Register. The capability-negotiation layer (§8.6) exists precisely so this churn never breaks the platform.

### 8.1 Two layers, one job: Skills (know-how) vs. MCP (capabilities)

Maestro distinguishes two orthogonal capability layers that the industry has settled into distinct standards. Conflating them is the most common architectural error, so the data model and the loading machinery keep them separate.

| Layer | Packages | Standard / format | Distribution rail in Maestro | Module |
|---|---|---|---|---|
| **Agent Skills** | *Know-how* — instructions, reference docs, bundled scripts the agent runs | `SKILL.md` convention (Claude Agent Skills; open-sourced Dec 18 2025, governed by the Agentic AI Foundation; portable across Claude Code / Codex CLI / Gemini CLI / Copilot / Cursor / Cline 20+ tools) | Operator's **personal skill registry** (E4) → materialized per-job to `.claude/skills/` (E3) | **E3 / E4** |
| **MCP servers / tools** | *Capabilities* — live tool calls into external systems (filesystem, browser, render APIs, comms, web) | Model Context Protocol, spec rev **2025-11-25** (prior 2025-06-18); transports `stdio` (local) + **Streamable HTTP** (remote default; legacy HTTP+SSE deprecated) | Attached per project/job through the **mandatory MCP Gateway** (E2) | **E2** |

**Key fact (drives the whole design):** the `SKILL.md` *artifact* is portable and vendor-neutral, but the *distribution/runtime* (plugin loading, the Anthropic `/v1/skills` API, code-exec containers, beta headers) is Anthropic-specific and churns. **Lock-in lives at the runtime layer, not the artifact layer** — so Maestro authors portable artifacts and abstracts the volatile runtime behind the Skill-Broker (§8.3) and capability-negotiation layer (§8.6).

A skill can itself *carry* MCP servers and hooks (a Claude plugin bundle), so the two layers compose: loading a skill may register tools, and those tools still route through the Gateway. The two never bypass each other.

### 8.2 Skill format — Claude `SKILL.md` convention, verbatim

Maestro adopts the Claude Agent Skills convention with no proprietary extensions (per ADR §9), keeping skills usable by both the Claude builder engine **and** the GPT reviewer.

- **Frontmatter (required):** `name` (≤64 chars, lowercase/numbers/hyphens, must not contain `anthropic`/`claude`) and `description` (≤1024 chars; must state *what the skill does* **and** *when to use it* — the "when" is what makes semantic search work).
- **Body:** ≤500 lines / ~5K tokens of Markdown instructions.
- **Bundled assets:** scripts and reference files run via bash so **code never enters the model context, only stdout** — Level-3 of the progressive-disclosure model.
- **Progressive disclosure (3 tiers, drives token economics):**
  - **Level 1 — metadata** (`name` + `description`, ~100 tokens/skill): the only thing eligible to be in context for discovery.
  - **Level 2 — body** (~5K tokens): loads only when a skill is selected/triggered for the job.
  - **Level 3 — bundled scripts/refs**: executed out-of-context; only output returns.
- **Critical economic implication:** pre-loading Level-1 metadata for *all* skills is the trap. 100 pre-loaded skills ≈ ~10K tokens **per turn** of recurring cost. **Maestro NEVER pre-loads the full registry's metadata into context — discovery is gated behind the Skill-Broker's semantic search** (§8.3). This is the single most important reason the broker exists rather than a flat "list all skills" load.

**Bundling as plugins.** A unit published to the registry is a Claude-plugin-aligned bundle (`.claude-plugin/plugin.json`-style manifest, ADR §18) that MAY contain: one or more `SKILL.md` skills, MCP server declarations, hooks, UI surfaces, triggers, and `channels` mappings — plus a **declared capability/permission set** (which tools, network hosts, FS paths, comms channels it may touch). The Extension Host enforces this manifest; a bundle cannot widen its grant at runtime (§8.5).

#### Functional Requirements — skill format

- **FR-SK-FMT-1** — Maestro MUST author and load skills in the unmodified `SKILL.md` convention (frontmatter limits as above) so artifacts remain portable across engines and consumable by the reviewer. *(SK-1)*
- **FR-SK-FMT-2** — A skill bundle MUST be a manifest-driven plugin declaring contributed skills/MCP/hooks/triggers/channels and an explicit capability set; first-party and third-party bundles use the identical contract (ADR §18). *(SK-5, SK-6)*
- **FR-SK-FMT-3** — The system MUST honor progressive disclosure: Level-1 metadata only enters context via broker search results, never via bulk registry preload. *(SK-1, SK-3)*

### 8.3 The dynamic-skill loop (E3 + E4): per-job ephemeral capability acquisition

This is the canonical loop from decomposition §7 and ADR §9, made concrete. The agent's capability set expands at runtime, per job, automatically — without the operator wiring anything.


Job declares / agent infers it needs capability X
  → E3 checks the Job's LOCAL skill set first        (already cached/loaded? use it, done)
  → else E4 Marketplace Client asks the MCP Skill-Broker:
        search_skills(query = job intent)             (vector search over name+description)
  → broker returns ranked candidates                  (relevance × version × signature/trust)
  → pick best → download_skill(id, version)
  → materialize SKILL.md bundle into THIS Job's .claude/skills/   (per-job, ephemeral, scoped)
  → verify SHA256 content manifest + signature/provenance        (BEFORE it can load)
  → Agent SDK loads the skill at session start / reload           (write-to-disk + reload)
  → agent uses it; any MCP tools it carries route through the Gateway (§8.4)
  → on Job end → unload / cache per policy

**Why a Skill-Broker MCP server and not the filesystem directly.** The Claude Agent SDK discovers skills **from the filesystem only at session start** — there is no programmatic mid-session "register a skill" API. The emerging standards fix is to serve skills as **MCP Resources** (standards-track **SEP-2640**: connect once, server-side updates, versioning), with working OSS prior art:

| Building block | What it provides | Use in Maestro |
|---|---|---|
| **FastMCP Skills Provider** | `skill://name/SKILL.md` resources + SHA256 `_manifest` + `sync_skills`-to-disk | Base for the broker's materialize + integrity path |
| **skills-mcp** | Vector search over name+description (`bge-small-en-v1.5` embeddings) | Pattern for `search_skills` semantic ranking |
| **mcp-skillset** | Hybrid vector + knowledge-graph RAG, on-demand load | Optional richer ranking for large registries |
| **SEP-2640** | Standards-track skills-as-MCP-Resources (still experimental) | Forward-compat target; Maestro is drop-in compatible when it ratifies |

The **two genuinely hard, build-it-yourself problems** here (everything else has OSS) are:

1. **The mid-session reload UX** — closing the no-runtime-register-API gap with a clean write-to-disk + session-reload/restart experience that doesn't lose job state. Maestro reloads via the durable session checkpoint (ADR §8): the JSONL session is the resume point, so a reload to pick up a freshly downloaded skill resumes from the last checkpoint, not from zero. (Note the documented cache cost: MCP-bearing reloads invalidate the prompt cache and may need `--force`; the budget ledger accounts for this.)
2. **The continuous rug-pull-resistant security pipeline** (§8.5).

**Per-job ephemerality and scoping.** A downloaded skill is materialized into the *Job's* `.claude/skills/`, not a global directory. It is scoped to that Session, sandboxed in the Extension/Skill Host (ADR §2), and unloaded or cached on job end per policy. This directly satisfies **SK-1 (per-job separated skills — each job gets exactly the skills it needs)** and **SK-4 (download + load for that job's session)**. Project Templates seed a Project's default skill set (ADR §7 inheritance: Project default set → Session ephemeral add/remove); a Session can add or remove on top, but skills do not silently leak across jobs.

#### Functional Requirements — dynamic-skill loop

- **FR-SK-LOOP-1** — E3 MUST first satisfy a capability need from the Job's local/cached skill set before any registry call. *(SK-1, SK-4)*
- **FR-SK-LOOP-2** — On a miss, E4 MUST issue a **semantic** `search_skills` query derived from job intent against the operator's registry and rank candidates by relevance, version, and signature/trust. *(SK-3)*
- **FR-SK-LOOP-3** — The selected skill MUST be downloaded, **integrity- and signature-verified before load**, and materialized into the **Job-scoped** `.claude/skills/`. *(SK-4, SK-5)*
- **FR-SK-LOOP-4** — Loading a newly downloaded skill mid-job MUST use the write-to-disk + session-reload path with **checkpoint/resume**, never a from-zero restart. *(SK-4, ADR §8)*
- **FR-SK-LOOP-5** — On job end, skills MUST unload or cache per a declared policy; cached skills MUST NOT be implicitly available to unrelated jobs. *(SK-1, SK-5)*
- **FR-SK-LOOP-6** — Registry-fetch, container-hours, reload cache-invalidation, and search costs MUST be reported to the unified budget ledger (ADR §16). *(NFR cost)*

#### Acceptance Criteria — dynamic-skill loop

- **AC-SK-LOOP-1** — Given a job whose template lacks capability X, when the agent needs X, then a single registry round-trip results in the correct skill being loaded **into that job's session only**, and an unrelated concurrent job does not gain X.
- **AC-SK-LOOP-2** — A skill whose downloaded bytes fail SHA256/signature verification is **never loaded**; the job records a verification-failure audit event and continues without it (or halts at a gate per policy).
- **AC-SK-LOOP-3** — A mid-job skill load resumes the agent from its last checkpoint with no loss of prior tool results or transcript.
- **AC-SK-LOOP-4** — Registry metadata for the *entire* registry is never resident in the model context; only ranked search results (Level-1 of matched candidates) appear. Measured per-turn token cost does not grow with total registry size.
- **AC-SK-LOOP-5** — Every skill download, verification, load, and unload appears in the append-only audit log with the skill id, version, and content hash.

### 8.4 Mandatory MCP Gateway (E2): the single capability chokepoint

**Binding rule (ADR §2, §9, invariant #4):** the engine (Claude builder/driver/subagents) **and** the GPT reviewer **NEVER talk to a third-party MCP server directly.** ALL third-party MCP/tool traffic — for both consumers — routes through **one mandatory MCP Gateway** process. It is the single enforcement point for scoping, allow/deny, audit, signature verification, and per-job identity. Because it is model-agnostic, the builder and reviewer share exactly one policy.

**Why this is non-negotiable (the security reality).** Scans of 8,000+ public MCP servers found **41% with zero auth, 43% with unsafe command-exec paths, 37% SSRF-vulnerable**; Censys found 12,520 internet-exposed, mostly-unauthenticated MCP services. Anthropic explicitly treats every skill/plugin/server as **arbitrary code execution with user privileges**. A chokepoint is the only credible containment.

**Gateway responsibilities:**

- **Per-project / per-job scoping (SK-6).** Deny-by-default. A Project declares an allowed-servers/allowed-tools manifest (committable, env-var secret indirection — never hardcoded keys). A Job/Session can only **narrow** that allowlist, never widen it (ADR §7 inheritance). On project switch, `notifications/tools/list_changed` re-scopes exposed tools without a reconnect.
- **Per-job ephemeral identities ("Agent Bundles").** Each Job runs under a short-lived M2M identity with **independently revocable, audience-bound, capability-scoped tokens**, so a compromised or rogue tool cannot escalate beyond that single job, and the operator can revoke one job's grants without touching others. User OAuth tokens are **never passed through verbatim** (token-passthrough abuse was the root of 9 documented OAuth CVEs).
- **Context-bloat control (`defer_loading` / Tool Search on by default).** MCP context cost is the dominant scaling problem: **4 servers ≈ 51K tokens (~47% of a 200K window); 7+ servers exceed 67K before any user input** (Perplexity publicly dropped MCP internally over ~72% context waste). Maestro defaults tools to `defer_loading:true` and uses the **Anthropic Tool Search Tool** (GA Feb 2026): only a search interface + a small set of critical tools load up front. Reported lift: **~85% startup-token reduction (75K → ~8K); Opus tool-selection accuracy 79.5% → 88.1%.** Requires beta headers `advanced-tool-use-2025-11-20` (+ `mcp-client-2025-11-20` for MCP toolsets) — wrapped by the capability-negotiation layer (§8.6). Because Tool Search is still beta and can mis-select on complex workflows, the Gateway also supports **deterministic server-side tool filtering** as a fallback for scheduled/automated jobs (a fixed ~5–15 critical tools per project).
- **Signature / provenance verification.** Verify signed/attested artifacts before exposing a server. Prefer the **Official MCP Registry** (`registry.modelcontextprotocol.io`) with reverse-DNS namespaces tied to verified GitHub/domain ownership (anti-spoofing); the **Docker MCP Catalog** of signed/attested images; layer Glama/PulseMCP/Smithery as *enrichment only*, never as an unscanned trust source.
- **Audit.** Every tool call, its scope, its job identity, and its outcome is written to the append-only audit log (ADR §7/§16).
- **Durable long-running tools (SEP-1686).** Polling + deferred results for long video renders and scheduler jobs, so a multi-minute tool call doesn't block the agent loop.
- **Transports.** `stdio` only for sandboxed tools bundled into the desktop/mobile host; **Streamable HTTP** for all remote/hosted/registry servers.

**Gateway implementation choice (ADR §9 / build-vs-buy):**

| Concern | Choice | Rationale |
|---|---|---|
| **Local untrusted tools** | **Docker MCP Gateway** (container isolation + `--verify-signatures` against signed SBOMs) | Container sandbox + attestation; the standard local mitigation |
| **Scoping / audit / per-job identity** | **OSS first** — IBM ContextForge (Apache-licensed gateway) as the base, extended with Maestro's per-job Agent-Bundle scoping | Avoids lock-in; single-operator means heavyweight commercial RBAC gateways (MintMCP's Virtual/Agent Bundles, SSO/SCIM) are **out of scope** — Maestro implements only the per-job scoped-token slice, not seat/role management |
| **Tool-context reduction** | Anthropic Tool Search Tool (`defer_loading`) + deterministic gateway-side filter fallback | ~85% startup-token cut, with a non-beta fallback for automated jobs |

> **Scope note.** MintMCP-style RBAC, SSO, and SCIM are multi-user features and are **Non-Goals** (ADR §0). Maestro keeps only the *per-job revocable scoped token* mechanic ("Agent Bundle"), which is a single-operator containment primitive, not an identity product.

#### Functional Requirements — MCP Gateway

- **FR-MCP-1** — 100% of third-party MCP/tool calls from **both** the engine and the reviewer MUST traverse the Gateway; direct engine→server connections MUST be impossible by construction. *(SK-6, ADR inv. #4)*
- **FR-MCP-2** — The Gateway MUST enforce a deny-by-default per-project allowlist; a Job/Session MUST only be able to **narrow** it. *(SK-6)*
- **FR-MCP-3** — Each Job MUST run under an ephemeral, independently revocable, capability-scoped identity; user OAuth tokens MUST NOT be forwarded verbatim. *(SK-5, ADR §6)*
- **FR-MCP-4** — Tools MUST default to deferred loading with Tool Search; automated/scheduled jobs MUST have a deterministic tool-filter fallback. *(performance/cost)*
- **FR-MCP-5** — The Gateway MUST verify server signatures/provenance and prefer reverse-DNS-verified registry namespaces before exposing any server. *(SK-5)*
- **FR-MCP-6** — Long-running tool calls MUST use durable polling/deferred results (SEP-1686) so the agent loop is not blocked. *(reliability)*
- **FR-MCP-7** — Every tool invocation MUST be audited with job identity, granted scope, and outcome. *(observability)*

#### Acceptance Criteria — MCP Gateway

- **AC-MCP-1** — Attempting to register a tool call to a server not on the project allowlist is rejected with an audit entry; the agent receives a deny, not the data.
- **AC-MCP-2** — Revoking one job's Agent-Bundle token immediately blocks that job's further tool calls while other concurrent jobs are unaffected.
- **AC-MCP-3** — With `defer_loading` on, measured startup tool-schema tokens for a project with 4+ servers are reduced by an order of magnitude versus eager loading (target: ≥75% reduction).
- **AC-MCP-4** — A server whose signature/provenance fails verification cannot be attached to any job.
- **AC-MCP-5** — A multi-minute render tool returns via deferred result without stalling or timing out the agent session.

### 8.5 Continuous security pipeline: sandbox, sign, and re-scan for rug-pulls

Install-time review is **insufficient** by design failure: the named attack class **rug-pull** mutates a tool/skill description *after* approval, defeating any one-time check. Maestro's security posture is therefore **continuous, not one-time** (ADR §9, invariant #4).

**Threat model (concrete, from research):** tool poisoning (malicious instructions hidden in tool descriptions), rug-pull (post-install description mutation), token-passthrough abuse, SSRF, unsafe command-exec, and supply-chain trojans (the Dec 2025 `lotusbail` Baileys-wrapper trojan, >50K installs, added an attacker as a linked device and persisted after uninstall). Maestro treats **every skill, plugin, and MCP server as hostile code with user privileges.**

**Defenses (layered):**

1. **Sandboxed Extension/Skill Host (ADR §2).** Skills and MCP servers load in an isolated Node `utilityProcess` (VS Code extension-host model), **never** touching the Electron Main process, with **deny-by-default network and filesystem** and a capability-scoped token. A compromised skill is contained to its sandbox + its job scope.
2. **Pre-ingest review + static scan.** Before a skill/server is listed in the operator's registry, a GPT-based review + static scan flags: external-URL fetches, unexpected network calls, command-exec paths, and **tool-use mismatched to stated purpose** (a "weather" tool that reads `~/.ssh`).
3. **Pin content hashes + commit SHAs.** FastMCP `_manifest` SHA256 for skill bundles; commit-SHA pinning for Git-distributed plugins. The loaded bytes must match the approved hash or they don't load (§8.3, AC-SK-LOOP-2).
4. **Continuous re-scan (the rug-pull defense).** Re-run review + static scan **on every update**, and detect **description-hash drift** between approved and live tool/skill descriptions. A drifted description is quarantined and re-gated, not silently trusted.
5. **Signing / provenance on the operator's own skills.** The operator signs the skills they publish to their registry; downstream loads verify the signature. Provenance is recorded in the audit log.
6. **HITL on destructive/irreversible tool calls.** Human-in-the-loop approval (durable gate, ADR §10) for any irreversible action a skill/tool attempts (file deletion, publish, send, payment-less but irreversible external mutation).

> **Code-exec container caveat (why Maestro does NOT use Anthropic `/v1/skills` as the loader).** Anthropic's hosted Skills API container has **ZERO network access**, which would kill any skill that calls render/comms/model APIs — i.e., most of Maestro's studio and comms skills. Maestro therefore materializes to the filesystem and loads via the Agent SDK on full-network hosts, reserving any no-network execution only for self-contained document/data skills (ADR §9 REJECTED list).

#### Functional Requirements — security pipeline

- **FR-SEC-1** — Skills and MCP servers MUST execute only in the sandboxed Extension/Skill Host with deny-by-default network/FS and capability-scoped tokens. *(SK-5, ADR §2)*
- **FR-SEC-2** — Every skill/server MUST pass pre-ingest GPT review + static scan **before** registry listing. *(SK-5)*
- **FR-SEC-3** — The system MUST pin content hashes + commit SHAs and refuse to load bytes that don't match the approved hash. *(SK-5)*
- **FR-SEC-4** — The system MUST re-scan on every update and detect description-hash drift, quarantining drifted skills/tools for re-approval (rug-pull defense). *(SK-5)*
- **FR-SEC-5** — Destructive/irreversible tool calls MUST hit a durable HITL gate. *(ADR §10)*
- **FR-SEC-6** — The operator's published skills MUST be signed; loads MUST verify the signature and record provenance. *(SK-2, SK-5)*

#### Acceptance Criteria — security pipeline

- **AC-SEC-1** — A skill that adds a network-exfiltration call in an update is flagged on re-scan and quarantined before any job can load the new version.
- **AC-SEC-2** — A tool whose live description hash differs from its approved hash is blocked from use until re-approved, with an audit entry.
- **AC-SEC-3** — A sandboxed skill cannot read a filesystem path or reach a network host outside its declared, operator-approved capability set.
- **AC-SEC-4** — An attempt by a skill to perform an irreversible action without an approved HITL gate is blocked.

### 8.6 The personal skill registry (E4): publish, search, version, update — NO payments

The "marketplace" is the **operator's own online skill registry** — a personal package registry the operator fully controls (ADR §0, §19 `services/skill-registry/`). It may be public/shareable, but it is **npm-for-skills with no economy attached**.

**What it is NOT (explicit Non-Goals — do not reintroduce):**

- **No payment layer, no pricing, no tiers, no free-tier gating.**
- **No creator payouts, no take-rate / revenue split (e.g. the "80/20 creator split" some catalogs use), no Stripe Connect, no Telegram Stars billing, no refunds/VAT/tax engine.**
- **No multi-tenant accounts, no teams, no SSO/SCIM/RBAC, no seat licensing.** The registry has exactly one owner: the operator.

**Registry protocol (the four verbs):**

| Operation | Contract | Notes |
|---|---|---|
| **Publish** (SK-2) | `PUT skill bundle` (signed) → registry indexes name + description for semantic search | **Unlimited** publishes; the operator can push as many skills as they want |
| **Search** (SK-3) | `search_skills(query)` → vector search over name + description, ranked by relevance × version × signature/trust | Served as MCP (Skill-Broker), SEP-2640-shaped; this is what the agent calls during the loop (§8.3) |
| **Version** (SK-5) | Semantic-versioned skills; `GET .../versions/{version}/content` returns the bundle | Pinned by hash; old versions retained for reproducibility |
| **Update** (SK-5) | Re-publish a new version → triggers the continuous re-scan (§8.5) before it becomes loadable | Update never silently supersedes a running job's pinned version |

**Hosting.** The registry runs as the operator's **own service** (ADR §19): **Cloudflare Workers + Agents SDK** is the recommended host — Streamable HTTP, built-in OAuth 2.1, Durable Objects, hibernation billing (pay only while active; free tier ~100K req/day, paid ~$5/mo min) — ideal for bursty per-job usage. It is **not** bundled into the desktop/mobile binary (it's an online service). The **Official MCP Registry** serves as an upstream source of truth for *third-party* MCP servers the operator chooses to enrich with; the operator's own skill registry is separate and personally owned.

**Closest existing model.** Among the surveyed skill catalogs (tonsofskills ~2,810; skills.sh ~2K; claudeskills.info 658; SkillsMP ~800K GitHub-scraped at min-2-stars; Agensi ~200 curated+scanned), **Agensi is closest to Maestro's target** (curated + security-scanned + live-MCP) — **minus its creator-revenue-split economy, which Maestro drops entirely.** The 800K-scraped, min-2-star catalogs are the anti-model: unreviewed supply chain; Maestro never exposes unscanned skills.

#### Functional Requirements — personal registry

- **FR-REG-1** — The operator MUST be able to publish unlimited signed skill bundles to their own registry. *(SK-2)*
- **FR-REG-2** — The registry MUST expose semantic `search_skills` (vector over name+description) consumed by the Skill-Broker during the dynamic loop. *(SK-3)*
- **FR-REG-3** — Skills MUST be semantically versioned, hash-pinned, and individually fetchable by version; prior versions retained for reproducibility. *(SK-5)*
- **FR-REG-4** — Publishing an update MUST trigger the continuous security re-scan (§8.5) before the new version is loadable. *(SK-5)*
- **FR-REG-5** — The registry MUST run as the operator's own network service, separate from the app binary. *(ADR §19)*
- **FR-REG-6 (negative requirement)** — The registry MUST NOT implement any payment, pricing, payout, take-rate, billing, multi-tenant, or RBAC mechanism. *(ADR §0)*

#### Acceptance Criteria — personal registry

- **AC-REG-1** — The operator can publish 50+ skills in succession; all become searchable with no per-skill limit and no payment step anywhere in the flow.
- **AC-REG-2** — A search query returns the most relevant skill for a job intent, ranked above near-miss candidates, using vector similarity over name+description.
- **AC-REG-3** — Pinning a job to skill `foo@1.2.0` keeps that job on `1.2.0` even after `1.3.0` is published.
- **AC-REG-4** — No code path in the registry references currency, price, payout, take-rate, tenant, org, role, or seat.

### 8.7 Capability-negotiation layer: surviving spec & beta-header churn

The skills/MCP runtime is the fastest-churning surface in the platform (spec rev 2025-06-18 → 2025-11-25; multiple beta headers; SEP-2640 and SEP-1686 still experimental; Tool Search still beta). A thin **capability-negotiation layer** wraps these so churn never breaks Maestro (ADR §9 SEAM):

- Wraps spec revisions (Streamable HTTP / 2025-11-25) and beta headers (`mcp-client-2025-11-20`, `advanced-tool-use-2025-11-20`, `skills-2025-10-02`) behind feature flags negotiated at connect time.
- Degrades gracefully: if Tool Search is unavailable, fall back to deterministic gateway-side tool filtering; if SEP-2640 mid-session register lands, swap in the native path without changing callers; if `list_changed` is unsupported by a client, fall back to reconnect-on-scope-change.
- Keeps tool definitions in **portable MCP servers behind the Gateway** and skills in **portable `SKILL.md`**, so Anthropic-runtime-specific pieces (`/v1/skills`, MCP Connector, beta headers) remain swappable and never load-bearing.

### 8.8 Seams (swap points) and module mapping

| Seam | Interface | Today | Swap target |
|---|---|---|---|
| **Discovery** (E4) | `search_skills` / `download_skill` (Skill-Broker MCP, SEP-2640-shaped) | FastMCP Skills Provider + vector search | Native SEP-2640 register API when ratified |
| **Security / scoping** (E2) | MCP Gateway (deny-by-default, per-job Agent Bundle, signature verify, audit) | OSS ContextForge base + Docker MCP Gateway sandbox + Maestro per-job scoping | Alternate gateway behind same policy contract |
| **Execution sandbox** | Extension/Skill Host `utilityProcess` (ADR §2/§18) | Electron `utilityProcess` | Tauri sidecar on re-shell |
| **Spec/header churn** | Capability-negotiation layer | beta-header feature flags | New spec revs as config |
| **Registry hosting** (E4) | `services/skill-registry/` | Cloudflare Workers + Agents SDK | Self-hosted container |

**Requirement coverage:** SK-1 (per-job separated skills) → §8.3; SK-2 (publish unlimited) → §8.6; SK-3 (search) → §8.3/§8.6; SK-4 (download + load per session) → §8.3; SK-5 (versioning, updates, sandboxing, trust) → §8.3/§8.5/§8.6; SK-6 (scoped MCP servers/tools per project/job) → §8.4. Modules: **E2** (MCP/Tools Manager) → §8.4; **E3** (Skills Subsystem) → §8.2/§8.3; **E4** (Marketplace/Registry Client) → §8.6. Upholds ADR invariant **#4** (mandatory gateway, arbitrary-code treatment, continuous rug-pull re-scan) and **#10** (one capability-scoped contract, first- and third-party identical).


## 9. Orchestration & Multi-Agent Workflows

> **Scope note (single operator):** This section concerns module **E5 (Orchestration / Workflow Engine)** — see decomposition §5, Layer 1. All orchestration serves one operator's own jobs. There is no concept of cross-tenant scheduling, shared queues, team-level approval routing, or per-seat concurrency. "Concurrency" means *how many of the operator's own agents run at once*, governed solely by the operator's machine, budget ceiling (ADR §7/§16), and explicit per-project concurrency settings. Every model ID/price below is point-in-time mid-2026 config routed through the LiteLLM router (ADR §4), never hard-coded.

### 9.1 Purpose & Position in the Architecture

E5 is the layer that turns a **Job** into actual agent execution. Per the canonical hierarchy (ADR §7), `Workspace → Project → Sub-project → Job → Session`, a Job is the unit of scheduled/triggered work and a Session is a single live agent run. **E5 owns the gap between them**: it decides whether a Job runs as one Session (single agent with tools) or as a *workflow* — a declarative graph of multiple Sessions wired together with build/review/fan-out/judge/gate nodes.

E5 sits directly on two seams it never bypasses:

- The **`AgentEngine` interface** (ADR §3) — `plan / build / review / stream / resume` — so every node is engine-agnostic (Claude Agent SDK primary, OpenHands fallback per ADR §17).
- The **`Router`** (ADR §4) — every node names a **logical role** (`builder`, `driver`, `subagent`, `reviewer`) and an **`Effort`** (ADR §5), never a concrete model ID.

It is **driven by**, not coupled to, the scheduler (D2 / ADR §8): the scheduler decides *when* a Job fires and provides durability (checkpoint/resume, idempotency, misfire policy); E5 decides *how the work is shaped* once fired. This separation is load-bearing — §9.8 details the contract between them.

Per decomposition E5 depends on **E1 (Agent Runtime)** and **E3 (Skills)**: workflows compose engine sessions and pull per-session skills from the operator's registry (ADR §9). Trend/research intelligence (**D6**, decomposition §5) is a *consumer* of E5 — its multi-step genre-research pipelines are E5 workflows feeding D4 Media Studio.

This section satisfies **AE‑5** (plan mode, subagents, sessions, hooks), the review-model loop behind **AE‑2** + **AE‑4**, and the multi-agent workflow capability named in the mental model (decomposition §4, "Workflow (optional multi-agent orchestration)").

### 9.2 Core Design Principle — Single-Agent by Default

The binding decision (ADR §10) is **single-agent-with-tools by default; escalate to multi-agent only when provably breadth-first.** This is non-negotiable and grounded in the research:

| Finding | Source | Consequence for E5 |
|---|---|---|
| Multi-agent costs **~15× tokens** vs single-agent | landscape research §3 (orchestration topology) | Multi-agent is opt-in/auto-justified, never the default shape |
| Orchestrator-worker (supervisor) is the dominant production pattern (~70% of deployments) | landscape research §3 | The supervisor topology is the *only* multi-agent shape we ship; no free-form agent-to-agent meshes |
| Each hierarchy level adds **~2s** before workers start | landscape research §3 | Hierarchies are **shallow** (orchestrator → workers, no deep nesting) — bad latency kills mobile/Telegram UX |
| Single LLM judges are **adversarially manipulable** | landscape research §4 (LLM-as-judge) | Auto-merge/auto-publish decisions use **judge panels (PoLL)**, not a lone judge (§9.6) |
| High/xhigh effort is **flat-or-worse on many tasks at 4–17× cost, 5–60× latency** (the "effort paradox") | landscape research §4, ADR §5 | Workflow nodes default to BALANCED effort; DEEP/MAX and judge panels are reserved, eval-gated, cost-surfaced (§9.7) |

**Default decision tree for a Job:**


Job fires
 ├─ Is the work a single bounded task achievable by one agent + its skills/tools?
 │     → YES  → single Session (the 90% case). No orchestration overhead.
 │     → NO   → is it provably breadth-first (N independent sub-items, N unknown at design time)?
 │                 → YES → fan-out / map-reduce workflow (§9.5)
 │                 → NO  → is it a build-quality-gated deliverable (code/creative artifact)?
 │                          → YES → plan→build→review workflow (§9.4)
 │                          → NO  → pipeline workflow (ordered stages, §9.5)

### 9.3 A Job Is a Single Agent OR a Workflow — One Unified Contract

A Job carries a **`shape`** field resolved at enqueue time. Both shapes produce the same observable surface (live stream, transcript, budget ledger entries, audit log, HITL gates, mobile/Telegram visibility), so the operator never has to know which shape ran except where it matters.

| `shape` | What runs | Token/latency profile | When chosen |
|---|---|---|---|
| `single` | One Session: one `AgentEngine` `query()` loop with its skills + scoped MCP tools | 1× (baseline) | Default; the bounded-task 90% case |
| `plan-build-review` | Plan node → Build node → (eval-gated) Review node → fix loop → HITL gate | 1.3–3× depending on review depth and fix iterations | Quality-gated code/creative deliverables (AE‑1 + AE‑2) |
| `fan-out` | Orchestrator splits → N worker Sessions (map) → reduce/aggregate Session | ~N× workers + reduce overhead | Breadth-first work, N unknown at design time |
| `pipeline` | Ordered stage Sessions, each consuming the prior's output | Sum of stages | Known multi-stage flows (e.g. research → script → render → publish) |
| `judge-panel` (modifier) | Adds a panel-of-judges decision node to any of the above | +K judge calls (K=3 typical) | Gating an auto-merge / auto-publish decision (§9.6) |

**Workflows are declarative graphs, not code** (ADR §10 seam). A workflow is data — a DAG of typed nodes (`plan` / `build` / `review` / `fanout` / `reduce` / `judge` / `gate` / `tool`) over the `AgentEngine` + `Router`. This means:

- A **Project Template** (decomposition §4; "Claude-Code", "Claude-Design") can ship a default workflow graph as preset data — e.g. the Code template defaults code Jobs to `plan-build-review`, the Content template defaults to a `pipeline` (research → script → media → publish).
- New workflows are authored/edited without touching the engine — they can even be packaged **as skills** in the operator's registry (ADR §9).
- The graph is the unit of checkpoint/resume (§9.8): the scheduler persists *which node* a Job reached.

**Functional requirements (E5 core):**

- **FR‑E5‑1** — Every Job resolves to exactly one `shape`; `single` is the default when the Project Template specifies none.
- **FR‑E5‑2** — Workflows are stored as declarative DAGs; the engine executes nodes, never bespoke per-workflow code.
- **FR‑E5‑3** — Every node names a logical role + Effort; no node may name a concrete model ID (enforced at graph-validation time).
- **FR‑E5‑4** — Build and review passes carry **independent** Effort settings (AE‑4; ADR §5) — a job can build at BALANCED and review at DEEP, or vice versa.
- **FR‑E5‑5** — Single-agent and every workflow shape emit identical observable surfaces (stream, transcript, ledger, audit, gates).

**Acceptance criteria:**

- **AC‑E5‑1** — A Job with no template-specified shape runs as a single Session and produces a resumable JSONL transcript (ADR §7).
- **AC‑E5‑2** — A graph naming a raw model ID (e.g. `claude-opus-4-8`) in any node fails validation with a clear error before enqueue.
- **AC‑E5‑3** — Switching a code Job from `single` to `plan-build-review` requires no engine code change — only the Job's `shape`/graph data.
- **AC‑E5‑4** — A workflow interrupted mid-graph by OS sleep/restart resumes at the last completed node, not from node zero (verified against ADR §8 checkpoint/resume).

### 9.4 The plan → build → review Loop (the headline workflow)

This is the workflow behind the product's "Claude builds, GPT reviews" promise (decomposition §8, the Review-Model Loop; AE‑1 + AE‑2). Per ADR §3 and §10, the loop is:


Plan   (Claude builder, DEEP effort + mandatory human checkpoint by default)
  → Build  (Claude builder/driver)
  → Review (GPT reviewer — ONLY IF eval-gated on; see §9.4.3)
        → findings → Fix loop (builder addresses findings)
        → re-review until clean OR max-iterations OR gate
  → HITL gate (desktop / mobile / Telegram) on any sensitive/irreversible action

#### 9.4.1 Roles & models (config — re-verify against the Vendor Register)

| Node | Logical role | Default model (mid-2026, ADR §3) | Effort default | Notes |
|---|---|---|---|---|
| **Plan** | `builder` | Claude **Opus 4.8** `claude-opus-4-8` ($5/$25 per MTok, 1M ctx, 128k out) | **DEEP** (`high`/`xhigh`) + human checkpoint | Plan mode (AE‑5); plan is the cheapest place to catch direction errors |
| **Build** | `builder` / `driver` | Opus 4.8 builder for hard work; **Sonnet 4.6** `claude-sonnet-4-6` ($3/$15) for most turns | **BALANCED** | Driver handles the bulk of production turns (ADR §3) |
| **Review** | `reviewer` | **GPT-5.1** `gpt-5.1` ($1.25/$10, cached-in $0.125, ~1.05M ctx — fits whole PRs); **GPT-5.1-Codex-Max** when the reviewer must read repo / run read-only commands | **BALANCED→DEEP** per job; low `verbosity` for terse critiques | Reviewer ID is **config with a fallback chain** — the research itself disagrees (GPT-5.1 vs 5.5); never hard-code |
| **Fix** | `builder` / `driver` | Same as Build | inherits Build | Addresses reviewer findings |
| **Subagent fan-out within build** | `subagent` | **Haiku 4.5** `claude-haiku-4-5` ($1/$5) | FAST | Cheap classification/sub-tasks (ADR §3) |

Cross-vendor critique is the rationale: an independent GPT reviewer catches single-vendor blind spots — validated by OpenAI's own Codex "Code review" feature and Aider's architect/editor split (landscape research §2). **Caveat carried forward:** independent benchmarks show Claude still leads SWE-bench Pro with lower hallucination, so the reviewer's lift is **unproven until the eval gate proves it** (§9.4.3).

#### 9.4.2 Effort independence (AE‑4)

Build and review Effort are set independently on the Job/Session (ADR §5), surfaced as two dials in the UI. The Effort→review-depth mapping (ADR §5 table):

| Effort | Build pass | Review pass |
|---|---|---|
| **FAST** | `low` + adaptive thinking | review **off** by default |
| **BALANCED** (default) | `medium`/`high` | light pre-screen review |
| **DEEP** | `high`/`xhigh` | full reviewer loop (if eval-gated on) |
| **MAX** | `xhigh`/`max` | full reviewer loop **+ optional judge panel** (§9.6) |

The **effort-paradox guardrail** applies to every node: default BALANCED, escalate to DEEP/MAX only on operator override or eval-verified-hard task types, and **always surface the cost/latency multiplier before a DEEP/MAX run** (ADR §5/§16).

#### 9.4.3 The reviewer eval gate (binding — the reviewer is droppable, not sacred)

Per ADR §3 and Appendix-A invariant #11, the GPT reviewer ships **on-by-default only if it proves it catches real, otherwise-missed defects at acceptable cost.** E5 must support running the loop **with and without** the review node so the gate can be measured.

- **FR‑E5‑6** — E5 supports a `builder-only` execution mode and a `builder+reviewer` mode for the *same* graph, selectable per run, to feed the golden-task eval harness (ADR §3).
- **FR‑E5‑7** — A golden-task eval harness of representative Maestro jobs (code + creative, known-good outcomes) runs each task both ways and records: defect-catch rate, false-positive rate, added latency, added $ cost.
- **FR‑E5‑8** — The reviewer node's default-on/default-off state is a **config flag driven by eval results**, not a code constant. If lift is marginal, the reviewer becomes an opt-in **DEEP-mode-only** pass.

**Acceptance criteria:**

- **AC‑E5‑5** — Running a code Job in `builder-only` vs `builder+reviewer` produces two ledger entries whose $ and latency deltas are directly comparable in the budget ledger (ADR §16).
- **AC‑E5‑6** — The reviewer can be globally disabled by config without removing the review node from existing graphs (it becomes a no-op pass-through).
- **AC‑E5‑7** — The fix loop terminates on *clean review* OR `max_iterations` OR an HITL gate — never loops unbounded (loop guard via router `max_iterations` + `max_budget_per_session`, ADR §4/§16).

#### 9.4.4 The human gate

Plan mode ends in a **mandatory human checkpoint by default** (ADR §5/§10). The final gate before any sensitive/irreversible action (merge, send, publish, spend above threshold) is a **durable `HumanGate`** (ADR §10) offering **approve / edit / reject / respond**, delivered to whichever surface the operator is on — desktop, mobile (X2), or Telegram (D3). Durability is non-negotiable: a gate survives app restart and OS sleep (ADR §8, invariant #5) — the operator can approve a plan from the train hours later (decomposition §1 success story).

- **AC‑E5‑8** — A pending HITL gate persists across a Core restart and re-presents on the next connected surface; approving it from Telegram resumes the exact paused workflow node.

### 9.5 Fan-out / Map-Reduce & Pipelines

#### 9.5.1 Fan-out (map-reduce)

Per ADR §10 + landscape research §3, **fan-out is used only when item count is unknown at design time.** The shape is strictly orchestrator-worker with a shallow hierarchy:


Orchestrator (driver, Sonnet 4.6) — splits the task into N items
  → map: N worker Sessions in parallel (role per item: subagent/driver), each in its own isolated context
  → reduce: one aggregator Session merges worker outputs into the deliverable

- **Workers are isolated**: each map worker runs as its own Session (its own JSONL transcript, its own scoped skills/tools per ADR §9). A worker cannot widen its tool scope (ADR §2 capability tokens).
- **Concurrency** is bounded by the **Project's concurrency setting** and the global rate-limiter (ADR §8) — the operator decides how many of their own workers run at once; the budget ledger's hard per-project cap (429 on exceed, ADR §16) is the backstop against a fan-out exploding the bill (the Replit "$1k/week autonomous subagent spawning" anti-pattern, landscape research §1).
- **Cheap workers by default**: map workers default to the `subagent` role (Haiku 4.5, $1/$5) unless the item demands `driver`/`builder` — fan-out's token cost is the reason cheap-tier workers matter.

**FR‑E5‑9** — Fan-out workers run with independently scoped skills/tools and isolated transcripts; no worker can widen its grant or read another worker's context.
**FR‑E5‑10** — Total concurrent workers is capped by Project concurrency settings AND the per-project budget cap; exceeding either queues or 429s the remainder.

**AC‑E5‑9** — A fan-out Job over an N-item set (N discovered at runtime) launches ≤ the Project concurrency limit of workers at once, queues the rest, and the reduce node runs only after all workers complete or are accounted as failed.
**AC‑E5‑10** — Killing one worker (timeout/error) does not corrupt sibling workers; the reduce node receives a partial set with explicit failure markers, and the misfire policy (ADR §8) governs retry.

#### 9.5.2 Pipelines

A pipeline is an **ordered chain of stage Sessions** for known multi-stage flows. The canonical example is the creative loop (decomposition §1, §5 D4/D5/D6):


Trend/genre research (D6 — driver + web/research tools)
  → script/brief (builder)
  → media generation (D4 — *Job nodes: ImageJob/VideoJob/VoiceJob/AvatarJob, ADR §13)
  → assembly/render (Remotion on Media Workers, async + webhook, ADR §13)
  → publish (D5 — PublishProvider, draft-mode HITL gate, ADR §14)

Pipeline stages that dispatch long-running async work (video render ≈ minutes; a single 4K+audio minute ≈ $35–45 per ADR §16) **must not block a chat turn** (ADR §13). The pipeline node submits with a `webhook_url`, persists the job ID in the scheduler (ADR §8), and the workflow *suspends* until the webhook (or polling fallback) fires — leveraging **durable-task semantics (MCP SEP-1686, polling + deferred results)** flagged in skills research §1. This is the same suspend/resume machinery as the HITL gate (§9.8).

**AC‑E5‑11** — A pipeline stage awaiting a multi-minute media render holds zero LLM context cost while suspended (suspended workflows are persisted, not held in a live agent loop) and resumes on webhook or polling fallback.

### 9.6 Adversarial Verification & Judge Panels (auto-merge / auto-publish)

For decisions that auto-commit an irreversible action **without** a human gate — auto-merge of code, auto-publish of media (decomposition DI‑1) — a single LLM judge is **forbidden** (ADR §10): single judges are adversarially manipulable (landscape research §4). E5 uses a **panel-of-judges (PoLL)** decision node.

**Mechanics:**

- **K independent judges** (K=3 default, odd to avoid ties), each a *different* logical configuration where possible — ideally **cross-vendor diversity** (e.g. a Claude judge, a GPT judge, and a second-Claude-at-different-effort judge) so no single vendor's blind spot dominates. Each judge scores against an explicit rubric (build correctness / test pass / policy / provenance).
- **Adversarial verification** mode: one judge is prompted as an explicit *critic/red-team* role tasked with finding reasons to reject, countering the sycophancy bias of agreement-seeking judges.
- **Aggregation**: majority vote for a binary merge/publish gate; for scored decisions, the panel median with a configurable threshold. A tie or below-threshold result **falls back to a human HITL gate** — the panel never silently passes a borderline irreversible action.
- **Cost discipline**: judge panels are reserved for **MAX effort or explicit auto-merge/auto-publish** configurations (ADR §5/§10). Each judge is a real LLM call (+K× cost), so the UI surfaces the panel cost in the pre-run estimate (ADR §16). Judges default to the cheapest tier that the rubric tolerates (Haiku/Sonnet/GPT-5.1) — not the builder tier.

**FR‑E5‑11** — Auto-merge and auto-publish decisions route through a judge-panel node (K≥3) with at least two distinct judge configurations; a single-judge auto-decision is rejected at graph validation.
**FR‑E5‑12** — A judge panel that ties or falls below threshold escalates to a durable HITL gate rather than defaulting to approve.
**FR‑E5‑13** — Provenance/consent checks (C2PA / SynthID labeling, biometric consent — ADR §14) are mandatory rubric items for any auto-publish judge panel; a missing label is an automatic reject.

**AC‑E5‑12** — An auto-publish workflow with a deliberately policy-violating asset (e.g. missing AI-labeling) is rejected by the panel and escalated to a human gate, never published.
**AC‑E5‑13** — Disabling auto-merge for a Project forces every merge decision to a human gate regardless of panel verdict.

### 9.7 Durable, Long-Running Workflows

Maestro's premise is jobs that survive sleep, restart, and network blips (decomposition §3.9 reliability; ADR §8/§17). E5 inherits durability from the scheduler rather than reimplementing it:

- **Checkpoint granularity = the workflow node.** The scheduler (ADR §8) persists which DAG node a Job reached plus the node's inputs; the agent's resumable/forkable **JSONL session** (ADR §3/§7) is the in-node resume point. A workflow interrupted by lid-close/restart resumes at its last completed node, not from zero (ADR §8 checkpoint/resume; invariant #5).
- **Suspension is free.** Workflows suspended awaiting (a) a human gate, (b) a long async media render, or (c) a scheduled delay hold **no live agent loop and no LLM context cost** — they are persisted scheduler state, woken by gate-approval, webhook, polling fallback, or cron. This is the durable-task pattern (SEP-1686, skills research §1) and is what makes "research and publish 3 videos this week on a schedule" (decomposition §1) economically viable.
- **Idempotency + misfire policy** (ADR §8) apply per node: at-least-once delivery means node re-execution after a crash must be idempotency-keyed; a Quartz-style misfire policy (fire-now / skip / coalesce) governs nodes that should have fired during downtime.
- **A wake-lock is NOT the guarantee.** Reference-counted prevent-sleep (ADR §15) keeps the machine awake *while actively working*, but forced sleep/hibernate still interrupts — **durable resume is the actual completion guarantee** (ADR §8/§17, invariant #5).

**FR‑E5‑14** — Every workflow node is independently checkpointed; suspended-pending nodes consume no LLM/agent resources until woken.
**FR‑E5‑15** — Node re-execution after crash/restart is idempotency-keyed; no node double-commits a side effect (send/publish/merge/spend).

**AC‑E5‑14** — A multi-day pipeline (research → render → scheduled publish) survives a full machine restart between every stage and completes correctly.
**AC‑E5‑15** — Force-quitting the Core during a build node and relaunching resumes the workflow at that build node using the persisted JSONL session, with no duplicated tool side effects.

### 9.8 Relationship to the Scheduler & Effort Controls

E5 and the scheduler (D2 / ADR §8) have a clean, one-directional contract — **the scheduler drives E5; E5 never owns timing or durability.**

| Concern | Owner | Interface |
|---|---|---|
| *When* a Job fires (cron, manual, comms-message, webhook — PJ‑3/PJ‑4/PJ‑5) | Scheduler (D2) | `TriggerSource` registry (ADR §8) |
| Durability: checkpoint, resume, idempotency, misfire | Scheduler (D2) | `JobQueue` (`enqueue/schedule/checkpoint/resume/onComplete`, ADR §8) |
| Concurrency + rate-limit (per-project, global) | Scheduler (D2) | BullMQ/Redis concurrency + rate-limiter (ADR §8) |
| *How* the Job is shaped (single vs workflow graph) | E5 | declarative DAG over `AgentEngine` + `Router` (ADR §10) |
| Suspension/wake on gate/webhook/delay | E5 ↔ Scheduler | E5 yields a suspend token; scheduler persists + wakes |
| Completion fan-out to mobile push / Telegram | Scheduler → F5/F4/D3 | `onComplete` → push (ADR §8/§15) |

**Effort controls** thread through both:

- Effort is set on the **Job/Session** (ADR §5) and read by **each E5 node** to parameterize its `Router.complete(role, messages, effort)` call. Build and review Effort are independent (§9.4.2).
- The **router enforces the loop guards** (`max_iterations`, `max_budget_per_session`, ADR §4) that bound fix loops and fan-out — E5 relies on the router, not its own counters, so the budget ledger (ADR §16) is the single source of truth.
- The **effort auto-tuner** (ADR §16) reads per-node reasoning-token telemetry (OTel GenAI conventions) and adjusts default Effort per task type — closing the loop so DEEP/MAX is auto-applied only where it has historically paid off, not blindly (the effort-paradox guardrail, ADR §5).
- **Cost discipline on scheduled/background runs:** every eligible E5 node on a scheduled Job uses **Batch API (−50%) + prompt caching (~90% off cached input)** enforced at the router (ADR §4/§16) — multi-agent and judge-panel token multipliers make this mandatory, not optional, for the operator's bill.

**FR‑E5‑16** — E5 requests durability primitives (checkpoint/resume/suspend) from the `JobQueue` interface; it implements none itself.
**FR‑E5‑17** — Every E5 node's model call passes the Job/Session Effort to the router; no node bypasses the router or the budget ledger.
**FR‑E5‑18** — A workflow exceeding its per-project budget cap receives a 429 from the router and suspends to an HITL gate (raise-cap / downgrade / abort), never silently truncating mid-deliverable.

**Acceptance criteria:**

- **AC‑E5‑16** — A scheduled `plan-build-review` Job fires on cron, and every Claude node on that run is billed at Batch+cached rates (verifiable in the budget ledger).
- **AC‑E5‑17** — A fan-out Job that would exceed the Project budget cap mid-map suspends remaining workers and raises an HITL gate offering raise-cap / downgrade-model / abort — it does not blow the cap.
- **AC‑E5‑18** — Toggling a Job's review Effort FAST→DEEP changes only the reviewer node's behavior, leaving the build pass untouched (Effort independence verified).

### 9.9 Non-Goals (single-operator scope)

- **No multi-tenant / team orchestration:** no cross-user queues, no per-seat concurrency, no team-level approval routing or shared workflow libraries gated by role. The only approver is the operator (ADR §0, invariant #1).
- **No SSO/RBAC on workflows:** gates and judge panels are not role-scoped; there is one human, the operator, on whatever surface they're on.
- **No monetized workflow marketplace:** workflows may be packaged as skills in the operator's *own* registry (npm-for-skills, no payment layer — ADR §9/§0); there is no creator economy, take-rate, or paid workflow templates.
- **No "phasing" as product tiers:** all orchestration capabilities (single, plan-build-review, fan-out, pipeline, judge panels, durable resume) are in scope and built. Build order (ADR Appendix B) places the plan→build→review loop + eval-gate + judge panels + HITL gates as the **Orchestration workstream**, parallel after the engine — never a paid upgrade.


## 10. Comms Gateway — Telegram & WhatsApp

> Module **D3**. Requirements **CM‑1..CM‑3**. Governed by ADR §11. Every inbound message is **untrusted input** (prompt‑injection vector) — see §14.

### 10.1 Purpose
A pluggable **comms gateway** that lets the operator trigger jobs, receive reports, and approve HITL gates from chat. One internal `ChannelProvider` interface; channels are swappable adapters. Telegram is the default lane (free, instant, zero ban risk); WhatsApp is a two‑lane adapter the operator opts into.

### 10.2 Channel decision (locked, ADR §11)
| | Telegram (default) | WhatsApp Lane A — unofficial | WhatsApp Lane B — official |
|---|---|---|---|
| Library | **grammY** (TS) | **whatsmeow** (Go sidecar) primary; Baileys/Evolution secondary | Cloud API via BSP |
| Number | Bot (@BotFather) | The operator's **own** number | Business number |
| Cost | Free | Free | ~$0.004–0.025/msg |
| Ban risk | None | **High** (accounts 2–8 wks; opt‑in, isolated process) | Near‑zero, but Meta's Jan 2026 general‑purpose‑AI ban applies |
| Media | 50MB cloud / **2GB self‑hosted Bot API server** | Full app parity | Template‑gated |

The runtime already exposes an `mcp__whatsapp__*` toolset (QR/pairing, send text/image/video/doc, groups, status) — Lane A wraps it. Lane A runs in an **isolated sidecar process** so a ban or supply‑chain compromise (cf. the `lotusbail` Baileys trojan, §14) cannot touch Maestro Core.

### 10.3 Functional requirements
- **CM‑GW‑1** Unified `ChannelProvider` (send/receive/edit/react/typing, media up/down, structured buttons) with adapters for Telegram + WhatsApp two‑lane; adding a channel (Slack/Discord/email) is a new adapter, no core change.
- **CM‑GW‑2** **Inbound → job routing:** a message matched to a project (by chat‑binding) enqueues a job on the scheduler (D2) with the message as input; replies stream back to the same thread.
- **CM‑GW‑3** **Outbound reports:** job lifecycle events (started/gate/done/failed + cost) post to the bound chat; long outputs chunked; media delivered via the 2GB self‑hosted Telegram Bot API server when large.
- **CM‑GW‑4** **Remote HITL approvals:** plan/diff/destructive‑action gates render as inline buttons (Approve / Reject / Edit); the decision resolves the gate in E5.
- **CM‑GW‑5** **Central send queue + rate limiter** across all channels (Telegram 30 msg/s global, per‑chat caps; WhatsApp pacing to reduce ban risk).
- **CM‑GW‑6** Allowlist of authorized chats/senders (single operator → only the operator's own IDs); everything else dropped.

### 10.4 Acceptance criteria
- Sending a project a message from Telegram starts a job and returns a streamed reply in‑thread within the engine's first‑token latency.
- A plan gate can be approved from a phone over Telegram and the desktop job proceeds without focus.
- WhatsApp Lane A runs in a separate OS process; killing it does not affect any running job; a ban warning is shown at enable time.
- Inbound content never reaches a tool call without passing the untrusted‑content review (§14) for any job whose effort/permissions allow side effects.

---

## 11. Mobile App, Remote‑Control Plane, Sync & P2P

> Modules **X2, F5, F6**. Requirements **MB‑1..MB‑4**. Governed by ADR §12. Reconciles the research's P2P‑vs‑relay disagreement: **relay‑first; true P2P is an optional later transport, not the foundation.**

### 11.1 Scope decision — thin client, not on‑device agents
The mobile app is a **remote control + monitor**, explicitly **not** an on‑device agent runtime (Opus‑class work is infeasible on a phone). It drives the desktop‑resident Maestro Core. This single decision (ADR §12) settles offline behavior, key residency, and sync scope.

### 11.2 Transport (locked)
- **Relay‑brokered E2EE WebSocket fabric** (fork **Happy Coder**, MIT, ~80% of the requirement): desktop Core and phone each open an **outbound** WSS to a dumb relay that forwards only encrypted blobs → zero inbound ports, CGNAT/firewall traversal, sleep‑survival.
- Crypto: **X25519/ECDH + AES‑256‑GCM**; **QR pairing** carries the desktop public key + a ~2‑minute one‑time token, then a Noise/ECDH handshake.
- **Reachability layers:** Cloudflare Tunnel (public surfaces) + Tailscale/Headscale/WireGuard (private admin) — swappable.
- **Optional true P2P** (WebRTC data channel / libp2p) as a later enhancement *behind the same interface*, with a `coturn` TURN fallback; never the sole plane (pure P2P fails 15–25% of clients on symmetric NAT/CGNAT).

### 11.3 Sync (locked)
- **Yjs** CRDT for session/scheduler/marketplace state synced desktop↔phone (`op‑sqlite`/MMKV offline persistence); **Automerge 3.0** reserved for versioned/branching subsystems. Sync sits behind a swappable abstraction (Yjs/Automerge/Loro).
- Source of truth is desktop Core (§3); the phone holds a synced replica + an outbox of intents (approvals, new‑job requests) reconciled on reconnect.

### 11.4 Client stack & UX
- **React Native + Expo** (JS/TS reuse with the Node engine, `react‑native‑webrtc`, Yjs JS, provider SDKs). Push via **Expo (FCM/APNs)** with an **ntfy/UnifiedPush** no‑Google escape hatch (APNs 4KB payload cap → thin payloads).
- Mobile surfaces: project/job list + live status, streamed agent timeline, **approve/reject + diff review**, media preview/share, push notifications, voice input (optional).

### 11.5 Functional requirements & acceptance
- **MB‑R‑1** Pair a phone by scanning a desktop QR; pairing token expires ≤2 min; credentials are scoped + revocable.
- **MB‑R‑2** A 20‑minute background build completed on desktop pushes a result notification to the phone; tapping shows the full transcript + diff.
- **MB‑R‑3** Approving a gate on the phone resolves it on desktop with end‑to‑end encryption; the relay never sees plaintext.
- **MB‑R‑4** Going offline and back online reconciles state with no lost approvals and no duplicate jobs (idempotent intents).
- **MB‑R‑5** No inbound port is opened on the desktop; revoking a device immediately invalidates its session.

---

## 12. Creative Media Studio

> Module **D4**. Requirements **MS‑1..MS‑6**. Governed by ADR §13. Core principle: **abstract everything behind normalized job interfaces** — the studio routes, it does not hard‑wire vendors (the market re‑priced/re‑shuffled 4+ times in 6 months).

### 12.1 Normalized interfaces
One internal contract per modality, model selected by config string (each becomes a loadable skill, §8): **`ImageJob`** (generate/edit‑inpaint/multi‑ref/upscale), **`VideoJob`** (prompt, init image, duration, resolution, audio, model‑id, webhook), **`AvatarJob`**, **`VoiceJob`**, **`MusicJob`**, **`CaptionJob`**, **`AssemblyJob`** (Remotion).

### 12.2 Three routing lanes (locked, ADR §13)
1. **Aggregator (primary):** **fal.ai** + **Replicate** secondary — one key, hundreds of endpoints, uniform async/webhook, swap‑by‑string, failover.
2. **First‑party (hero/SLA):** Google **Veo 3.1 / Nano‑Banana (Gemini 3 Image)**, OpenAI **GPT Image** — reuse the agent/review keys; enterprise SLA; first access to new versions.
3. **OSS self‑host (free/no‑ToS‑ban/privacy):** **Wan 2.x (Apache‑2.0), LTX‑2, FLUX.1‑dev, ComfyUI** on RunPod — same interface, UI flips cloud↔local.

### 12.3 Default model‑routing matrix (cost‑optimized; re‑verify against the Vendor Register §18)
| Modality | Draft / high‑volume | Final / hero |
|---|---|---|
| **Image** (MS‑1) | GPT Image Mini ($0.005), Seedream 4.5 ($0.03) | FLUX.2 [pro], FLUX.1 Kontext (edits), Nano‑Banana (chat edit), Ideogram 3 (text‑in‑image), Recraft V3 (SVG/logo) |
| **Video** (MS‑2) | Seedance 2.0 Fast ($0.022/s), Hailuo, Wan | **Veo 3.1** (native audio), **Kling 3.0** (cinematic/dialogue), Runway Aleph/Act‑Two (edit/perf) |
| **Avatar** (MS‑3) | Argil (BYO ElevenLabs voice) | HeyGen Avatar IV/V; D‑ID V4 / Anam / Tavus (real‑time) |
| **Voice** | OpenAI gpt‑4o‑mini‑tts | **ElevenLabs Flash v2.5** / Cartesia Sonic‑3 (low‑latency) |
| **Music** | — | **ElevenLabs Music v2** (the *only* AI music with commercial clearance + an API) |
| **Captions** | — | ElevenLabs Scribe v2 / Deepgram Nova‑3 (word‑level timestamps) |

**Hard exclusions (ADR §13, §18):** **Sora 2** (sunset Sept 24 2026 — do not build on it); **Midjourney** (no API, wrappers violate ToS); **Suno/Udio** (no API + active litigation → user‑pasted assets only).

### 12.4 Kinetic typography / HTML motion graphics (MS‑4)
**Remotion** (React/HTML video) on Lambda is the deterministic assembler for kinetic typography, karaoke/animated captions, lower‑thirds, branded templates, and b‑roll compositing. **Remotion Company License + per‑render `@remotion/licensing` webhook are wired from day one** (§18 cost line).

### 12.5 End‑to‑end pipeline (MS‑6 — "as easy as possible")
`script (Claude builds, GPT reviews) → voice (ElevenLabs/Cartesia) → avatar (HeyGen/Argil/self‑host MuseTalk) → captions (Scribe/Deepgram) → b‑roll (fal → Kling/Veo/Wan) → music (ElevenLabs Music v2) → assemble + typography (Remotion) → publish (§13)`. Each stage is a job; the whole pipeline is an orchestrated workflow (E5) the operator triggers with one brief.

### 12.6 Functional requirements & acceptance
- **MS‑FR‑1** All generation is **async‑by‑default** (submit + webhook, poll fallback); a multi‑minute render never blocks a chat turn; progress streams to desktop/mobile/Telegram.
- **MS‑FR‑2** **Live cost estimate before generation** for every job (a 4K+audio video minute can be **$35–45**, §15).
- **MS‑FR‑3** **Draft‑then‑upscale**: cheap previews → re‑render the chosen one on a frontier model.
- **MS‑FR‑4** Cloud↔local lane switch requires no interface change.
- **MS‑FR‑5** A real‑time "assistant face" option pairs OpenAI Realtime / Cartesia voice with a streaming avatar (D‑ID V4 / Anam) over **WebRTC** (audio round‑trip <300ms, mouth <1s).
- Acceptance: from one text brief, the studio produces a captioned, scored, avatar‑narrated short with a pre‑run cost estimate and a final provenance record (§13).

---

## 13. Auto‑Publishing, Trend Intelligence & Provenance/Consent

> Modules **D5, D6**. Requirements **DI‑1..DI‑3**. Governed by ADR §14. Default posture: **draft‑mode HITL publishing**; provenance + consent are mandatory, not optional.

### 13.1 PublishProvider abstraction (DI‑1)
One `PublishJob` interface over a hybrid of **direct APIs** (where ROI/volume justify) and an **aggregator** (to avoid owning eight platform audits at launch): **upload‑post** (cheap, account‑based) or **self‑hosted Postiz** (AGPL‑3.0, ships an MCP server Claude can drive — run as a network‑served backend to limit copyleft, get legal review). Per‑platform adapters track their own quotas, token refresh, and audit state.

### 13.2 Platform gates & limits (re‑verify §18)
| Platform | Gate | Practical limit |
|---|---|---|
| YouTube Shorts | `videos.insert`, no audit to start | 1600 units/upload → ~6/day until quota extension (apply day one) |
| TikTok | **Mandatory audit (2–6 wks); unaudited = SELF_ONLY** | ~15–25 posts/creator/24h; tokens expire 24h → launch in **Draft mode** |
| Instagram/Facebook/Threads | One Meta App Review + Business Verification covers all | IG 100/24h, Threads 250/24h |
| X | **Free tier killed Feb 2026; pay‑per‑use** | ~$0.20/post‑with‑URL → put links in replies/bio |
| LinkedIn | Partner Program (weeks–months) | demo required |
| Pinterest / Bluesky | Low gate | good Phase‑1 targets |

**Rollout by friction:** Phase 1 YouTube + Pinterest + Threads + Bluesky → Phase 2 IG + FB Reels → Phase 3 TikTok + LinkedIn (or aggregator from day one).

### 13.3 Trend & research intelligence (DI‑2, DI‑3) — module D6
TikTok closed its open trends API, so build on **legal/official signals first**: Metricool (official trending‑audio + best‑time‑to‑post), YouTube/IG insights, plus LLM‑generated **hooks/titles/thumbnail concepts**; scraper sources (Apify) are **isolated, optional, and risk‑flagged**. D6 emits a **content brief** that feeds the studio (D4) and a publish schedule (D5) — closing the "research a genre → generate super‑quality video → publish everywhere on a schedule" loop the operator asked for.

### 13.4 Consent, moderation & provenance (mandatory)
- **Maestro‑layer moderation** runs uniformly **before dispatch** (no real‑person likeness without consent, no copyrighted characters, no impersonation) — vendor guardrails vary too much to rely on.
- **Consent + identity verification** captured before any avatar/voice clone; stored with the asset.
- **Provenance:** persist and surface **C2PA / SynthID**; apply **AI‑generated labels** on publish; full audit log (model, version, cost, license per generation).

### 13.5 Acceptance criteria
- A finished video can be scheduled to YouTube + Threads + Pinterest from one action; TikTok/IG go to draft for in‑app approval.
- No avatar/voice‑clone job runs without a recorded consent artifact.
- Every published asset carries provenance metadata and an AI label; the publish ledger records platform, time, quota cost, and outcome.

---

## 14. Security Architecture & Secrets Management

> Cross‑cutting (critic flagged it scattered). One unified chapter. Governed by ADR §2, §6, §9, §15.

### 14.1 Threat model — the "lethal trifecta"
Maestro stacks four compounding surfaces: **shell‑capable agents** (RCE at user privilege) + **third‑party skills/MCP servers** (rug‑pulls; 41% of public MCP servers ship no auth; the Dec 2025 `lotusbail` Baileys trojan added an attacker as a linked device and persisted after uninstall) + **untrusted inbound comms** (WhatsApp/Telegram messages as injection) + **phone‑controlled remote execution** (compromised pairing = remote RCE). These must be defended as one system.

### 14.2 Single enforcement model
- **Per‑project sandbox** dirs + git‑worktree isolation; **deny‑by‑default** Bash + network egress allowlists.
- **PreToolUse hook gating** on every tool call; HITL confirmation on every **destructive / irreversible / outbound** action (file delete, push, send, publish, payment‑like ops).
- **Mandatory MCP gateway** between both the engine and the reviewer and *all* third‑party servers (no direct connections); per‑job ephemeral identities; the gateway is the single policy choke point.
- **Skill/extension host** runs out‑of‑process (VS Code model), capability‑scoped, with **signing + provenance + continuous re‑scan** for rug‑pulls (not just install‑time review).
- **Untrusted‑content review:** inbound comms/web content is screened (cheap model pass) before it can influence a side‑effecting tool call.
- **WhatsApp Lane A** isolated in its own process; **linked‑device monitoring**; loud opt‑in ban/risk warning.

### 14.3 Secrets (ADR §6)
- BYO provider keys + OAuth refresh tokens stored **agent‑invisibly** in the **OS keychain** (Keychain / DPAPI / libsecret) — never in plaintext, never in the model's context. Tools that need a credential receive a **scoped handle**, not the secret.
- OAuth = **Authorization Code + PKCE, loopback `127.0.0.1:<random‑port>`** default; deep‑link scheme secondary.
- **Refresh‑token rotation service** (e.g., TikTok 24h expiry) keeps long‑lived publishing/comms tokens valid for scheduled jobs.

### 14.4 Supply chain
Dependency pinning + lockfiles, vendoring + audit of skills/MCP servers, signed releases, and SBOM tracking. The phone control plane uses E2EE + scoped, short‑lived credentials + explicit approval gates (§11).

### 14.5 Acceptance criteria
- No agent can read a raw API key from any context or file; secret access is mediated and audited.
- A newly downloaded marketplace skill cannot open a network connection or touch the main process without passing the gateway + sandbox policy.
- Every outbound/destructive action in an unattended job either matches an allowlist or blocks on a HITL gate.

---

## 15. Cost Governance, Metering & Observability

> Module **F3**. Governed by ADR §16. Framed **solely as the operator's bill‑shock shield** — never customer billing (single‑user scope).

### 15.1 Unified budget ledger
One metering service accounts for every cost source: LLM tokens × **effort multipliers**, container/session‑hours, web‑search ($10/1K), image ($0.005–0.24), **video (a 4K+audio minute = $35–45)**, avatar minutes, Remotion render licensing, and per‑platform publish costs (X's $0.20/URL trap). Costs attach to Workspace → Project → Job (§3).

### 15.2 Controls (functional requirements)
- **CG‑1** **Pre‑run estimate** surfaced before any non‑trivial job/render.
- **CG‑2** **Live meters** (tokens / $ / render units) streamed to desktop + mobile.
- **CG‑3** **Hard per‑project caps** — exceed → job blocks (429‑style) and notifies, never silently overspends.
- **CG‑4** **Auto‑downgrade** to cheaper model tiers / effort when a budget threshold is hit.
- **CG‑5** **Batch API (−50%) + prompt caching (~90%)** enforced on all scheduled/background Claude runs.
- **CG‑6** **Loop guards:** `max_iterations`, `max_budget_per_session`, wall‑clock timeouts on every agent loop.

### 15.3 Observability
- **OpenTelemetry GenAI** conventions + **self‑hosted Langfuse**; distributed tracing across desktop → relay → mobile → cloud renders.
- Per‑job **reasoning/thinking‑token telemetry** feeds the effort auto‑tuner (§5).
- **Immutable, replayable run history + audit log** (doubles as the provenance/compliance record); transcripts archived per session.

### 15.4 Acceptance criteria
- A scheduled job that would exceed its project budget is stopped before spend, with a notification.
- The operator can open any past run and see a full trace + exact cost breakdown by model and tool.
- Background runs demonstrably use caching/batch (cache‑hit and batch‑discount visible in the ledger).

---

## 16. Reliability, Failure‑Mode Matrix, Quality & Eval Strategy

> Cross‑cutting. Governed by ADR §17. Two halves: keep it running, and prove it's correct.

### 16.1 Failure‑mode matrix (single owner)
| Dependency | Failure | Degradation path |
|---|---|---|
| Anthropic engine | Outage / quota (cf. this very session's weekly‑limit hit) / ToS change | Fall back to **OpenHands self‑host** or alternate provider via the LiteLLM router; durable resume |
| Media vendor | Outage / ban / deprecation (Sora 2) | **OSS self‑host lane** (Wan/LTX‑2/ComfyUI) behind the same interface |
| OS power event | Sleep / restart mid‑job | **Durable checkpoint/resume** in the scheduler (§7); reference‑counted wake‑lock (§17) |
| Network / NAT | CGNAT, firewall | **Relay‑first** transport (§11) |
| Render / publish | Job error, token expiry | **Async + webhook + polling fallback + retries**; token refresh (§14) |
| MCP/skill | Rug‑pull / crash | Gateway isolation + continuous re‑scan (§14) |

> **Lesson already banked:** the PRD authoring workflow lost 9 sections to a weekly account limit. That is exactly the class of failure the router fallback + durable resume + cost pre‑estimate are designed to absorb — and a concrete argument for **multi‑provider** routing from day one.

### 16.2 Quality, eval & testing (critic flagged missing)
- **Agent eval harness** with **golden‑task suites** per project template; regression‑gates model/skill/effort swaps (non‑deterministic outputs scored, not diffed).
- **Reviewer‑lift eval (AE‑2 gate):** measure whether the GPT reviewer catches real defects the builder misses; if it doesn't earn its cost/latency, the reviewer pillar is dropped honestly.
- **Panel‑of‑judges** for auto‑merge decisions (multiple independent verifications before an unattended merge/publish).
- **Effort eval** feeds the "effort paradox" guardrail (§5): confirm DEEP/MAX actually beats BALANCED on a task before defaulting up.

### 16.3 NFR targets (initial, to harden)
- Concurrent jobs: ≥10 active agents + ≥dozens of scheduled jobs without UI jank.
- Long jobs survive sleep/restart with zero data loss (checkpoint interval ≤ N steps).
- Render queue + publish quotas tracked; CRDT storage growth monitored/compacted.

---

## 17. System Integration, Platform Services & Desktop Shell UX

> Modules **F4, X1, X3**. Requirements **PF‑1..PF‑4**. Governed by ADR §15, §18.

### 17.1 Prevent‑sleep (PF‑2) — reference‑counted
- **`prevent-app-suspension`** while any headless job runs (lets the display sleep → saves battery); **`prevent-display-sleep`** only when the operator is actively watching a run.
- **Reference‑counted**: acquired per running job, released on completion/failure/cancel; the system sleeps the moment the last job ends.
- Built on Electron's `powerSaveBlocker` (a decisive reason for Electron over Tauri, which lacks an official sleep plugin — ADR §1). Paired with **durable checkpointing** since a forced sleep (lid close, low battery) can still interrupt (§16).

### 17.2 Platform services
- **Native OAuth loopback** (PKCE, §14); **OS keychain** secrets; **native notifications**; tray; **deep links**.
- **Signed auto‑update + macOS notarization + Windows OV signing** as a release gate (`electron-updater`). Recurring fixed costs: Apple Developer $99/yr + notarization; Windows OV cert ~$200–300/yr (§18).
- **Super‑Tester browser bridge (PF‑4):** the existing browser extension is exposed as an **agent tool surface** (via the MCP gateway) so agents can drive the browser for testing/automation.

### 17.3 Desktop Shell UX (X1)
The command center is the operator's cockpit:
- **Projects/sub‑projects** sidebar (typed templates, §6) with per‑project instructions + budgets visible.
- **Job monitor / timeline**: all running + scheduled jobs, live streaming transcripts, **parallel** without jank.
- **Plan & effort controls** inline (FAST/BALANCED/DEEP/MAX, plan‑mode toggle); **diff/review UI** for the build→review gate.
- **Media Studio** workspace (§12) and **Marketplace browser** (§8).
- **Chat/timeline** unifying desktop + comms threads.

### 17.4 Modularity (PF‑1)
Everything above the Foundation layer is a plugin over the **F1 runtime contract** (ADR §18): manifest‑driven, capability‑scoped, hot‑loadable — first‑party and third‑party modules use the same contract, so features are added on the fly without touching the core.

### 17.5 Acceptance criteria
- Starting a long job acquires a wake‑lock; finishing it releases it; with no jobs, the Mac sleeps normally.
- A fresh install completes OAuth for Anthropic + OpenAI via loopback with tokens landing in the keychain.
- A new feature module can be dropped in and appears in the shell without a core rebuild.

---

## 18. Vendor/ToS Register, Phasing & Build Roadmap, Risks & Open Decisions

> Governed by ADR §16.4, Appendices. **Phasing = build order, not product tiers** (single‑user scope).

### 18.1 Living Vendor/ToS Register
Every model ID, price, and ToS term is **point‑in‑time config**, re‑verified at build against a single register. Watch‑list (mid‑2026): Anthropic billing/credit churn; **Meta's Jan 2026 general‑purpose‑AI ban** (WhatsApp); **Sora 2 sunset Sept 24 2026**; **GPT Image 1 deprecation Oct 23 2026**; **HeyGen streaming SDK sunset Mar 31 2026**; **Remotion Company License**; **Midjourney/Suno/Udio = no API** (litigation); **Postiz AGPL‑3.0**; **Chinese‑ownership data‑residency** on Kling/Seedance/Wan/Seedream; **LTX‑2 free <$10M ARR**.

### 18.2 Build roadmap — parallel workstreams on one critical path
Critical path: **F1 Runtime → F2 Auth → E1 Agent Engine → D1 Projects → D2 Scheduler.** First integration milestone = **one end‑to‑end vertical** (a scheduled job in a typed project that loads one marketplace skill and reports to Telegram + mobile) to lock interfaces. Then 5 parallel workstreams:
| Workstream | Modules | Starts after |
|---|---|---|
| **Spine** | F1→F2→F3→E1→D1→D2 | — |
| **Capability** | E2 Tools → E3 Skills → E4 Marketplace (+ registry backend) | E1 |
| **Orchestration** | E5 (plan→build→review, judges) | E1/E3 |
| **Reach** | F5 Server → F6 P2P → X2 Mobile → D3 Comms | F5 |
| **Studio** | D4 → D6 Trends → D5 Publishing | E1 |
| **Shell** | X1 desktop (continuous), X3 browser bridge | F1 |

### 18.3 Top risks & mitigations
| Risk | Severity | Mitigation |
|---|---|---|
| Anthropic billing/quota/ToS churn (proven this session) | High | **Multi‑provider router**, BYO‑key, durable resume, pre‑estimates |
| WhatsApp ban waves / Meta AI ban | High | Telegram‑first; Lane A opt‑in on own number, isolated process |
| Supply‑chain (skills/MCP/Node) | Med‑High | Gateway + sandbox + signing + continuous re‑scan + dep pinning |
| Prompt‑injection lethal trifecta | Med‑High | Allowlists + HITL + untrusted‑content review + per‑job sandbox |
| Media cost blow‑ups ($35–45/video‑min) | Med | Budget caps + draft‑then‑upscale + cheap‑tier defaults |
| Vendor deprecation (Sora 2 etc.) | Med | Config‑driven routing; OSS fallback lane |
| Code‑signing/notarization blocking updates | Med | Cert + notarization pipeline budgeted from day one |

### 18.4 Open decisions for the operator (each: options → recommendation)
1. **Skills marketplace hosting** — *Recommendation:* a small **self‑hosted registry service the operator runs** (Git‑repo skills + a search index API the app queries), no payment layer. ← needs your confirm.
2. **Working name** — keep **Maestro** or choose another (no functional impact).
3. **WhatsApp Lane A on day one?** — *Recommendation:* ship Telegram first; enable WhatsApp Lane A behind an explicit opt‑in once the comms gateway is stable.
4. **Multi‑provider engine fallback in MVP?** — *Recommendation:* **yes** — wire the LiteLLM router + an OpenHands/self‑host fallback early, given this session's weekly‑limit failure.
5. **Real‑time avatar "assistant face"** — in‑scope now or v2? (adds WebRTC + streaming‑avatar complexity).
