import type { RequestHandler, Response } from 'express';
import { hasRole, type Role } from '@snowball/shared';
import { verifyToken } from './jwt';
import type { AuthContext } from './scope';

/**
 * Express glue. The verified AuthContext travels in `res.locals.auth`
 * (typed access through getAuth) so route modules need no Request augmentation.
 */

export function authenticate(secret: string): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    try {
      res.locals.auth = verifyToken(token, secret);
    } catch {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}

export function getAuth(res: Response): AuthContext {
  const auth = res.locals.auth as AuthContext | undefined;
  if (!auth) throw new Error('getAuth called on a route without authenticate()');
  return auth;
}

export function requireRole(min: Role): RequestHandler {
  return (_req, res, next) => {
    if (!hasRole(getAuth(res).role, min)) {
      res.status(403).json({ error: 'forbidden' });
      return;
    }
    next();
  };
}

/**
 * In-memory sliding window per IP. Enough for one API instance and a demo;
 * a real deployment would move this to the load balancer.
 */
export function loginRateLimit(opts: { max: number; windowMs: number; now?: () => number }): RequestHandler {
  const now = opts.now ?? Date.now;
  const attempts = new Map<string, number[]>();
  return (req, res, next) => {
    const key = req.ip ?? 'unknown';
    const t = now();
    const recent = (attempts.get(key) ?? []).filter((ts) => t - ts < opts.windowMs);
    if (recent.length >= opts.max) {
      attempts.set(key, recent);
      res.status(429).json({ error: 'too many attempts, retry later' });
      return;
    }
    recent.push(t);
    attempts.set(key, recent);
    next();
  };
}
