import { describe, it, expect } from 'vitest';
import { buildIceServers } from '../ice';

describe('buildIceServers', () => {
  it('returns public STUN only when no TURN creds', () => {
    const s = buildIceServers();
    expect(s).toHaveLength(1);
    expect(s[0].urls).toContain('stun:stun.l.google.com:19302');
    expect(s[0].username).toBeUndefined();
  });

  it('appends self-host STUN + TURN/TURNS with creds when provided', () => {
    const s = buildIceServers({ host: 'turn.example.com', username: 'u', credential: 'c' });
    const flat = JSON.stringify(s);
    expect(flat).toContain('stun:turn.example.com:3478');
    expect(flat).toContain('turn:turn.example.com:3478?transport=udp');
    expect(flat).toContain('turns:turn.example.com:443?transport=tcp');
    const turn = s.find((e) => e.username === 'u');
    expect(turn?.credential).toBe('c');
  });
});
