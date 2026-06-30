/* Media generation — real images, video, voice, and music on the operator's
   own fal.ai key. Uses fal's queue REST directly (no SDK):
     POST  queue.fal.run/<model>            → { request_id, status_url, response_url, cancel_url }
     GET   <status_url>                      → { status: IN_QUEUE | IN_PROGRESS | COMPLETED }
     GET   <response_url>                    → model output (images[].url / video.url / audio.url …)
     PUT   <cancel_url>                      → 202 CANCELLATION_REQUESTED
   The three queue URLs are persisted verbatim on the Asset so a single poll
   ticker can resume in-flight generations after a relaunch. Finished media is
   streamed down to ~/Maestro/<project>/assets/ for the record + publishing. */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Store, Asset, AssetKind, AssetStage } from './store.js';

const POLL_MS = 4000;
const TIMEOUT_MS = 15 * 60 * 1000;

export interface MediaModel {
  id: string;            // fal model id
  key: string;           // our short key
  label: string;
  kind: AssetKind;
  stage: AssetStage;
  /** ≈ USD estimate; video scales by seconds. Labeled "≈ est." in the UI. */
  rate: number;
  perSecond?: boolean;
  blurb: string;
  buildInput: (a: GenArgs) => Record<string, unknown>;
  extractUrl: (out: Record<string, unknown>) => { url?: string; width?: number; height?: number } | undefined;
}

export interface GenArgs {
  projectId: string | null;
  modelKey: string;
  prompt: string;
  durationS?: number;
  voice?: string;
  imageUrl?: string;
  /** A local source image for edit/i2v models. Read + base64'd into a data URI
      when no imageUrl is given (e.g. a Codex-generated image has no fal CDN url). */
  imagePath?: string;
  aspect?: string;
}

/* Defensive output extraction — fal models return slightly different shapes. */
function firstUrl(out: Record<string, unknown>): { url?: string; width?: number; height?: number } | undefined {
  const o = out as Record<string, any>;
  if (Array.isArray(o.images) && o.images[0]?.url) return { url: o.images[0].url, width: o.images[0].width, height: o.images[0].height };
  if (o.image?.url) return { url: o.image.url, width: o.image.width, height: o.image.height };
  if (o.video?.url) return { url: o.video.url };
  if (o.audio?.url) return { url: o.audio.url };
  if (o.audio_file?.url) return { url: o.audio_file.url };
  if (typeof o.url === 'string') return { url: o.url };
  return undefined;
}

