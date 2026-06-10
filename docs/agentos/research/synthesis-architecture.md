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
