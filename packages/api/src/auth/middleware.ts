import type { RequestHandler, Response } from 'express';
import { hasRole, type Role } from '@snowball/shared';
import type { ResolveAuth } from './cognito';
import type { AuthContext } from './scope';

/**
 * Express glue. The verified AuthContext travels in `res.locals.auth`
 * (typed access through getAuth) so route modules need no Request augmentation.
 */

export function authenticate(resolve: ResolveAuth): RequestHandler {
  return (req, res, next) => {
    const header = req.headers.authorization ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    resolve(token).then(
      (auth) => {
        res.locals.auth = auth;
        next();
      },
      () => {
        res.status(401).json({ error: 'unauthorized' });
      },
    );
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
