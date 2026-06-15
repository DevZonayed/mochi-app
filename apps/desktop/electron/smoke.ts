/* End-to-end smoke test — boots the REAL Maestro core (same wiring as the app)
   and exercises every major capability against the live dispatch + engines, then
   prints a pass/fail report and exits. Run headless via: MAESTRO_SMOKE=1 electron .
   (main.ts isolates userData to a temp dir + skips the window when MAESTRO_SMOKE
   is set, so it never touches your real data.) */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { Store } from './store.js';
import type { LocalEngine } from './engine.js';
import type { BrowserController } from './browser.js';

type Dispatch = (method: string, params: Record<string, unknown>) => Promise<unknown>;
interface Ctx { dispatch: Dispatch; engine: LocalEngine; browser?: BrowserController; store: Store }

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function projectRoot(proj: { name?: string; path?: string }): string {
  if (proj.path && existsSync(proj.path)) return proj.path;
  const safe = (proj.name || 'default').replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'default';
  return path.join(homedir(), 'Maestro', safe);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
async function runChat(dispatch: Dispatch, projectId: string, text: string, timeoutMs: number): Promise<any> {
  const res: any = await dispatch('sendChat', { projectId, text });
  const jobId = res?.job?.id;
  if (!jobId) throw new Error('sendChat returned no job');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(2500);
    const j: any = await dispatch('getJob', { id: jobId });
    if (j.status === 'done' || j.status === 'failed' || j.status === 'cancelled') return j;
  }
  throw new Error(`run timed out after ${Math.round(timeoutMs / 1000)}s`);
}

