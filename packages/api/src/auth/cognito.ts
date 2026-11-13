import { CognitoJwtVerifier } from 'aws-jwt-verify';
import type { DataAccess } from '../data-access';
import { assertClientInvariant, type AuthContext } from './scope';

/**
 * People authenticate with Cognito (Hosted UI, see terraform/auth.tf); this
 * API only verifies the access token the dashboard sends. Who the caller is
 * comes from the token, what they may do from snowball-users: the Cognito
 * username is the email, and the row with that email holds the role, the
 * client scope and the active flag. Looking the row up on every request also
 * means deactivating a user takes effect at once, token or no token.
 */

export interface CognitoConfig {
  userPoolId: string;
  clientId: string;
}

/** Verifies signature, expiry, issuer, token_use = access and client_id; returns the username. */
export type VerifyAccessToken = (token: string) => Promise<{ username: string }>;

/** Turns a bearer token into the caller's AuthContext; rejects on any problem. */
export type ResolveAuth = (token: string) => Promise<AuthContext>;

export function loadCognitoConfig(env: NodeJS.ProcessEnv = process.env): CognitoConfig {
  const userPoolId = env.COGNITO_USER_POOL_ID;
  const clientId = env.COGNITO_CLIENT_ID;
  if (!userPoolId || !clientId) {
    throw new Error('Missing COGNITO_USER_POOL_ID or COGNITO_CLIENT_ID (see packages/api/.env.example)');
  }
  return { userPoolId, clientId };
}

/** JWKS is fetched from Cognito on first use and cached by aws-jwt-verify. */
export function createCognitoVerifier(config: CognitoConfig): VerifyAccessToken {
  const verifier = CognitoJwtVerifier.create({
    userPoolId: config.userPoolId,
    clientId: config.clientId,
    tokenUse: 'access',
  });
  return async (token) => {
    const payload = await verifier.verify(token);
    return { username: String(payload.username) };
  };
}

export function createAuthResolver(
  verify: VerifyAccessToken,
  data: Pick<DataAccess, 'findUserByEmail'>,
): ResolveAuth {
  return async (token) => {
    if (!token) throw new Error('missing token');
    const { username } = await verify(token);
    const user = await data.findUserByEmail(username.trim().toLowerCase());
    if (!user) throw new Error('no snowball-users row for this Cognito user');
    if (!user.active) throw new Error('user is inactive');
    assertClientInvariant(user.role, user.client_id);
    return { userId: user.id, email: user.email, role: user.role, clientId: user.client_id };
  };
}
