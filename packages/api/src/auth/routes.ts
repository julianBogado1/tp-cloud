import { Router, type RequestHandler } from 'express';
import type { AuthUser } from '@snowball/shared';
import type { DataAccess } from '../data-access';
import { signToken } from './jwt';
import { authenticate, getAuth, loginRateLimit } from './middleware';
import { DUMMY_HASH, verifyPassword } from './password';

/**
 * POST /auth/login  { email, password } → { token, user }
 * GET  /auth/me     (Bearer)            → AuthContext
 *
 * Unknown email, wrong password and inactive account all answer the same
 * 401 and cost the same bcrypt compare, so the response reveals nothing.
 */

export function createAuthRouter(
  data: Pick<DataAccess, 'findUserByEmail'>,
  secret: string,
  opts: { rateLimit?: RequestHandler } = {},
): Router {
  const router = Router();
  const limiter = opts.rateLimit ?? loginRateLimit({ max: 10, windowMs: 60_000 });

  router.post('/login', limiter, async (req, res) => {
    const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      res.status(400).json({ error: 'email and password are required' });
      return;
    }
    try {
      const user = await data.findUserByEmail(email.trim().toLowerCase());
      const ok = await verifyPassword(password, user?.password_hash ?? DUMMY_HASH);
      if (!user || !ok || !user.active) {
        console.warn(`[auth] failed login from ${req.ip} at ${new Date().toISOString()}`);
        res.status(401).json({ error: 'invalid credentials' });
        return;
      }
      const authUser: AuthUser = { id: user.id, email: user.email, role: user.role, client_id: user.client_id };
      res.json({ token: signToken(authUser, secret), user: authUser });
    } catch (err) {
      console.error('POST /auth/login failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.get('/me', authenticate(secret), (_req, res) => {
    res.json(getAuth(res));
  });

  return router;
}
