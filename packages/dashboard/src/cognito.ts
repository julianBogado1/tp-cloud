/**
 * Login through the Cognito Hosted UI, with the HTTPS bridge of
 * terraform/auth.tf in between (Cognito will not redirect to this HTTP site):
 *
 *   1. startLogin(): a nonce goes to sessionStorage and the browser goes to the
 *      Hosted UI; `state` carries the nonce and this site's origin.
 *   2. Cognito → API Gateway /callback → Lambda exchanges the code → 302 back
 *      here with #access_token=…&state=… in the fragment.
 *   3. consumeLoginRedirect(): reads the fragment once, checks the nonce,
 *      and wipes the tokens from the address bar.
 *
 * The three settings are baked in at build time, like VITE_API_BASE; the
 * values come from `terraform output` (see docs/infra-terraform.md).
 */

export interface CognitoSettings {
  /** https://<prefix>.auth.<region>.amazoncognito.com */
  domain: string;
  clientId: string;
  /** API Gateway base URL; /callback and /logout live under it. */
  authApi: string;
}

export function settingsFromEnv(env: Record<string, string | undefined>): CognitoSettings | null {
  const domain = env.VITE_COGNITO_DOMAIN?.replace(/\/+$/, '');
  const clientId = env.VITE_COGNITO_CLIENT_ID;
  const authApi = env.VITE_AUTH_API?.replace(/\/+$/, '');
  return domain && clientId && authApi ? { domain, clientId, authApi } : null;
}

export const COGNITO: CognitoSettings | null = settingsFromEnv(import.meta.env as Record<string, string | undefined>);

const NONCE_KEY = 'snowball.login-nonce';

function base64url(text: string): string {
  return btoa(text).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function authorizeUrl(settings: CognitoSettings, nonce: string, origin: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: settings.clientId,
    redirect_uri: `${settings.authApi}/callback`,
    scope: 'openid email',
    state: base64url(JSON.stringify({ n: nonce, o: origin })),
  });
  return `${settings.domain}/oauth2/authorize?${params.toString()}`;
}

export function logoutUrl(settings: CognitoSettings): string {
  const params = new URLSearchParams({ client_id: settings.clientId, logout_uri: `${settings.authApi}/logout` });
  return `${settings.domain}/logout?${params.toString()}`;
}

export function startLogin(settings: CognitoSettings): void {
  const nonce = randomNonce();
  try {
    sessionStorage.setItem(NONCE_KEY, nonce);
  } catch {
    // Without storage the nonce check fails on return and the user sees an error.
  }
  window.location.assign(authorizeUrl(settings, nonce, window.location.origin));
}

export type LoginRedirect =
  | { kind: 'none' }
  | { kind: 'error'; code: string }
  | { kind: 'tokens'; accessToken: string };

/**
 * Pure: what the fragment says, checked against the nonce stored before
 * leaving. A fragment whose nonce does not match is someone else's login
 * (CSRF / login fixation) and is refused.
 */
export function parseLoginRedirect(hash: string, expectedNonce: string | null): LoginRedirect {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (!params.has('access_token') && !params.has('error')) return { kind: 'none' };
  let nonce: unknown;
  try {
    const state = (params.get('state') ?? '').replace(/-/g, '+').replace(/_/g, '/');
    nonce = (JSON.parse(atob(state)) as { n?: unknown }).n;
  } catch {
    nonce = undefined;
  }
  if (!expectedNonce || nonce !== expectedNonce) return { kind: 'error', code: 'state_mismatch' };
  const error = params.get('error');
  if (error) return { kind: 'error', code: error };
  return { kind: 'tokens', accessToken: params.get('access_token') ?? '' };
}

let consumed: LoginRedirect | undefined;

/**
 * Reads the login fragment once per page load (StrictMode runs effects twice;
 * the nonce is single-use) and clears it from the URL and from storage.
 */
export function consumeLoginRedirect(): LoginRedirect {
  if (consumed) return consumed;
  let nonce: string | null = null;
  try {
    nonce = sessionStorage.getItem(NONCE_KEY);
  } catch {
    nonce = null;
  }
  consumed = parseLoginRedirect(window.location.hash, nonce);
  if (consumed.kind !== 'none') {
    try {
      sessionStorage.removeItem(NONCE_KEY);
    } catch {
      // ignore
    }
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return consumed;
}
