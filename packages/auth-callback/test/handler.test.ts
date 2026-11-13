import { describe, expect, it, vi } from 'vitest';
import { cookieValue, loadConfig, returnOriginFromState, type BridgeConfig } from '../src/flow';
import { createHandler, type Fetch } from '../src/handler';

const DASHBOARD = 'http://snowball-dashboard-g8.s3-website-us-east-1.amazonaws.com';
const LOCAL = 'http://localhost:5173';

const config: BridgeConfig = {
  cognitoDomain: 'https://snowball-g8.auth.us-east-1.amazoncognito.com',
  clientId: 'client-123',
  clientSecret: 'secret-456',
  callbackUrl: 'https://abc.execute-api.us-east-1.amazonaws.com/callback',
  allowedOrigins: [DASHBOARD, LOCAL],
};

const state = (o: string, n = 'nonce-0123456789abcdef') => Buffer.from(JSON.stringify({ n, o })).toString('base64url');

function tokenFetch(status = 200, body: unknown = { access_token: 'AT', id_token: 'IT', refresh_token: 'RT', expires_in: 28800 }) {
  return vi.fn<Fetch>(async () => ({ ok: status < 400, status, json: async () => body }));
}

function fragment(location: string): URLSearchParams {
  return new URLSearchParams(location.slice(location.indexOf('#') + 1));
}

describe('returnOriginFromState', () => {
  it('accepts an allowlisted origin with a nonce', () => {
    expect(returnOriginFromState(state(LOCAL), config.allowedOrigins)).toBe(LOCAL);
  });
  it('refuses an origin outside the allowlist (no open redirect)', () => {
    expect(returnOriginFromState(state('http://evil.example'), config.allowedOrigins)).toBeNull();
  });
  it('refuses a short nonce, garbage and a missing state', () => {
    expect(returnOriginFromState(state(LOCAL, 'short'), config.allowedOrigins)).toBeNull();
    expect(returnOriginFromState('not-base64-json', config.allowedOrigins)).toBeNull();
    expect(returnOriginFromState(undefined, config.allowedOrigins)).toBeNull();
  });
});

describe('loadConfig', () => {
  it('trims trailing slashes and splits the origins', () => {
    const c = loadConfig({
      COGNITO_DOMAIN: 'https://d.auth.us-east-1.amazoncognito.com/',
      COGNITO_CLIENT_ID: 'id',
      COGNITO_CLIENT_SECRET: 'secret',
      CALLBACK_URL: 'https://x/callback',
      ALLOWED_ORIGINS: `${DASHBOARD}/, ${LOCAL}`,
    });
    expect(c.cognitoDomain).toBe('https://d.auth.us-east-1.amazoncognito.com');
    expect(c.allowedOrigins).toEqual([DASHBOARD, LOCAL]);
  });
  it('fails on a missing variable', () => {
    expect(() => loadConfig({})).toThrow(/COGNITO_DOMAIN|ALLOWED_ORIGINS/);
  });
});

describe('GET /callback', () => {
  it('exchanges the code with the client secret and redirects with the tokens in the fragment', async () => {
    const fetchFn = tokenFetch();
    const s = state(DASHBOARD);
    const res = await createHandler(config, fetchFn)({ routeKey: 'GET /callback', queryStringParameters: { code: 'CODE', state: s } });

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${config.cognitoDomain}/oauth2/token`);
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('client-123:secret-456').toString('base64')}`);
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('CODE');
    expect(body.get('redirect_uri')).toBe(config.callbackUrl);

    expect(res.statusCode).toBe(302);
    expect(res.headers.Location.startsWith(`${DASHBOARD}/#`)).toBe(true);
    const f = fragment(res.headers.Location);
    expect(f.get('access_token')).toBe('AT');
    expect(f.get('id_token')).toBe('IT');
    expect(f.get('expires_in')).toBe('28800');
    expect(f.get('state')).toBe(s);
    expect(f.has('refresh_token')).toBe(false);
    expect(res.cookies?.[0]).toMatch(/^snowball_return=.+; Path=\/;.*Secure; HttpOnly/);
    expect(res.headers['Cache-Control']).toBe('no-store');
  });

  it('answers 400 and never calls Cognito when the state is not allowlisted', async () => {
    const fetchFn = tokenFetch();
    const res = await createHandler(config, fetchFn)({
      routeKey: 'GET /callback',
      queryStringParameters: { code: 'CODE', state: state('http://evil.example') },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('forwards a Hosted UI error to the dashboard', async () => {
    const s = state(LOCAL);
    const res = await createHandler(config, tokenFetch())({
      routeKey: 'GET /callback',
      queryStringParameters: { error: 'access_denied', state: s },
    });
    expect(res.statusCode).toBe(302);
    expect(fragment(res.headers.Location).get('error')).toBe('access_denied');
  });

  it('redirects with token_exchange_failed when Cognito rejects the code', async () => {
    const res = await createHandler(config, tokenFetch(400, { error: 'invalid_grant' }))({
      routeKey: 'GET /callback',
      queryStringParameters: { code: 'OLD', state: state(DASHBOARD) },
    });
    const f = fragment(res.headers.Location);
    expect(f.get('error')).toBe('token_exchange_failed');
    expect(f.has('access_token')).toBe(false);
    expect(res.cookies).toBeUndefined();
  });

  it('answers 400 without a code', async () => {
    const res = await createHandler(config, tokenFetch())({ routeKey: 'GET /callback', queryStringParameters: { state: state(LOCAL) } });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /logout', () => {
  it('returns to the origin remembered at login', async () => {
    const res = await createHandler(config, tokenFetch())({
      routeKey: 'GET /logout',
      cookies: [`other=1`, `snowball_return=${encodeURIComponent(LOCAL)}`],
    });
    expect(res.headers.Location).toBe(`${LOCAL}/`);
  });
  it('falls back to the first allowed origin for a missing or foreign cookie', async () => {
    const handle = createHandler(config, tokenFetch());
    expect((await handle({ routeKey: 'GET /logout' })).headers.Location).toBe(`${DASHBOARD}/`);
    expect((await handle({ routeKey: 'GET /logout', cookies: ['snowball_return=http%3A%2F%2Fevil.example'] })).headers.Location).toBe(`${DASHBOARD}/`);
  });
});

it('cookieValue decodes the named cookie only', () => {
  expect(cookieValue(['a=1', 'b=x%20y'], 'b')).toBe('x y');
  expect(cookieValue(undefined, 'b')).toBeUndefined();
});
