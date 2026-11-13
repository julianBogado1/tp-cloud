import { describe, expect, test } from 'vitest';
import { authorizeUrl, logoutUrl, parseLoginRedirect, settingsFromEnv, type CognitoSettings } from '../src/cognito';

const settings: CognitoSettings = {
  domain: 'https://snowball-g8.auth.us-east-1.amazoncognito.com',
  clientId: 'client-123',
  authApi: 'https://abc.execute-api.us-east-1.amazonaws.com',
};
const NONCE = '0123456789abcdef0123456789abcdef';
const state = (n: string) => btoa(JSON.stringify({ n, o: 'http://localhost:5173' })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

describe('settingsFromEnv', () => {
  test('needs all three values and trims trailing slashes', () => {
    expect(settingsFromEnv({ VITE_COGNITO_DOMAIN: `${settings.domain}/`, VITE_COGNITO_CLIENT_ID: 'client-123', VITE_AUTH_API: `${settings.authApi}/` })).toEqual(settings);
    expect(settingsFromEnv({ VITE_COGNITO_DOMAIN: settings.domain, VITE_COGNITO_CLIENT_ID: 'client-123' })).toBeNull();
  });
});

describe('authorizeUrl', () => {
  test('code flow, redirect to the bridge, state carrying nonce and origin', () => {
    const url = new URL(authorizeUrl(settings, NONCE, 'http://localhost:5173'));
    expect(`${url.origin}${url.pathname}`).toBe(`${settings.domain}/oauth2/authorize`);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('redirect_uri')).toBe(`${settings.authApi}/callback`);
    expect(url.searchParams.get('scope')).toBe('openid email');
    const decoded = JSON.parse(atob(url.searchParams.get('state')!.replace(/-/g, '+').replace(/_/g, '/')));
    expect(decoded).toEqual({ n: NONCE, o: 'http://localhost:5173' });
  });
});

test('logoutUrl returns through the bridge', () => {
  const url = new URL(logoutUrl(settings));
  expect(url.pathname).toBe('/logout');
  expect(url.searchParams.get('logout_uri')).toBe(`${settings.authApi}/logout`);
});

describe('parseLoginRedirect', () => {
  test('no fragment, or an unrelated one, is not a login redirect', () => {
    expect(parseLoginRedirect('', NONCE)).toEqual({ kind: 'none' });
    expect(parseLoginRedirect('#section', NONCE)).toEqual({ kind: 'none' });
  });

  test('tokens with the matching nonce are accepted', () => {
    expect(parseLoginRedirect(`#access_token=AT&id_token=IT&expires_in=28800&state=${state(NONCE)}`, NONCE)).toEqual({
      kind: 'tokens',
      accessToken: 'AT',
    });
  });

  test('a foreign nonce, a missing nonce or a missing state is refused', () => {
    expect(parseLoginRedirect(`#access_token=AT&state=${state('someone-elses-nonce-0000000000')}`, NONCE)).toEqual({ kind: 'error', code: 'state_mismatch' });
    expect(parseLoginRedirect(`#access_token=AT&state=${state(NONCE)}`, null)).toEqual({ kind: 'error', code: 'state_mismatch' });
    expect(parseLoginRedirect('#access_token=AT', NONCE)).toEqual({ kind: 'error', code: 'state_mismatch' });
  });

  test('an error from the bridge is passed on', () => {
    expect(parseLoginRedirect(`#error=access_denied&state=${state(NONCE)}`, NONCE)).toEqual({ kind: 'error', code: 'access_denied' });
  });
});
