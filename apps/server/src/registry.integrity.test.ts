import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';

import { auditForServedSkillBytes, auditProvidersForServedBytes, providerAuditedDigest, summaryAuditEvidence, type RegistrySkill } from './registry.js';

const skillMd = '---\nname: demo\n---\n\n# Demo\n';
const changedMd = '---\nname: demo\n---\n\n# Demo changed\n';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('registry content audit integrity', () => {
  it('does not synthesize audit evidence for unaudited content', () => {
    expect(auditForServedSkillBytes({ skillId: 'owner/repo/demo', hash: sha(skillMd), providers: [] }))
      .toMatchObject({ identity: null, status: 'unverified', auditedDigest: null });
  });

  it('does not let a prior passing audit authorize changed bytes', () => {
    expect(auditForServedSkillBytes({
      skillId: 'owner/repo/demo',
      hash: sha(changedMd),
      providers: [{ provider: 'unit', status: 'pass', riskLevel: 'LOW', auditedAt: '2026-07-16T00:00:00.000Z', auditedDigest: sha(skillMd) }],
    })).toMatchObject({ identity: null, status: 'pending', auditedDigest: null });
  });

  it('returns passing audit authority only when persisted audited digest matches served bytes', () => {
    expect(auditForServedSkillBytes({
      skillId: 'owner/repo/demo',
      hash: sha(skillMd),
      providers: [{ provider: 'unit', status: 'pass', riskLevel: 'LOW', auditedAt: '2026-07-16T00:00:00.000Z', auditedDigest: sha(skillMd) }],
    })).toMatchObject({
      identity: `owner/repo/demo:unit:pass:${sha(skillMd)}`,
      status: 'pass',
      auditedDigest: sha(skillMd),
    });
  });

  it('returns exact persisted audit evidence in summaries without fabricating stale evidence', () => {
    const base = {
      id: 'owner/repo/demo',
      sha256: sha(skillMd),
      security: { risk: 'LOW', providers: [{ provider: 'unit', status: 'pass', auditedDigest: sha(skillMd) }] },
    } as RegistrySkill;
    expect(summaryAuditEvidence(base)).toEqual({
      auditEvidenceId: `owner/repo/demo:unit:pass:${sha(skillMd)}`,
      auditedDigest: sha(skillMd),
    });
    expect(summaryAuditEvidence({ ...base, sha256: sha(changedMd) })).toEqual({
      auditEvidenceId: null,
      auditedDigest: null,
    });
  });

  it('persists only explicit audited digests from provider evidence', () => {
    expect(providerAuditedDigest({ provider: 'unit', status: 'pass' })).toBeNull();
    expect(providerAuditedDigest({ provider: 'unit', status: 'fail' })).toBeNull();
    expect(providerAuditedDigest({ provider: 'unit', status: 'pass', auditedDigest: sha(changedMd) })).toBe(sha(changedMd));
    expect(providerAuditedDigest({ provider: 'unit', status: 'pass', audited_digest: sha(skillMd) })).toBe(sha(skillMd));
  });

  it('does not synthesize audited digests from digest-less passing provider statuses', () => {
    expect(providerAuditedDigest({ provider: 'unit', status: 'pass' })).toBeNull();
    expect(providerAuditedDigest({ provider: 'unit', status: 'warn' })).toBeNull();
  });

  it('does not bind digest-less passing audits unless tied to the served immutable commit', () => {
    const t = '2026-07-16T00:00:00.000Z';
    expect(auditProvidersForServedBytes({
      secure: true,
      risk: 'LOW',
      providers: [{ provider: 'unit', status: 'pass', riskLevel: 'LOW', auditedAt: t }],
    }, sha(skillMd), 'abc123')).toEqual([{ provider: 'unit', status: 'pass', riskLevel: 'LOW', auditedAt: t }]);

    const providers = auditProvidersForServedBytes({
      secure: true,
      risk: 'LOW',
      providers: [{ provider: 'unit', status: 'pass', riskLevel: 'LOW', auditedAt: t, commitSha: 'abc123' } as RegistrySkill['security']['providers'][number] & { commitSha: string }],
    }, sha(skillMd), 'abc123');
    expect(providers).toEqual([{ provider: 'unit', status: 'pass', riskLevel: 'LOW', auditedAt: t, commitSha: 'abc123', auditedDigest: sha(skillMd) }]);
    expect(auditForServedSkillBytes({ skillId: 'owner/repo/demo', hash: sha(skillMd), providers })).toMatchObject({
      identity: `owner/repo/demo:unit:pass:${sha(skillMd)}`,
      auditedDigest: sha(skillMd),
    });
  });
});
