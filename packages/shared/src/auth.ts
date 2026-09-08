/**
 * People-auth vocabulary shared by the API (issuer/verifier) and the
 * dashboard (types only — the dashboard never imports runtime code from
 * this package, see packages/dashboard/src/auth.ts).
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

/** What the dashboard receives at login and what /auth/me returns. */
export interface AuthUser {
  id: number;
  email: string;
  role: Role;
  /** null only for admin */
  client_id: number | null;
}

/** JWT payload. `sub` is the user id as a string (JWT convention). */
export interface AuthClaims {
  sub: string;
  email: string;
  role: Role;
  client_id: number | null;
  iat: number;
  exp: number;
}