const MODEL_LIST: MediaModel[] = [
  {
    key: 'flux-schnell', id: 'fal-ai/flux/schnell', label: 'FLUX schnell', kind: 'image', stage: 'broll', rate: 0.003,
    blurb: 'Fast draft image', buildInput: (a) => ({ prompt: a.prompt, image_size: a.aspect === '9:16' ? 'portrait_16_9' : 'landscape_16_9', num_images: 1 }), extractUrl: firstUrl,
  },
  {
    key: 'flux-dev', id: 'fal-ai/flux/dev', label: 'FLUX dev', kind: 'image', stage: 'broll', rate: 0.025,
    blurb: 'High-quality image', buildInput: (a) => ({ prompt: a.prompt, image_size: a.aspect === '9:16' ? 'portrait_16_9' : 'landscape_16_9', num_images: 1 }), extractUrl: firstUrl,
  },
  {
    key: 'flux-pro', id: 'fal-ai/flux-pro/v1.1', label: 'FLUX 1.1 Pro', kind: 'image', stage: 'broll', rate: 0.05,
    blurb: 'Hero image', buildInput: (a) => ({ prompt: a.prompt, image_size: a.aspect === '9:16' ? 'portrait_16_9' : 'landscape_16_9', num_images: 1 }), extractUrl: firstUrl,
  },
  {
    // Instruction edit — keeps the source image and applies the change ("add a
    // balloon in the sky"). image_url accepts a CDN url or a data URI.
    key: 'flux-kontext', id: 'fal-ai/flux-pro/kontext', label: 'FLUX.1 Kontext · edit', kind: 'image', stage: 'broll', rate: 0.04,
    blurb: 'Edit an image with an instruction', buildInput: (a) => ({ prompt: a.prompt, image_url: a.imageUrl, num_images: 1 }), extractUrl: firstUrl,
  },
  {
    key: 'kling-t2v', id: 'fal-ai/kling-video/v1.6/standard/text-to-video', label: 'Kling 1.6 · text→video', kind: 'video', stage: 'broll', rate: 0.045, perSecond: true,
    blurb: 'B-roll from a prompt', buildInput: (a) => ({ prompt: a.prompt, duration: String(a.durationS ?? 5), aspect_ratio: a.aspect ?? '16:9' }), extractUrl: firstUrl,
  },
  {
    key: 'kling-i2v', id: 'fal-ai/kling-video/v1.6/standard/image-to-video', label: 'Kling 1.6 · image→video', kind: 'video', stage: 'avatar', rate: 0.045, perSecond: true,
    blurb: 'Animate a still', buildInput: (a) => ({ prompt: a.prompt, image_url: a.imageUrl, duration: String(a.durationS ?? 5), aspect_ratio: a.aspect ?? '16:9' }), extractUrl: firstUrl,
  },
  {
    key: 'kokoro', id: 'fal-ai/kokoro/american-english', label: 'Kokoro TTS', kind: 'voiceover', stage: 'voice', rate: 0.02,
    blurb: 'Voiceover from text', buildInput: (a) => ({ prompt: a.prompt, voice: a.voice ?? 'af_heart' }), extractUrl: firstUrl,
  },
  {
    key: 'stable-audio', id: 'fal-ai/stable-audio', label: 'Stable Audio', kind: 'audio', stage: 'music', rate: 0.05,
    blurb: 'Background music', buildInput: (a) => ({ prompt: a.prompt, seconds_total: a.durationS ?? 30 }), extractUrl: firstUrl,
  },
];
const MODELS: Record<string, MediaModel> = Object.fromEntries(MODEL_LIST.map(m => [m.key, m]));

export interface MediaRate { key: string; label: string; kind: AssetKind; stage: AssetStage; rate: number; perSecond?: boolean; blurb: string }
export function mediaRates(): MediaRate[] {
  return MODEL_LIST.map(({ key, label, kind, stage, rate, perSecond, blurb }) => ({ key, label, kind, stage, rate, perSecond, blurb }));
}

function r3(n: number): number { return Math.round(n * 1000) / 1000; }
function estimate(model: MediaModel, args: { durationS?: number }): number {
  return r3(model.perSecond ? model.rate * (args.durationS ?? 5) : model.rate);
}

function assetsDirFor(projectName: string | undefined): string {
  const safe = (projectName || 'default').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'default';
  const dir = path.join(homedir(), 'Maestro', safe, 'assets');
  mkdirSync(dir, { recursive: true });
  return dir;
}
function extFor(kind: AssetKind, url: string): string {
  const m = url.split('?')[0].match(/\.([a-zA-Z0-9]{2,4})$/);
  if (m) return m[1].toLowerCase();
  return kind === 'image' ? 'png' : kind === 'video' ? 'mp4' : 'mp3';
}
/** Read a local image into a fal-acceptable data URI (used for edit/i2v models
    when there's no CDN url — e.g. a Codex-generated source image). */
