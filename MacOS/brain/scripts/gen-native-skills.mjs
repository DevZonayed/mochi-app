/* Generates `native-skills-data.json` — the bundled, always-on skill catalog.
 *
 * Sources:
 *   - https://github.com/openai/skills   (the `.system` + `.curated` sets)
 *   - https://github.com/anthropics/skills (the DOCUMENT skills: docx/pdf/pptx/
 *     xlsx/doc-coauthoring — Anthropic's canonical office-file skills; its `pdf`
 *     supersedes openai's curated one)
 * We embed each skill's TEXT files (SKILL.md + references/scripts/agents) inline
 * as a JSON module so the catalog survives esbuild/asar/sidecar bundling with no
 * loose-file packaging (mirrors how skills-index.json ships). Binary assets
 * (png/jpg/gif/…) are skipped — they're skill icons, not agent instructions —
 * and so are the huge OOXML .xsd schema trees (validation-only, ~1MB per skill).
 *
 * Regenerate:
 *   git clone --depth 1 https://github.com/openai/skills /tmp/openai-skills
 *   git clone --depth 1 https://github.com/anthropics/skills /tmp/anthropic-skills
 *   node apps/desktop/electron/scripts/gen-native-skills.mjs /tmp/openai-skills /tmp/anthropic-skills
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'native-skills-data.json');

const SRC = process.argv[2] || '/tmp/openai-skills';
const ANTHROPIC_SRC = process.argv[3] || '/tmp/anthropic-skills';

/* Operator-curated exclusions — skills we deliberately do NOT bundle. */
const EXCLUDE = new Set([
  'migrate-to-codex', // Codex-migration helper — irrelevant inside this app
  'chatgpt-apps',     // ChatGPT-app SDK scaffolding — irrelevant inside this app
]);

/* Anthropic document skills we bundle (only the document set — the rest of that
   repo overlaps openai's or is Claude.ai-artifact-specific). Listed FIRST so its
   `pdf` wins the slug over openai's curated `pdf`. */
const ANTHROPIC_DOCS = new Set(['docx', 'pdf', 'pptx', 'xlsx', 'doc-coauthoring']);

const SETS = [
  { dir: join(ANTHROPIC_SRC, 'skills'), category: 'docs', pick: ANTHROPIC_DOCS, idBase: 'anthropics/skills' },
  { dir: join(SRC, 'skills', '.system'), category: 'system', idBase: 'openai/skills' },
  { dir: join(SRC, 'skills', '.curated'), category: 'curated', idBase: 'openai/skills' },
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
const seen = new Set(); // slugs must be unique (openai-docs appears in both openai sets — system wins; anthropic pdf beats openai pdf)
for (const { dir, category, pick, idBase } of SETS) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { console.warn(`skip missing set: ${dir}`); continue; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const skillRoot = join(dir, e.name);
    const slug = e.name;
    if (pick && !pick.has(slug)) continue;
    if (EXCLUDE.has(slug)) { console.warn(`skip excluded slug: ${slug} (${category})`); continue; }
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
      id: `${idBase}/${slug}`,
      name: meta.name || slug,
      description: meta.description || '',
      category,
      bytes,
      files,
    });
  }
}

const ORDER = { system: 0, docs: 1, curated: 2 };
skills.sort((a, b) => (a.category === b.category ? a.slug.localeCompare(b.slug) : (ORDER[a.category] ?? 9) - (ORDER[b.category] ?? 9)));

const data = {
  source: 'https://github.com/openai/skills + https://github.com/anthropics/skills',
  generatedAt: new Date().toISOString(),
  count: skills.length,
  skills,
};
writeFileSync(OUT, JSON.stringify(data), 'utf8');
console.log(`wrote ${OUT}: ${skills.length} skills, ${(JSON.stringify(data).length / 1024 / 1024).toFixed(2)} MB`);
for (const s of skills) console.log(`  [${s.category}] ${s.slug} — ${Object.keys(s.files).length} files`);
