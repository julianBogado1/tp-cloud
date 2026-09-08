import { describe, expect, test } from 'vitest';
import { canAck, canConfig, decodeExp, hasRole, isAdmin, isExpired } from '../src/auth';

function fakeJwt(payload: object): string {
  const b64 = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

describe('token expiry', () => {
  test('decodeExp reads exp from the payload and null on garbage', () => {
    expect(decodeExp(fakeJwt({ exp: 1000 }))).toBe(1000);
    expect(decodeExp('garbage')).toBeNull();
    expect(decodeExp(fakeJwt({}))).toBeNull();
  });

  test('isExpired compares exp against now (ms)', () => {
    const token = fakeJwt({ exp: 1_000 });
    expect(isExpired(token, 999_000)).toBe(false);
    expect(isExpired(token, 1_000_000)).toBe(true);
    expect(isExpired('garbage', 0)).toBe(true);
  });
});

describe('role predicates', () => {
  test('ladder', () => {
    expect(hasRole('operator', 'supervisor')).toBe(false);
    expect(hasRole('admin', 'supervisor')).toBe(true);
    expect(canAck('operator')).toBe(false);
    expect(canAck('supervisor')).toBe(true);
    expect(canConfig('admin')).toBe(true);
    expect(isAdmin('supervisor')).toBe(false);
    expect(isAdmin('admin')).toBe(true);
  });
});
