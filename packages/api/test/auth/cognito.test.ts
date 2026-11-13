import { describe, expect, test, vi } from 'vitest';
import { createAuthResolver, loadCognitoConfig, type VerifyAccessToken } from '../../src/auth/cognito';
import type { UserRecord } from '../../src/data-access';

const users: UserRecord[] = [
  { id: 2, email: 'sup@x', role: 'supervisor', client_id: 1, active: true },
  { id: 3, email: 'adm@x', role: 'admin', client_id: null, active: true },
  { id: 5, email: 'off@x', role: 'operator', client_id: 1, active: false },
  { id: 7, email: 'broken@x', role: 'operator', client_id: null, active: true },
];
const data = { findUserByEmail: vi.fn(async (email: string) => users.find((u) => u.email === email)) };

/** Accepts "valid:<username>", rejects everything else, like aws-jwt-verify would. */
const verify: VerifyAccessToken = async (token) => {
  if (!token.startsWith('valid:')) throw new Error('JwtInvalidSignatureError');
  return { username: token.slice('valid:'.length) };
};

describe('createAuthResolver', () => {
  const resolve = createAuthResolver(verify, data);

  test('maps the Cognito username (the email) to the snowball-users row', async () => {
    await expect(resolve('valid:sup@x')).resolves.toEqual({ userId: 2, email: 'sup@x', role: 'supervisor', clientId: 1 });
    await expect(resolve('valid:adm@x')).resolves.toEqual({ userId: 3, email: 'adm@x', role: 'admin', clientId: null });
  });

  test('looks the email up lowercased', async () => {
    await expect(resolve('valid:SUP@X')).resolves.toMatchObject({ userId: 2 });
    expect(data.findUserByEmail).toHaveBeenLastCalledWith('sup@x');
  });

  test('rejects a token Cognito did not sign, an empty token, an unknown user and an inactive user', async () => {
    await expect(resolve('forged')).rejects.toThrow();
    await expect(resolve('')).rejects.toThrow();
    await expect(resolve('valid:nobody@x')).rejects.toThrow(/no snowball-users row/);
    await expect(resolve('valid:off@x')).rejects.toThrow(/inactive/);
  });

  test('rejects a row that breaks the role/client invariant', async () => {
    await expect(resolve('valid:broken@x')).rejects.toThrow(/must have a client_id/);
  });
});

describe('loadCognitoConfig', () => {
  test('reads both variables and fails without them', () => {
    expect(loadCognitoConfig({ COGNITO_USER_POOL_ID: 'us-east-1_abc', COGNITO_CLIENT_ID: 'xyz' })).toEqual({
      userPoolId: 'us-east-1_abc',
      clientId: 'xyz',
    });
    expect(() => loadCognitoConfig({ COGNITO_USER_POOL_ID: 'us-east-1_abc' })).toThrow(/COGNITO_CLIENT_ID/);
  });
});
