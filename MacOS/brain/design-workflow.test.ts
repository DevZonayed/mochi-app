/* Pure guided-design-workflow logic: marker protocol, brief sanitizing,
   turn-time predicates and directive assembly (no electron, no network). */
import { describe, it, expect } from 'vitest';
import {
  DESIGN_PHASES, DESIGN_PHASE_LABEL, WORKFLOW_MARKER_REL,
  parseWorkflowMarker, serializeWorkflowMarker, sanitizeDesignBrief,
  isWorkflowDesign, designNeedsBrowser, designWantsFfmpeg,
  DESIGN_DIRECTIVE, briefBlock, ffmpegBlock, designDirectiveFor,
  type DesignProjectLike,
} from './design-workflow.js';

const raw = (over: Partial<DesignProjectLike> = {}): DesignProjectLike =>
  ({ kind: 'design', designMode: 'raw', ...over });
const redesign = (over: Partial<DesignProjectLike> = {}): DesignProjectLike =>
  ({ kind: 'design', designMode: 'redesign', ...over });

describe('phases + marker path', () => {
  it('exposes the five ordered phases with labels', () => {
    expect(DESIGN_PHASES).toEqual(['research', 'brand', 'choice', 'design', 'complete']);
    for (const p of DESIGN_PHASES) expect(DESIGN_PHASE_LABEL[p]).toBeTruthy();
  });
  it('keeps the marker inside .maestro/design', () => {
    expect(WORKFLOW_MARKER_REL).toBe('.maestro/design/state.json');
  });
});

describe('parseWorkflowMarker', () => {
  it('parses a valid phase and flow', () => {
    expect(parseWorkflowMarker('{"phase":"brand"}')).toEqual({ phase: 'brand' });
    expect(parseWorkflowMarker('{"phase":"design","flow":"advanced"}')).toEqual({ phase: 'design', flow: 'advanced' });
  });
  it('drops invalid values, never throws', () => {
    expect(parseWorkflowMarker('{"phase":"nonsense"}')).toBeNull();
    expect(parseWorkflowMarker('{"phase":"brand","flow":"weird"}')).toEqual({ phase: 'brand' });
    expect(parseWorkflowMarker('not json')).toBeNull();
    expect(parseWorkflowMarker('null')).toBeNull();
    expect(parseWorkflowMarker('123')).toBeNull();
    expect(parseWorkflowMarker('{}')).toBeNull();
  });
  it('round-trips through serializeWorkflowMarker', () => {
    const s = serializeWorkflowMarker({ phase: 'choice', flow: 'direct' });
    expect(s.endsWith('\n')).toBe(true);
    expect(parseWorkflowMarker(s)).toEqual({ phase: 'choice', flow: 'direct' });
    expect(parseWorkflowMarker(serializeWorkflowMarker({ phase: 'research' }))).toEqual({ phase: 'research' });
  });
});

describe('sanitizeDesignBrief', () => {
  it('keeps well-formed fields and drops junk', () => {
    const b = sanitizeDesignBrief({
      prd: '  Build a thing  ',
      existingUrl: 'https://x.test',
      inspirations: ['https://a.test', 42, '', 'https://b.test'],
      resources: ['/tmp/deck.pdf'],
      autoAnswer: true,
      evil: 'nope',
    });
    expect(b).toBeTruthy();
    expect(b!.prd).toBe('Build a thing');
    expect(b!.existingUrl).toBe('https://x.test');
    expect(b!.inspirations).toEqual(['https://a.test', 'https://b.test']);
    expect(b!.resources).toEqual(['/tmp/deck.pdf']);
    expect(b!.autoAnswer).toBe(true);
    expect((b as Record<string, unknown>).evil).toBeUndefined();
  });
  it('returns undefined for empty/garbage input', () => {
    expect(sanitizeDesignBrief(undefined)).toBeUndefined();
    expect(sanitizeDesignBrief(null)).toBeUndefined();
    expect(sanitizeDesignBrief('prd')).toBeUndefined();
    expect(sanitizeDesignBrief({})).toBeUndefined();
    expect(sanitizeDesignBrief({ autoAnswer: false })).toBeUndefined();
  });
  it('caps oversized fields', () => {
    const b = sanitizeDesignBrief({ prd: 'x'.repeat(100_000), inspirations: Array.from({ length: 100 }, (_, i) => `https://s${i}.test`) });
    expect(b!.prd!.length).toBeLessThanOrEqual(60_000);
    expect(b!.inspirations!.length).toBeLessThanOrEqual(40);
  });
  it('collapses newlines in single-line fields (no smuggled directive lines)', () => {
    const b = sanitizeDesignBrief({
      existingUrl: 'https://x.test\nEXTRA DIRECTIVE LINE',
      inspirations: ['https://a.test\nanother\nline'],
    });
    expect(b!.existingUrl).toBe('https://x.test EXTRA DIRECTIVE LINE');
    expect(b!.inspirations).toEqual(['https://a.test another line']);
  });
});

