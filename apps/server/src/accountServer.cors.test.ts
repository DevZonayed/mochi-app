import { describe, it, expect } from 'vitest';
import { authCorsHeaders } from './accountServer.js';

/* Regression guard for the "Failed to fetch" sign-in bug: Better Auth's
   /api/auth/* responses are written through a hijacked reply, so @fastify/cors's
   onSend hook never adds CORS headers to the actual response. authCorsHeaders()
   supplies them so a real browser origin (the desktop dev build) can read the
   response and the session token. */
describe('authCorsHeaders (hijacked /api/auth/* CORS)', () => {
  it('reflects the request Origin so the actual auth response is CORS-readable', () => {
    const h = authCorsHeaders('http://localhost:5173');
    expect(h['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    expect(h.Vary).toBe('Origin');
  });

  it('exposes set-auth-token so the renderer can read the session token cross-origin', () => {
    expect(authCorsHeaders('http://localhost:5173')['Access-Control-Expose-Headers']).toBe('set-auth-token');
  });

  it('reflects any browser origin, not a single hard-coded one', () => {
    expect(authCorsHeaders('https://app.example.com')['Access-Control-Allow-Origin']).toBe('https://app.example.com');
  });

  it('emits no CORS headers when there is no Origin (packaged app / file:// → null Origin)', () => {
    expect(authCorsHeaders(undefined)).toEqual({});
  });
});
