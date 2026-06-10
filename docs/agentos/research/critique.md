# Completeness Critic

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
