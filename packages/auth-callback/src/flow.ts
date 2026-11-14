/**
 * Pure pieces of the login bridge (see terraform/auth.tf): what `state` must
 * look like, where the tokens may go, and how the redirect is built. No I/O
 * here, so all of it is unit-tested without AWS.
 */

export interface BridgeConfig {
  cognitoDomain: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  /** Origins (scheme://host[:port], no trailing slash) the tokens may be sent to. */
  allowedOrigins: string[];
}

export const RETURN_COOKIE = 'snowball_return';

export function loadConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Missing environment variable ${name}`);
    return value;
  };
  const allowedOrigins = need('ALLOWED_ORIGINS')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (allowedOrigins.length === 0) throw new Error('ALLOWED_ORIGINS is empty');
  return {
    cognitoDomain: need('COGNITO_DOMAIN').replace(/\/+$/, ''),
    clientId: need('COGNITO_CLIENT_ID'),
    clientSecret: need('COGNITO_CLIENT_SECRET'),
    callbackUrl: need('CALLBACK_URL'),
    allowedOrigins,
  };
}

/**
 * `state` is base64url(JSON { n, o }): `n` is the nonce the dashboard checks
 * when the tokens come back (CSRF), `o` the origin to return to. The origin
 * must be on the allowlist, otherwise anyone could craft a login link that
 * delivers a victim's tokens to their own site.
 */
export function returnOriginFromState(state: string | undefined, allowed: string[]): string | null {
  if (!state) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(state, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const { n, o } = (parsed ?? {}) as { n?: unknown; o?: unknown };
  if (typeof n !== 'string' || n.length < 16 || typeof o !== 'string') return null;
  return allowed.includes(o) ? o : null;
}

/** The fragment never reaches a server, so the tokens stay out of S3 and ALB logs. */
export function redirectWithFragment(origin: string, params: Record<string, string>): string {
  return `${origin}/#${new URLSearchParams(params).toString()}`;
}

export function cookieValue(cookies: string[] | undefined, name: string): string | undefined {
  for (const cookie of cookies ?? []) {
    const eq = cookie.indexOf('=');
    if (eq > 0 && cookie.slice(0, eq).trim() === name) return decodeURIComponent(cookie.slice(eq + 1).trim());
  }
  return undefined;
}
