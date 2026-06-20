/* Session auth for REST + WS. Clients present the Better Auth session as a Bearer
   header, or — where headers aren't settable (some WS/EventSource clients) — as a
   `?token=` query param. Device identity rides as `x-maestro-device-id` / `?did=`. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getSessionUser } from './auth.js';

export type ReqWithUser = FastifyRequest & { userId?: string };

/** Resolve the account from a request (Bearer header or ?token= query). */
export async function userFromReq(req: FastifyRequest): Promise<{ userId: string } | null> {
  const headers: Record<string, string | string[] | undefined> = { ...req.headers };
  const token = (req.query as { token?: string } | undefined)?.token;
  if (!headers.authorization && typeof token === 'string' && token) {
    headers.authorization = `Bearer ${token}`;
  }
  return getSessionUser(headers);
}

/** The device making the request (header or query). */
export function deviceIdOf(req: FastifyRequest): string | null {
  const h = req.headers['x-maestro-device-id'];
  if (typeof h === 'string' && h) return h;
  const q = (req.query as { did?: string } | undefined)?.did;
  return typeof q === 'string' && q ? q : null;
}

/** Reject unauthenticated /api/* requests (Better Auth's own /api/auth/* is exempt;
    so are /health and /). On success, `req.userId` is set. */
export function installAuthHook(app: FastifyInstance): void {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const url = req.raw.url ?? '';
    if (!url.startsWith('/api/')) return;
    if (url.startsWith('/api/auth/')) return;
    const u = await userFromReq(req);
    if (!u) {
      await reply.code(401).send({ error: 'Unauthorized — sign in to your Maestro account' });
      return;
    }
    (req as ReqWithUser).userId = u.userId;
  });
}
