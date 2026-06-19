import { describe, it, expect } from 'vitest';
import { genId, makeEnvelope } from '../envelope';

describe('envelope', () => {
  it('genId returns unique non-empty strings', () => {
    const a = genId();
    const b = genId();
    expect(a).toBeTruthy();
    expect(typeof a).toBe('string');
    expect(a).not.toBe(b);
  });

  it('makeEnvelope fills id/kind/ts and keeps payload', () => {
    const e = makeEnvelope('cmd', { method: 'ping' });
    expect(e.kind).toBe('cmd');
    expect(e.id).toBeTruthy();
    expect(typeof e.ts).toBe('number');
    expect(e.payload).toEqual({ method: 'ping' });
  });

  it('makeEnvelope honors an explicit id (for ack/pong echo)', () => {
    expect(makeEnvelope('ack', undefined, 'xyz').id).toBe('xyz');
  });
});
