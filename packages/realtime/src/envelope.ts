export type EnvelopeKind = 'cmd' | 'result' | 'event' | 'ack' | 'ping' | 'pong' | 'hello';

export interface Envelope {
  id: string;
  kind: EnvelopeKind;
  ts: number;
  payload?: unknown;
}

/** Dependency-free, RN/Hermes-safe id (message correlation, not security). */
export function genId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeEnvelope(kind: EnvelopeKind, payload?: unknown, id?: string): Envelope {
  return { id: id ?? genId(), kind, ts: Date.now(), payload };
}
