import { cookieValue, loadConfig, RETURN_COOKIE, redirectWithFragment, returnOriginFromState, type BridgeConfig } from './flow';

/**
 * Lambda behind the snowball-auth HTTP API (payload 2.0):
 *
 *   GET /callback?code=…&state=…  The Cognito Hosted UI lands here after login.
 *       The code is exchanged for tokens with the client secret and the browser
 *       goes back to the dashboard origin named in `state`, tokens in the fragment.
 *   GET /logout                    Cognito lands here after the Hosted UI logout;
 *       the browser goes back to the origin remembered in a cookie at login.
 *
 * Both exist only because Cognito redirects to HTTPS URLs and the dashboard
 * is an HTTP S3 website.
 */

export interface HttpEvent {
  routeKey: string;
  queryStringParameters?: Record<string, string | undefined>;
  cookies?: string[];
}

export interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body?: string;
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface Tokens {
  access_token: string;
  id_token: string;
  expires_in: number;
}

const NO_STORE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const RETURN_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

function redirect(location: string, cookies?: string[]): HttpResult {
  return { statusCode: 302, headers: { ...NO_STORE, Location: location }, ...(cookies ? { cookies } : {}) };
}

function badRequest(message: string): HttpResult {
  return { statusCode: 400, headers: { ...NO_STORE, 'Content-Type': 'text/plain; charset=utf-8' }, body: message };
}

export function createHandler(config: BridgeConfig, fetchFn: Fetch) {
  async function exchangeCode(code: string): Promise<Tokens | null> {
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
    const res = await fetchFn(`${config.cognitoDomain}/oauth2/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        code,
        redirect_uri: config.callbackUrl,
      }).toString(),
    });
    if (!res.ok) {
      console.error(`[auth-callback] token exchange failed with HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as Record<string, unknown>;
    if (typeof body.access_token !== 'string' || typeof body.id_token !== 'string') {
      console.error('[auth-callback] token response without access_token/id_token');
      return null;
    }
    return { access_token: body.access_token, id_token: body.id_token, expires_in: Number(body.expires_in) || 3600 };
  }

  async function callback(event: HttpEvent): Promise<HttpResult> {
    const q = event.queryStringParameters ?? {};
    const state = q.state ?? '';
    const origin = returnOriginFromState(state, config.allowedOrigins);
    if (!origin) return badRequest('Solicitud de login inválida: volvé al dashboard e intentá de nuevo.');
    if (q.error) return redirect(redirectWithFragment(origin, { error: q.error, state }));
    if (!q.code) return badRequest('Falta el parámetro code.');

    let tokens: Tokens | null;
    try {
      tokens = await exchangeCode(q.code);
    } catch (err) {
      console.error('[auth-callback] token exchange threw:', err);
      tokens = null;
    }
    if (!tokens) return redirect(redirectWithFragment(origin, { error: 'token_exchange_failed', state }));

    // The refresh token stays behind on purpose: it would be the longest-lived
    // credential in the browser, and the 8 h access token covers a session.
    const returnCookie =
      `${RETURN_COOKIE}=${encodeURIComponent(origin)}; Path=/; Max-Age=${RETURN_COOKIE_MAX_AGE}; Secure; HttpOnly; SameSite=Lax`;
    return redirect(
      redirectWithFragment(origin, {
        access_token: tokens.access_token,
        id_token: tokens.id_token,
        expires_in: String(tokens.expires_in),
        state,
      }),
      [returnCookie],
    );
  }

  function logout(event: HttpEvent): HttpResult {
    const remembered = cookieValue(event.cookies, RETURN_COOKIE);
    const origin = remembered && config.allowedOrigins.includes(remembered) ? remembered : config.allowedOrigins[0];
    return redirect(`${origin}/`);
  }

  return async function handle(event: HttpEvent): Promise<HttpResult> {
    switch (event.routeKey) {
      case 'GET /callback':
        return callback(event);
      case 'GET /logout':
        return logout(event);
      default:
        return { statusCode: 404, headers: NO_STORE, body: 'not found' };
    }
  };
}

let cached: ReturnType<typeof createHandler> | undefined;

/** Config is read on the first invocation, so a missing variable fails that request instead of the import. */
export const handler = (event: HttpEvent): Promise<HttpResult> => {
  cached ??= createHandler(loadConfig(process.env), fetch as unknown as Fetch);
  return cached(event);
};
