import { describe, expect, test } from 'vitest';
import { hasRole, isRole, ROLES, ROLE_RANK } from '../src/auth';

describe('roles', () => {
  test('ladder is operator < supervisor < admin', () => {
    expect(ROLE_RANK.operator).toBeLessThan(ROLE_RANK.supervisor);
    expect(ROLE_RANK.supervisor).toBeLessThan(ROLE_RANK.admin);
    expect(ROLES).toEqual(['operator', 'supervisor', 'admin']);
  });

  test('hasRole allows the minimum and anything above', () => {
    expect(hasRole('operator', 'operator')).toBe(true);
    expect(hasRole('operator', 'supervisor')).toBe(false);
    expect(hasRole('supervisor', 'supervisor')).toBe(true);
    expect(hasRole('admin', 'supervisor')).toBe(true);
    expect(hasRole('admin', 'admin')).toBe(true);
    expect(hasRole('supervisor', 'admin')).toBe(false);
  });

  test('isRole narrows only the three known roles', () => {
    expect(isRole('admin')).toBe(true);
    expect(isRole('root')).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});
