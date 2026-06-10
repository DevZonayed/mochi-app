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
