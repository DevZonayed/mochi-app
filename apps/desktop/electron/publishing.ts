/* Publishing — a real LOCAL pipeline. Maestro doesn't post to platforms on your
   behalf (no fake "connected to YouTube"); instead it exports approved media +
   captions to ~/Maestro/Exports/<platform>/, copies the caption to your
   clipboard, reveals the folder in Finder, and writes an append-only ledger so
   there's an auditable record of what went out. Importing pulls local files in
   as assets. Scheduled drafts are fired by the cron runner. */

import { clipboard, nativeImage, shell } from 'electron';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Store, Asset, AssetKind, PublishDraft } from './store.js';

const EXPORTS_ROOT = path.join(homedir(), 'Maestro', 'Exports');

function kindFromExt(file: string): AssetKind {
  const e = (file.split('.').pop() ?? '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic'].includes(e)) return 'image';
  if (['mp4', 'mov', 'webm', 'm4v'].includes(e)) return 'video';
  if (['mp3', 'wav', 'm4a', 'aac', 'flac'].includes(e)) return 'audio';
  return 'other';
}
function safeName(s: string): string { return s.replace(/[^a-zA-Z0-9 _.-]/g, '').trim() || 'asset'; }

export class PublishingEngine {
  constructor(private store: Store, private emit: (name: string, data: unknown) => void) {}

  /** Pull a local file in as an imported asset (with a thumbnail for images). */
  importAsset(filePath: string, projectId: string | null): Asset {
    if (!filePath || !existsSync(filePath)) throw Object.assign(new Error('file not found'), { statusCode: 404 });
    const buf = readFileSync(filePath);
    const kind = kindFromExt(filePath);
    let thumbDataUrl: string | undefined; let width: number | undefined; let height: number | undefined;
    if (kind === 'image') {
      try {
        const img = nativeImage.createFromPath(filePath);
        const size = img.getSize(); width = size.width; height = size.height;
        const thumb = img.resize({ width: 256 });
        thumbDataUrl = thumb.toDataURL();
      } catch { /* non-fatal */ }
    }
    const asset = this.store.createAsset({
      source: 'import', kind, status: 'done', projectId,
      name: path.basename(filePath), localPath: filePath, bytes: buf.byteLength,
      sha256: createHash('sha256').update(buf).digest('hex'), thumbDataUrl, width, height, cost: 0,
    });
    this.emit('asset', asset);
    this.store.pushEvent({ kind: 'asset', title: `Imported ${asset.name}`, projectId });
    return asset;
  }

  /** Create a draft from an approved/done asset. */
  createDraft(args: { assetId: string; caption?: string; platforms?: string[] }): PublishDraft {
    const asset = this.store.getAsset(args.assetId);
    if (!asset) throw Object.assign(new Error('asset not found'), { statusCode: 404 });
    const provenance = asset.source === 'generated' ? `${asset.model ?? 'generated'} · ${asset.sha256 ? asset.sha256.slice(0, 12) : 'no-hash'}` : `import · ${asset.sha256 ? asset.sha256.slice(0, 12) : 'no-hash'}`;
    const draft = this.store.createPublishDraft({ assetId: args.assetId, caption: args.caption ?? asset.prompt ?? '', platforms: args.platforms ?? [], provenance });
    this.emit('publishDraft', draft);
    return draft;
  }

  /** Export a draft's media + caption to ~/Maestro/Exports/<platform>/. */
  exportDraft(draftId: string): PublishDraft {
    const draft = this.store.getPublishDraft(draftId);
    if (!draft) throw Object.assign(new Error('draft not found'), { statusCode: 404 });
    if (draft.status === 'exported' || draft.status === 'published-manual') return draft; // in-flight/done guard
    const asset = this.store.getAsset(draft.assetId);
    if (!asset) throw Object.assign(new Error('asset not found'), { statusCode: 404 });

    const platforms = draft.platforms.length ? draft.platforms : ['export'];
    const exportedPaths: string[] = [];
    const base = safeName(asset.name ?? asset.prompt?.slice(0, 40) ?? asset.id);

    for (const platform of platforms) {
      const dir = path.join(EXPORTS_ROOT, safeName(platform));
      mkdirSync(dir, { recursive: true });
      const ext = (asset.localPath?.split('.').pop() ?? (asset.kind === 'video' ? 'mp4' : asset.kind === 'image' ? 'png' : 'bin'));
      const dest = path.join(dir, `${base}-${draft.id.slice(0, 6)}.${ext}`);
      try {
        if (asset.localPath && existsSync(asset.localPath)) copyFileSync(asset.localPath, dest);
        else if (asset.url) { /* download synchronously is avoided; note the URL in a sidecar */ writeFileSync(dest.replace(/\.[^.]+$/, '.url.txt'), asset.url); }
        // caption sidecar
        if (draft.caption) writeFileSync(path.join(dir, `${base}-${draft.id.slice(0, 6)}.caption.txt`), draft.caption);
        exportedPaths.push(dest);
      } catch { /* skip a platform that fails */ }
    }

    if (draft.caption) { try { clipboard.writeText(draft.caption); } catch { /* clipboard unavailable */ } }
    if (exportedPaths[0]) { try { shell.showItemInFolder(exportedPaths[0]); } catch { /* no shell */ } }

    const hash = createHash('sha256').update(exportedPaths.join('|') + draft.caption).digest('hex').slice(0, 16);
    this.store.appendPublishLedger({ draftId, platforms: draft.platforms, action: 'exported', ok: exportedPaths.length > 0, hash, paths: exportedPaths });
    const updated = this.store.updatePublishDraft(draftId, { status: 'exported', exportedPaths });
    this.emit('publishDraft', updated);
    this.store.pushEvent({ kind: 'publish', title: `Exported to ${platforms.join(', ')}`, subtitle: draft.caption ? 'caption copied to clipboard' : undefined });
    return updated;
  }

  /** Record that the operator manually posted a draft. */
  markPublished(draftId: string): PublishDraft {
    const draft = this.store.getPublishDraft(draftId);
    if (!draft) throw Object.assign(new Error('draft not found'), { statusCode: 404 });
    const hash = createHash('sha256').update(draftId + Date.now()).digest('hex').slice(0, 16);
    this.store.appendPublishLedger({ draftId, platforms: draft.platforms, action: 'published-manual', ok: true, hash, paths: draft.exportedPaths });
    const updated = this.store.updatePublishDraft(draftId, { status: 'published-manual' });
    this.emit('publishDraft', updated);
    this.store.pushEvent({ kind: 'publish', title: `Marked published: ${draft.platforms.join(', ') || 'manual'}` });
    return updated;
  }

  /** Cron hook: export any scheduled drafts whose time has come. */
  fireDue(nowMs: number): void {
    for (const d of this.store.listPublishDrafts()) {
      if (d.status === 'scheduled' && d.scheduledAt && d.scheduledAt <= nowMs) {
        try { this.exportDraft(d.id); } catch { /* skip; will retry next tick */ }
      }
    }
  }
}

export { EXPORTS_ROOT };
