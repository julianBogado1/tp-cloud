import { describe, expect, test } from 'vitest';
import { assertClientInvariant, scopeOf, unitScopeSql, type AuthContext } from '../../src/auth/scope';

const base = { userId: 1, email: 'x@y' };

describe('scopeOf', () => {
  test('admin sees everything', () => {
    expect(scopeOf({ ...base, role: 'admin', clientId: null })).toEqual({ all: true });
  });

  test('operator and supervisor are limited to their client', () => {
    expect(scopeOf({ ...base, role: 'operator', clientId: 7 })).toEqual({ all: false, clientId: 7 });
    expect(scopeOf({ ...base, role: 'supervisor', clientId: 7 })).toEqual({ all: false, clientId: 7 });
  });

  test('a non-admin with a null client never gets "all"', () => {
    const ctx = { ...base, role: 'operator', clientId: null } as AuthContext;
    expect(() => scopeOf(ctx)).toThrow(/client/);
  });
});

describe('unitScopeSql', () => {
  test('adds nothing for all', () => {
    expect(unitScopeSql({ all: true }, 1)).toEqual({ sql: '', params: [] });
  });

  test('adds a client filter using the next parameter index', () => {
    expect(unitScopeSql({ all: false, clientId: 3 }, 2)).toEqual({ sql: ' AND u.client_id = $2', params: [3] });
  });
});

describe('assertClientInvariant', () => {
  test('admin must have null client, others must have one', () => {
    expect(() => assertClientInvariant('admin', null)).not.toThrow();
    expect(() => assertClientInvariant('admin', 1)).toThrow();
    expect(() => assertClientInvariant('operator', 1)).not.toThrow();
    expect(() => assertClientInvariant('operator', null)).toThrow();
  });
});
