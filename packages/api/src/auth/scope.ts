import type { Role } from '@snowball/shared';

/**
 * Who is calling and what they may see. The tenant scope is derived from the
 * ROLE, never from a null client_id: a misconfigured operator row with no
 * client must not become a global reader.
 */

export interface AuthContext {
  userId: number;
  email: string;
  role: Role;
  /** null only for admin */
  clientId: number | null;
}

export type Scope = { all: true } | { all: false; clientId: number };

export function assertClientInvariant(role: Role, clientId: number | null): void {
  if (role === 'admin' && clientId !== null) throw new Error('admin must not have a client_id');
  if (role !== 'admin' && clientId === null) throw new Error(`${role} must have a client_id`);
}

export function scopeOf(ctx: AuthContext): Scope {
  assertClientInvariant(ctx.role, ctx.clientId);
  if (ctx.role === 'admin') return { all: true };
  return { all: false, clientId: ctx.clientId as number };
}

/**
 * Fragment appended to a WHERE clause on `units u`. `nextParam` is the index
 * the caller will use for the next positional parameter ($1-based).
 */
export function unitScopeSql(scope: Scope, nextParam: number): { sql: string; params: number[] } {
  if (scope.all) return { sql: '', params: [] };
  return { sql: ` AND u.client_id = $${nextParam}`, params: [scope.clientId] };
}
