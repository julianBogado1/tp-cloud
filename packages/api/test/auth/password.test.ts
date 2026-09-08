import { describe, expect, test } from 'vitest';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../../src/auth/password';

describe('password hashing', () => {
  test('hash verifies with the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).toMatch(/^\$2[aby]\$10\$/);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
  });

  test('two hashes of the same password differ (salted)', async () => {
    expect(await hashPassword('x')).not.toBe(await hashPassword('x'));
  });

  test('DUMMY_HASH is a valid bcrypt hash that never verifies real input', async () => {
    expect(DUMMY_HASH).toMatch(/^\$2[aby]\$10\$/);
    expect(await verifyPassword('anything', DUMMY_HASH)).toBe(false);
  });
});
