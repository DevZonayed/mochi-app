#!/usr/bin/env node
/* Precompute semantic vectors for the skill index (build-time, plain node).
 *
 * Embeds each skill's name + description + tags + a little body with a small,
 * local sentence-transformer (all-MiniLM-L6-v2, 384-dim, no API key, no cost),
 * then writes int8-quantized vectors aligned to the index order. Shipped with
 * the registry so search is "embed the query → cosine top-K" — only the top few
 * results ever enter the agent's context, so it scales to thousands of skills.
 *
 * Usage: node scripts/embed-skills.mjs
 */
import { pipeline, env } from '@xenova/transformers';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDX = join(__dirname, '..', 'registry', 'skills-index.json');
const OUT = join(__dirname, '..', 'registry', 'skills-vectors.json');
const DIM = 384;
const MODEL = 'Xenova/all-MiniLM-L6-v2';

env.allowLocalModels = false; // always fetch the published model

const manifest = JSON.parse(readFileSync(IDX, 'utf8'));
const skills = manifest.skills;
console.log(`Embedding ${skills.length} skills with ${MODEL} …`);

const extractor = await pipeline('feature-extraction', MODEL, { quantized: true });
const buf = new Int8Array(skills.length * DIM);
const ids = new Array(skills.length);
const t0 = Date.now();
for (let i = 0; i < skills.length; i++) {
  const s = skills[i];
  const text = `${s.name}. ${s.description} ${(s.tags || []).join(' ')} ${(s.excerpt || '').slice(0, 280)}`.slice(0, 800);
  const o = await extractor(text, { pooling: 'mean', normalize: true });
  const v = o.data; // Float32Array(384), L2-normalized
  for (let d = 0; d < DIM; d++) buf[i * DIM + d] = Math.max(-127, Math.min(127, Math.round(v[d] * 127)));
  ids[i] = s.id;
  if (i % 250 === 0) console.log(`  ${i}/${skills.length}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}

const out = { model: MODEL, dim: DIM, quant: 'int8', scale: 127, count: skills.length, ids, data: Buffer.from(buf.buffer).toString('base64') };
writeFileSync(OUT, JSON.stringify(out));
console.log(`\nWrote ${OUT} · ${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB · ${((Date.now() - t0) / 1000).toFixed(0)}s total`);