export async function runSmoke(ctx: Ctx): Promise<number> {
  const { dispatch, engine, browser, store } = ctx;
  const results: { name: string; ok: boolean; detail: string; ms: number }[] = [];
  const T = async (name: string, fn: () => Promise<string>) => {
    const t0 = Date.now();
    process.stdout.write(`▶ ${name} … `);
    try { const detail = await fn(); results.push({ name, ok: true, detail, ms: Date.now() - t0 }); console.log(`✅ ${detail} (${Date.now() - t0}ms)`); }
    catch (e) { const detail = e instanceof Error ? e.message : String(e); results.push({ name, ok: false, detail, ms: Date.now() - t0 }); console.log(`❌ ${detail}`); }
  };

  console.log('\n══════════ MAESTRO SMOKE TEST ══════════\n');

  await T('engines available (claude / codex)', async () => {
    const s = engine.statuses();
    const avail = (Object.keys(s) as (keyof typeof s)[]).filter(k => s[k].available);
    if (!avail.length) throw new Error('no engine signed in — run `claude login` or `codex login`');
    return `available: ${avail.join(', ')}`;
  });

  await T('skills catalog loads', async () => {
    const skills = await dispatch('listSkills', {}) as unknown[];
    if (!Array.isArray(skills) || !skills.length) throw new Error('no skills loaded');
    return `${skills.length} skills`;
  });

  await T('model groups build', async () => {
    const groups = await dispatch('listModels', {}) as any[];
    if (!Array.isArray(groups) || !groups.length) throw new Error('no model groups');
    return `${groups.length} providers, ${groups.filter(g => g.runnable).length} runnable`;
  });

  await T('browser available (system Chrome)', async () => {
    const r = browser?.available();
    if (!r?.ok) throw new Error(r?.reason || 'browser controller missing');
    return 'Chrome found';
  });

  let codeProj: any;
  await T('create coding project', async () => { codeProj = await dispatch('createProject', { name: `Smoke Code ${Date.now().toString(36)}`, kind: 'coding' }); return codeProj.id; });

  await T('continuum memory read / write (.continuum/STATE.md)', async () => {
    await dispatch('setProjectMemory', { id: codeProj.id, state: '# Smoke\nThis project is a smoke-test marker.' });
    const m = await dispatch('getProjectMemory', { id: codeProj.id }) as any;
    if (!String(m.state).includes('smoke-test marker')) throw new Error('STATE.md did not round-trip');
    return 'STATE.md persists + reads back';
  });

  if (browser) await T('browser navigate + screenshot', async () => {
    const nav = await browser.navigate(codeProj.id, 'https://example.com');
    if (!/example/i.test(nav.title || '')) throw new Error(`unexpected title: ${nav.title}`);
    const shot = await browser.screenshot(codeProj.id, {});
    await browser.close(codeProj.id).catch(() => {});
    if (!shot.assetId) throw new Error('no screenshot asset');
    return `"${nav.title}" + screenshot saved`;
  });

  await T('image generation (skill fires + asset saved)', async () => {
    const j = await runChat(dispatch, codeProj.id, 'Generate a small image of a blue circle on a white background and save it.', 200_000);
    if (j.status !== 'done') throw new Error(`run ${j.status}: ${(j.error || '').slice(0, 140)}`);
    const inTranscript = (j.transcript || []).some((t: any) => t.kind === 'image');
    const assets = await dispatch('listAssets', { projectId: codeProj.id }).catch(() => []) as any[];
    const hasAsset = Array.isArray(assets) && assets.some(a => a.kind === 'image');
    if (!inTranscript && !hasAsset) throw new Error('no image produced');
    return inTranscript ? 'image in transcript' : 'image asset saved';
  });

  let designProj: any;
  await T('design generation (self-contained artifact written)', async () => {
    designProj = await dispatch('createProject', { name: `Smoke Design ${Date.now().toString(36)}`, kind: 'design' });
    const j = await runChat(dispatch, designProj.id, 'Create a minimal, clean one-screen landing page for a coffee shop called "Brew". No external images needed.', 260_000);
    if (j.status !== 'done') throw new Error(`run ${j.status}: ${(j.error || '').slice(0, 140)}`);
    const artifact = path.join(projectRoot(designProj), 'design', 'index.html');
    if (!existsSync(artifact)) throw new Error('design/index.html not written');
    const bytes = readFileSync(artifact, 'utf8').length;
    if (bytes < 200) throw new Error(`artifact too small (${bytes}b)`);
    return `design/index.html ${bytes} bytes`;
  });

  await T('continuum auto-checkpoint after a real run', async () => {
    const m = await dispatch('getProjectMemory', { id: designProj?.id }) as any;
    if (!Array.isArray(m?.checkpoints) || !m.checkpoints.length) throw new Error('no checkpoint chain written');
    return `${m.checkpoints.length} checkpoint(s)`;
  });

  await T('snapshot (commit shortcut → referable hash)', async () => {
    const r = await dispatch('snapshotProject', { id: designProj?.id, message: 'smoke snapshot' }) as any;
    if (!r?.ok || !r.hash) throw new Error(r?.reason || 'snapshot failed');
    return `committed ${r.hash}`;
  });

  await T('design comments (add → list → resolve → delete)', async () => {
    const added = await dispatch('addDesignComment', { id: designProj?.id, selector: 'header h1', label: 'h1 · "Brew"', note: 'Make the headline larger.' }) as any;
    if (!added?.comment?.id) throw new Error('addDesignComment returned no comment');
    let list = (await dispatch('listDesignComments', { id: designProj?.id }) as any).comments;
    if (!Array.isArray(list) || list.length !== 1 || list[0].status !== 'open') throw new Error('comment did not persist as open');
    await dispatch('setDesignCommentStatus', { id: designProj?.id, commentId: added.comment.id, status: 'resolved' });
    list = (await dispatch('listDesignComments', { id: designProj?.id }) as any).comments;
    if (list[0].status !== 'resolved') throw new Error('resolve did not stick');
    await dispatch('deleteDesignComment', { id: designProj?.id, commentId: added.comment.id });
    list = (await dispatch('listDesignComments', { id: designProj?.id }) as any).comments;
    if (list.length !== 0) throw new Error('delete did not remove the comment');
    return 'add/list/resolve/delete OK';
  });

  const pass = results.filter(r => r.ok).length;
  console.log('\n══════════ RESULTS ══════════');
  for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? `  ·  ${r.detail}` : `  —  ${r.detail}`}`);
  console.log(`\n${pass}/${results.length} passed.\n`);
  return pass === results.length ? 0 : 1;
}
