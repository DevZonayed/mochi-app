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
