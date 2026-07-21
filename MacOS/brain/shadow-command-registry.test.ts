import { describe, expect, it } from 'vitest';
import { defineShadowCommandRegistry, type ShadowCommandRegistryEntry } from './shadow-host-service.js';

const okExec = async () => ({ ok: false as const, code: 'x', message: 'x' });
const okAdapter = { execute: async () => ({ ok: false as const, code: 'x', message: 'x' }) };
const okParse = () => ({ ok: true as const, value: {} });

describe('defineShadowCommandRegistry — Section 2 runtime/type contracts', () => {
  it('accepts read-only / event-only / product-idempotent entries', () => {
    expect(() => defineShadowCommandRegistry({
      a: { effectMode: 'read-only', execute: okExec },
      b: { effectMode: 'event-only', execute: okExec },
      c: { effectMode: 'product-idempotent', requiredCapability: 'job.cancel', parse: okParse, adapter: okAdapter },
    })).not.toThrow();
  });

  it('rejects a mutating/unknown effectMode cast', () => {
    expect(() => defineShadowCommandRegistry({
      bad: { effectMode: 'mutating' as unknown as 'read-only', execute: okExec },
    })).toThrow(/forbidden effectMode/);
    expect(() => defineShadowCommandRegistry({
      bad: { effectMode: undefined as unknown as 'read-only', execute: okExec },
    })).toThrow(/forbidden effectMode/);
  });

  it('product-idempotent requires known capability + parser + adapter.execute', () => {
    const base = { effectMode: 'product-idempotent' as const, requiredCapability: 'job.cancel' as const, parse: okParse, adapter: okAdapter };
    expect(() => defineShadowCommandRegistry({ m: { ...base, requiredCapability: 'account.write' as never } })).toThrow(/unknown requiredCapability/);
    expect(() => defineShadowCommandRegistry({ m: { ...base, parse: undefined as never } })).toThrow(/no parser/);
    expect(() => defineShadowCommandRegistry({ m: { ...base, adapter: {} as never } })).toThrow(/no adapter.execute/);
    expect(() => defineShadowCommandRegistry({ m: { ...base, adapter: undefined as never } })).toThrow(/no adapter.execute/);
  });

  it('rejects empty method names and a read-only entry with no executor', () => {
    expect(() => defineShadowCommandRegistry({ '': { effectMode: 'read-only', execute: okExec } })).toThrow(/empty method/);
    expect(() => defineShadowCommandRegistry({ m: { effectMode: 'read-only', execute: undefined as never } })).toThrow(/no executor/);
  });

  it('a cast product-idempotent entry missing its fields still runtime-rejects', () => {
    const sneaky = { effectMode: 'product-idempotent', execute: okExec } as unknown as ShadowCommandRegistryEntry;
    expect(() => defineShadowCommandRegistry({ m: sneaky })).toThrow(/unknown requiredCapability|no parser|no adapter/);
  });
});
