import { describe, expect, it } from 'vitest';
import type { ShadowActionSender } from './shadowActionBuilders';
import { ShadowActionApi } from './shadowActionBuilders.testonly';
import type { ShadowCapability } from '@maestro/realtime/shadowCapabilities';

function sender(): { s: ShadowActionSender; calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  return { s: { sendCommand: async (method, params) => { calls.push({ method, params }); return { commandId: `cmd_${calls.length}` }; } }, calls };
}

describe('ShadowActionApi — capability-gated typed builders (NO UI)', () => {
  it('sends when the capability is approved', async () => {
    const { s, calls } = sender();
    const api = new ShadowActionApi(s, ['account.read', 'session.autopilot.set'] as ShadowCapability[]);
    expect(api.can('controller.session.autopilot.set')).toBe(true);
    const r = await api.setAutopilot('sess_1', true);
    expect(r).toEqual({ ok: true, commandId: 'cmd_1' });
    expect(calls).toEqual([{ method: 'controller.session.autopilot.set', params: { sessionId: 'sess_1', enabled: true } }]);
  });

  it('fails closed (no send) when the capability is missing', async () => {
    const { s, calls } = sender();
    const api = new ShadowActionApi(s, ['account.read'] as ShadowCapability[]);
    expect(api.can('controller.job.cancel')).toBe(false);
    const r = await api.cancelJob('job_1');
    expect(r).toEqual({ ok: false, reason: 'capability-missing:job.cancel' });
    expect(calls).toEqual([]); // nothing sent
  });

  it('validates payloads before send', async () => {
    const { s, calls } = sender();
    const api = new ShadowActionApi(s, ['session.message', 'approval.respond', 'job.start'] as ShadowCapability[]);
    expect(await api.sendMessage('bad id!', 'hi')).toMatchObject({ ok: false, reason: 'bad-params' });
    expect(await api.sendMessage('sess_1', '')).toMatchObject({ ok: false, reason: 'bad-params' });
    expect(await api.respondApproval('appr_1', 'nope' as 'approve')).toMatchObject({ ok: false });
    expect(await api.startJob('proj_1', 'go', { sessionId: 'bad!' })).toMatchObject({ ok: false, reason: 'bad-session' });
    expect(calls).toEqual([]); // no invalid sends
  });

  it('all six actions map to their exact methods when permitted', async () => {
    const { s, calls } = sender();
    const api = new ShadowActionApi(s, ['session.message', 'job.start', 'job.cancel', 'approval.respond', 'question.answer', 'session.autopilot.set'] as ShadowCapability[]);
    await api.sendMessage('sess_1', 'hi');
    await api.startJob('proj_1', 'do it', { title: 'T' });
    await api.cancelJob('job_1');
    await api.respondApproval('appr_1', 'deny');
    await api.answerQuestion('sess_1', 'job_1', 'yes');
    await api.setAutopilot('sess_1', false);
    expect(calls.map((c) => c.method)).toEqual([
      'controller.session.message', 'controller.job.start', 'controller.job.cancel',
      'controller.approval.respond', 'controller.question.answer', 'controller.session.autopilot.set',
    ]);
  });
});
