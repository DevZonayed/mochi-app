/* Generates `native-skills-data.json` — the bundled, always-on skill catalog.
 *
 * Source: https://github.com/openai/skills (the `.system` + `.curated` sets).
 * We embed each skill's TEXT files (SKILL.md + references/scripts/agents) inline
 * as a JSON module so the catalog survives esbuild/asar/sidecar bundling with no
 * loose-file packaging (mirrors how skills-index.json ships). Binary assets
 * (png/jpg/gif/…) are skipped — they're skill icons, not agent instructions.
 *
 * Regenerate:
 *   git clone --depth 1 https://github.com/openai/skills /tmp/openai-skills
 *   node apps/desktop/electron/scripts/gen-native-skills.mjs /tmp/openai-skills
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'native-skills-data.json');

const SRC = process.argv[2] || '/tmp/openai-skills';
const SETS = [
  { dir: join(SRC, 'skills', '.system'), category: 'system' },
  { dir: join(SRC, 'skills', '.curated'), category: 'curated' },
];

// Text file extensions we embed (everything an agent might read/run). Binary
// assets are skipped.
const TEXT_EXT = new Set([
  'md', 'txt', 'py', 'yaml', 'yml', 'json', 'js', 'ts', 'tsx', 'jsx', 'mjs',
  'cjs', 'sh', 'bash', 'zsh', 'ps1', 'swift', 'ipynb', 'toml', 'ini', 'cfg',
  'env', 'html', 'css', 'sql', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'cpp', 'h',
]);
const SKIP_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'mp4', 'mov', 'pdf', 'zip', 'woff', 'woff2', 'ttf', 'otf']);

function walk(root) {
  const out = [];
  const rec = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) rec(p);
      else if (e.isFile()) out.push(p);
    }
  };
  rec(root);
  return out;
}

function ext(p) { const m = /\.([^.\/]+)$/.exec(p); return m ? m[1].toLowerCase() : ''; }

/** Pull name + description out of SKILL.md YAML frontmatter (best-effort, no dep). */
function parseFrontmatter(md) {
  const m = /^---\s*\n([\s\S]*?)\n---/.exec(md);
  const meta = { name: '', description: '' };
  if (!m) return meta;
  const body = m[1];
  const grab = (key) => {
    const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
    const g = re.exec(body);
    if (!g) return '';
    let v = g[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    return v.trim();
  };
  meta.name = grab('name');
  meta.description = grab('description');
  return meta;
}

const skills = [];
const seen = new Set(); // slugs must be unique (openai-docs appears in both sets — system wins)
for (const { dir, category } of SETS) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { console.warn(`skip missing set: ${dir}`); continue; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillRoot = join(dir, e.name);
    const slug = e.name;
    if (seen.has(slug)) { console.warn(`skip duplicate slug: ${slug} (${category})`); continue; }
    seen.add(slug);
    let skillMd = '';
    try { skillMd = readFileSync(join(skillRoot, 'SKILL.md'), 'utf8'); }
    catch { console.warn(`skip (no SKILL.md): ${slug}`); continue; }
    const meta = parseFrontmatter(skillMd);
    const files = {};
    let bytes = 0;
    for (const abs of walk(skillRoot)) {
      const rel = relative(skillRoot, abs).split('\\').join('/');
      const x = ext(abs);
      if (SKIP_EXT.has(x)) continue;
      if (x && !TEXT_EXT.has(x) && rel !== 'LICENSE.txt' && rel !== 'LICENSE') continue;
      try {
        if (statSync(abs).size > 512 * 1024) continue; // skip absurdly large text
        const content = readFileSync(abs, 'utf8');
        files[rel] = content;
        bytes += content.length;
      } catch { /* unreadable */ }
    }
    if (!files['SKILL.md']) files['SKILL.md'] = skillMd;
    skills.push({
      slug,
      id: `openai/skills/${slug}`,
      name: meta.name || slug,
      description: meta.description || '',
      category,
      bytes,
      files,
    });
  }
}

skills.sort((a, b) => (a.category === b.category ? a.slug.localeCompare(b.slug) : a.category === 'system' ? -1 : 1));

const data = {
  source: 'https://github.com/openai/skills',
  generatedAt: new Date().toISOString(),
  count: skills.length,
  skills,
};
writeFileSync(OUT, JSON.stringify(data), 'utf8');
console.log(`wrote ${OUT}: ${skills.length} skills, ${(JSON.stringify(data).length / 1024 / 1024).toFixed(2)} MB`);
for (const s of skills) console.log(`  [${s.category}] ${s.slug} — ${Object.keys(s.files).length} files`);
