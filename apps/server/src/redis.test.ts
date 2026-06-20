import { describe, it, expect } from 'vitest';
import { markOnline, markOffline, isOnline, setSnapshot, getSnapshot } from './redis.js';

describe('redis helpers', () => {
  it('presence reflects markOnline/markOffline', async () => {
    await markOnline('dev-1', 30);
    expect(await isOnline('dev-1')).toBe(true);
    expect(await isOnline('nope-xyz')).toBe(false);
    await markOffline('dev-1');
    expect(await isOnline('dev-1')).toBe(false);
  });

  it('snapshot round-trips', async () => {
    await setSnapshot('host-1', { projects: [{ id: 'p1' }] });
    expect(await getSnapshot('host-1')).toEqual({ projects: [{ id: 'p1' }] });
    expect(await getSnapshot('host-absent')).toBeNull();
  });
});