function fileToDataUri(filePath: string): string {
  const buf = readFileSync(filePath);
  const MAX_BYTES = 12 * 1024 * 1024; // fal rejects very large inline payloads — fail clearly first
  if (buf.byteLength > MAX_BYTES) throw Object.assign(new Error('source image is too large to edit (max 12 MB) — try a smaller image'), { statusCode: 413 });
  const ext = (filePath.split('?')[0].match(/\.([a-zA-Z0-9]{2,4})$/)?.[1] ?? 'png').toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export class MediaEngine {
  private ticking = false;

  constructor(private store: Store, private emit: (name: string, data: unknown) => void, private getKey: () => string | undefined) {}

  rates(): MediaRate[] { return mediaRates(); }
  estimateFor(modelKey: string, durationS?: number): number {
    const m = MODELS[modelKey];
    return m ? estimate(m, { durationS }) : 0;
  }

  /** Submit a generation to fal and start (or keep) the poll ticker. */
  async generate(args: GenArgs): Promise<Asset> {
    const key = this.getKey();
    if (!key) throw Object.assign(new Error('Connect your fal.ai API key in Settings → Accounts to generate media.'), { statusCode: 503 });
    const model = MODELS[args.modelKey];
    if (!model) throw Object.assign(new Error('unknown media model'), { statusCode: 400 });
    if (!args.prompt || !args.prompt.trim()) throw Object.assign(new Error('a prompt is required'), { statusCode: 400 });
    // Resolve a local source path into a data URI when no CDN url was supplied
    // (Codex images have a localPath but no fal url). Edit / image→video models
    // then have a usable image_url either way. Lets fileToDataUri's clear "too
    // large" error surface rather than collapsing into a generic "need a source".
    if (!args.imageUrl && args.imagePath && existsSync(args.imagePath)) {
      args = { ...args, imageUrl: fileToDataUri(args.imagePath) };
    }
    if (model.key === 'kling-i2v' && !args.imageUrl) throw Object.assign(new Error('image→video needs a source image'), { statusCode: 400 });
    if (model.key === 'flux-kontext' && !args.imageUrl) throw Object.assign(new Error('editing needs a source image'), { statusCode: 400 });

    const asset = this.store.createAsset({
      source: 'generated', kind: model.kind, stage: model.stage, prompt: args.prompt.slice(0, 2000), model: model.key,
      status: 'queued', cost: estimate(model, args), durationS: args.durationS,
    });
    this.emit('asset', asset);

    try {
      const res = await fetch(`https://queue.fal.run/${model.id}`, {
        method: 'POST',
        headers: { authorization: `Key ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(model.buildInput(args)),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`fal returned ${res.status}: ${body.slice(0, 200) || res.statusText}`);
      }
      const j = await res.json() as { request_id?: string; status_url?: string; response_url?: string; cancel_url?: string };
      const updated = this.store.updateAsset(asset.id, {
        status: 'generating', falRequestId: j.request_id, statusUrl: j.status_url, responseUrl: j.response_url, cancelUrl: j.cancel_url,
      });
      this.emit('asset', updated);
      this.startTicker();
      return updated;
    } catch (e) {
      const failed = this.store.updateAsset(asset.id, { status: 'failed', error: e instanceof Error ? e.message : String(e) });
      this.emit('asset', failed);
      this.store.pushEvent({ kind: 'asset', title: `Media failed: ${model.label}`, subtitle: failed.error ?? undefined, projectId: asset.projectId });
      return failed;
    }
  }

  /** Generate and BLOCK until the asset reaches a terminal state. The coding
      agent's generate_image tool needs the finished local file, not a queued
      handle — so we submit, then watch the store (the poll ticker drives the
      actual fal polling + download) until done/failed/cancelled. */
  async generateAndWait(args: GenArgs, timeoutMs = 3 * 60 * 1000): Promise<Asset> {
    const first = await this.generate(args);
    if (first.status === 'failed') throw Object.assign(new Error(first.error || 'image generation failed'), { statusCode: 502 });
    const start = Date.now();
    for (;;) {
      await new Promise(r => setTimeout(r, 700));
      const a = this.store.getAsset(first.id);
      if (!a) throw new Error('asset disappeared mid-generation');
      if (a.status === 'done') return a;
      if (a.status === 'failed') throw Object.assign(new Error(a.error || 'image generation failed'), { statusCode: 502 });
      if (a.status === 'cancelled') throw Object.assign(new Error('image generation was cancelled'), { statusCode: 499 });
      if (Date.now() - start > timeoutMs) {
        // Stop the in-flight fal job + poll ticker so it can't complete later and
        // surface a "phantom" image the chat already reported as failed.
        try { await this.cancel(first.id); } catch { /* best effort */ }
        throw Object.assign(new Error('image generation timed out'), { statusCode: 504 });
      }
    }
  }

  /** Cancel an in-flight generation. */
  async cancel(assetId: string): Promise<Asset> {
    const asset = this.store.getAsset(assetId);
    if (!asset) throw Object.assign(new Error('asset not found'), { statusCode: 404 });
    const key = this.getKey();
    if (asset.cancelUrl && key) {
      try { await fetch(asset.cancelUrl, { method: 'PUT', headers: { authorization: `Key ${key}` } }); } catch { /* best effort */ }
    }
    const cancelled = this.store.updateAsset(assetId, { status: 'cancelled' });
    this.emit('asset', cancelled);
    return cancelled;
  }

  /** Resume polling any generations left in-flight by a previous run. */
  resumeOnBoot(): void {
    const inflight = this.store.listAssets().filter(a => (a.status === 'generating' || a.status === 'queued') && a.statusUrl);
    if (inflight.length) this.startTicker();
  }

  private startTicker(): void {
    if (this.ticking) return;
    this.ticking = true;
    void this.tick();
  }
  private async tick(): Promise<void> {
    const inflight = this.store.listAssets().filter(a => (a.status === 'generating' || a.status === 'queued') && a.statusUrl);
    if (inflight.length === 0) { this.ticking = false; return; }
    await Promise.all(inflight.map(a => this.pollOne(a).catch(() => {})));
    setTimeout(() => { void this.tick(); }, POLL_MS);
  }

  private async pollOne(asset: Asset): Promise<void> {
    const key = this.getKey();
    if (!key || !asset.statusUrl) return;
    if (Date.now() - asset.createdAt > TIMEOUT_MS) {
      const failed = this.store.updateAsset(asset.id, { status: 'failed', error: 'Generation timed out (15 min).' });
      this.emit('asset', failed);
      return;
    }
    const sres = await fetch(asset.statusUrl, { headers: { authorization: `Key ${key}` } });
    if (!sres.ok) return; // transient — try again next tick
    const status = (await sres.json() as { status?: string }).status;
    if (status !== 'COMPLETED') return;

    const model = MODELS[asset.model ?? ''];
    const rres = await fetch(asset.responseUrl ?? asset.statusUrl.replace(/\/status.*$/, ''), { headers: { authorization: `Key ${key}` } });
    if (!rres.ok) {
      const failed = this.store.updateAsset(asset.id, { status: 'failed', error: `fal result ${rres.status}` });
      this.emit('asset', failed);
      return;
    }
    const out = await rres.json() as Record<string, unknown>;
    const picked = (model?.extractUrl ?? firstUrl)(out);
    if (!picked?.url) {
      const failed = this.store.updateAsset(asset.id, { status: 'failed', error: 'fal returned no media URL.' });
      this.emit('asset', failed);
      return;
    }

    // Stream the finished media to ~/Maestro/<project>/assets/ for the record.
    let localPath: string | undefined; let bytes: number | undefined; let sha256: string | undefined;
    try {
      const project = asset.projectId ? this.store.getProject(asset.projectId) : undefined;
      const dir = assetsDirFor(project?.name);
      const file = path.join(dir, `${asset.id}.${extFor(asset.kind, picked.url)}`);
      const buf = Buffer.from(await (await fetch(picked.url)).arrayBuffer());
      writeFileSync(file, buf);
      localPath = file; bytes = buf.byteLength; sha256 = createHash('sha256').update(buf).digest('hex');
    } catch { /* keep the CDN url even if the local copy fails */ }

    const done = this.store.updateAsset(asset.id, {
      status: 'done', url: picked.url, localPath, bytes, sha256, width: picked.width, height: picked.height, error: null,
    });
    this.emit('asset', done);
    this.store.pushEvent({ kind: 'asset', title: `Media ready: ${model?.label ?? asset.kind}`, projectId: asset.projectId });
  }
}

/** Map an agent media-tool kind to a fal model key. A video request with a
    source still animates it (image→video) instead of generating from text.
    Pure + exported so the mapping is unit-tested against the real MODELS table. */
export function mediaModelForKind(kind: 'speech' | 'music' | 'video', hasSourceImage = false): string {
  if (kind === 'speech') return 'kokoro';
  if (kind === 'music') return 'stable-audio';
  return hasSourceImage ? 'kling-i2v' : 'kling-t2v';
}

export { MODELS, MODEL_LIST, assetsDirFor, extFor };
