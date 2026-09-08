import jwt from 'jsonwebtoken';
import { isRole, type AuthClaims, type AuthUser } from '@snowball/shared';
import { assertClientInvariant, type AuthContext } from './scope';

/** HS256 tokens issued by this API. No refresh, no revocation (see spec §3.1). */

export const TOKEN_TTL_SECONDS = 8 * 60 * 60;
export const MIN_SECRET_LENGTH = 32;

export function loadJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.JWT_SECRET;
  if (!secret) throw new Error('Missing environment variable JWT_SECRET (see packages/api/.env.example)');
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }
  return secret;
}

export function signToken(
  user: AuthUser,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const claims: AuthClaims = {
    sub: String(user.id),
    email: user.email,
    role: user.role,
    client_id: user.client_id,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_TTL_SECONDS,
  };
  return jwt.sign(claims, secret, { algorithm: 'HS256' });
}

/** Throws on any problem: bad signature, expired, malformed claims, invariant broken. */
export function verifyToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AuthContext {
  const decoded = jwt.verify(token, secret, { algorithms: ['HS256'], clockTimestamp: nowSeconds });
  if (typeof decoded !== 'object' || decoded === null) throw new Error('malformed token');
  const c = decoded as Partial<AuthClaims>;
  const userId = Number(c.sub);
  if (!Number.isInteger(userId) || typeof c.email !== 'string' || !isRole(c.role)) {
    throw new Error('malformed token claims');
  }
  const clientId = c.client_id === null || c.client_id === undefined ? null : Number(c.client_id);
  if (clientId !== null && !Number.isInteger(clientId)) throw new Error('malformed client_id claim');
  assertClientInvariant(c.role, clientId);
  return { userId, email: c.email, role: c.role, clientId };
}
