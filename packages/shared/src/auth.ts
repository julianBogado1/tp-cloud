/**
 * Role vocabulary shared by the API (authorizer) and the
 * dashboard (types only — the dashboard keeps its own runtime copy, see
 * packages/dashboard/src/auth.ts).
 */

export type Role = 'operator' | 'supervisor' | 'admin';

export const ROLES: readonly Role[] = ['operator', 'supervisor', 'admin'];

export const ROLE_RANK: Record<Role, number> = { operator: 0, supervisor: 1, admin: 2 };

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** `min` and every role above it pass. */
export function hasRole(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
