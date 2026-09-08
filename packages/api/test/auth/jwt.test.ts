import { describe, expect, test } from 'vitest';
import { loadJwtSecret, signToken, TOKEN_TTL_SECONDS, verifyToken } from '../../src/auth/jwt';

const secret = 's'.repeat(32);
const user = { id: 42, email: 'sup@snowball.example', role: 'supervisor' as const, client_id: 1 };

describe('loadJwtSecret', () => {
  test('rejects missing or short secrets', () => {
    expect(() => loadJwtSecret({})).toThrow(/JWT_SECRET/);
    expect(() => loadJwtSecret({ JWT_SECRET: 'short' })).toThrow(/32/);
    expect(loadJwtSecret({ JWT_SECRET: secret })).toBe(secret);
  });
});

describe('signToken / verifyToken', () => {
  test('round-trips the user into an AuthContext', () => {
    const token = signToken(user, secret, 1_000_000);
    expect(verifyToken(token, secret, 1_000_001)).toEqual({
      userId: 42,
      email: 'sup@snowball.example',
      role: 'supervisor',
      clientId: 1,
    });
  });

  test('expires after 8 hours', () => {
    const token = signToken(user, secret, 1_000_000);
    expect(() => verifyToken(token, secret, 1_000_000 + TOKEN_TTL_SECONDS + 1)).toThrow(/expired/i);
  });

  test('rejects a wrong secret and a tampered payload', () => {
    const token = signToken(user, secret, 1_000_000);
    expect(() => verifyToken(token, 'x'.repeat(32), 1_000_001)).toThrow();
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    payload.role = 'admin';
    const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    expect(() => verifyToken(tampered, secret, 1_000_001)).toThrow();
  });

  test('rejects a token whose role/client pair violates the invariant', () => {
    // Signed with a valid secret but inconsistent claims (e.g. an old token after a role change).
    const token = signToken({ ...user, role: 'admin' }, secret, 1_000_000); // admin with client_id 1
    expect(() => verifyToken(token, secret, 1_000_001)).toThrow(/client/);
  });

  test('rejects garbage', () => {
    expect(() => verifyToken('not.a.jwt', secret)).toThrow();
  });
});