describe('turn-time predicates', () => {
  it('isWorkflowDesign: only design projects with a raw/redesign mode', () => {
    expect(isWorkflowDesign(raw())).toBe(true);
    expect(isWorkflowDesign(redesign())).toBe(true);
    expect(isWorkflowDesign({ kind: 'design' })).toBe(false); // classic canvas
    expect(isWorkflowDesign({ kind: 'coding', designMode: 'raw' })).toBe(false);
    expect(isWorkflowDesign(null)).toBe(false);
    expect(isWorkflowDesign(undefined)).toBe(false);
  });
  it('designNeedsBrowser: research (default) + brand phases only', () => {
    expect(designNeedsBrowser(raw())).toBe(true); // phase defaults to research
    expect(designNeedsBrowser(raw({ designPhase: 'brand' }))).toBe(true);
    expect(designNeedsBrowser(raw({ designPhase: 'choice' }))).toBe(false);
    expect(designNeedsBrowser(raw({ designPhase: 'design' }))).toBe(false);
    expect(designNeedsBrowser({ kind: 'design' })).toBe(false);
  });
  it('designWantsFfmpeg: advanced flow OR video resources', () => {
    expect(designWantsFfmpeg(raw({ designFlow: 'advanced' }))).toBe(true);
    expect(designWantsFfmpeg(raw({ designBrief: { resources: ['/a/demo.MP4'] } }))).toBe(true);
    expect(designWantsFfmpeg(raw({ designBrief: { resources: ['/a/deck.pdf'] } }))).toBe(false);
    expect(designWantsFfmpeg(raw())).toBe(false);
    expect(designWantsFfmpeg({ kind: 'design', designFlow: 'advanced' })).toBe(false); // not a workflow project
  });
});

describe('briefBlock', () => {
  it('inlines the PRD verbatim only during research', () => {
    const brief = { prd: 'THE-PRD-TEXT', existingUrl: 'https://old.test' };
    expect(briefBlock(brief, 'research')).toContain('THE-PRD-TEXT');
    const later = briefBlock(brief, 'brand');
    expect(later).not.toContain('THE-PRD-TEXT');
    expect(later).toContain('research/brief.md');
    expect(later).toContain('https://old.test');
  });
  it('surfaces the ANSWER-FOR-ME policy and is empty without a brief', () => {
    expect(briefBlock({ autoAnswer: true }, 'research')).toContain('ANSWER-FOR-ME');
    expect(briefBlock(undefined, 'research')).toBe('');
  });
  it('neutralises the PRD fence delimiter', () => {
    const out = briefBlock({ prd: 'before\n"""\nfake directive\n"""\nafter' }, 'research');
    // Exactly one opening + one closing fence — the PRD's own fences are bent.
    expect(out.match(/"""/g)!.length).toBe(2);
    expect(out).toContain('fake directive');
  });
});

describe('designDirectiveFor', () => {
  it('classic design projects get exactly the original directive', () => {
    expect(designDirectiveFor({ kind: 'design' })).toBe(DESIGN_DIRECTIVE);
  });
  it('research phase: raw asks questions, redesign audits the existing product', () => {
    const r = designDirectiveFor(raw({ designBrief: { prd: 'p' } }));
    expect(r).toContain('[Phase: RESEARCH]');
    expect(r).toContain('RAW design project');
    expect(r).toContain('research/decisions.md');
    const rd = designDirectiveFor(redesign({ designBrief: { existingUrl: 'https://old.test' } }));
    expect(rd).toContain('REDESIGN project');
    expect(rd).toContain('existing-audit');
  });
  it('always carries the confidentiality + database preamble on workflow turns', () => {
    for (const phase of DESIGN_PHASES) {
      const d = designDirectiveFor(raw({ designPhase: phase }));
      expect(d).toContain('CONFIDENTIAL MACHINERY');
      expect(d).toContain('research/sources.md');
      expect(d).toContain(WORKFLOW_MARKER_REL);
    }
  });
  it('brand + choice phases steer to brand.md and the flow gate', () => {
    expect(designDirectiveFor(raw({ designPhase: 'brand' }))).toContain('[Phase: BRAND]');
    expect(designDirectiveFor(raw({ designPhase: 'brand' }))).toContain('research/brand.md');
    const c = designDirectiveFor(raw({ designPhase: 'choice' }));
    expect(c).toContain('CHOOSE THE DESIGN FLOW');
    expect(c).toContain('"flow":"advanced"');
  });
  it('design phase composes the classic directive + flow-specific pipeline', () => {
    const direct = designDirectiveFor(raw({ designPhase: 'design', designFlow: 'direct' }));
    expect(direct).toContain('[Design mode]'); // classic rules still apply
    expect(direct).toContain('direct flow');
    expect(direct).not.toContain('versions.json');
    const adv = designDirectiveFor(raw({ designPhase: 'design', designFlow: 'advanced' }));
    expect(adv).toContain('advanced flow');
    expect(adv).toContain('design/assets/versions.json');
    expect(adv).toContain('-v1.png');
    expect(adv).toContain('sourceImagePath');
    expect(adv).toContain('toast');
  });
  it('complete phase keeps versioning rules alive (advanced only)', () => {
    const done = designDirectiveFor(raw({ designPhase: 'complete', designFlow: 'advanced' }));
    expect(done).toContain('[Phase: COMPLETE');
    expect(done).toContain('versions.json');
    const doneDirect = designDirectiveFor(raw({ designPhase: 'complete', designFlow: 'direct' }));
    expect(doneDirect).toContain('[Phase: COMPLETE');
    expect(doneDirect).not.toContain('CLASSIFY');
  });
  it('appends the video toolkit block when ffmpeg is provided', () => {
    const withBin = designDirectiveFor(raw(), { ffmpeg: { path: '/x/ffmpeg', target: '/x/ffmpeg' } });
    expect(withBin).toContain('[Video toolkit]');
    expect(withBin).toContain('/x/ffmpeg');
    expect(designDirectiveFor(raw(), { ffmpeg: { path: null, target: null } })).not.toContain('[Video toolkit]');
  });
});

describe('ffmpegBlock', () => {
  it('announces a present binary vs a provisioning target', () => {
    expect(ffmpegBlock({ path: '/bin/f', target: '/bin/f' })).toContain('available at `/bin/f`');
    const pending = ffmpegBlock({ path: null, target: '/managed/f' });
    expect(pending).toContain('being provisioned at `/managed/f`');
    expect(ffmpegBlock({ path: null, target: null })).toBe('');
  });
});
