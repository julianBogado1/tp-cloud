import { Router } from 'express';
import type { ResolveAuth } from './cognito';
import { authenticate, getAuth } from './middleware';

/**
 * GET /auth/me (Bearer Cognito access token) → AuthContext
 *
 * Login itself happens in the Cognito Hosted UI (see terraform/auth.tf); the
 * dashboard calls this right after, to learn the role and client scope that
 * snowball-users holds for the email in the token.
 */
export function createAuthRouter(resolve: ResolveAuth): Router {
  const router = Router();
  router.get('/me', authenticate(resolve), (_req, res) => {
    res.json(getAuth(res));
  });
  return router;
}
