/**
 * Browser-side session. The token is only decoded (never verified) to know
 * when to send the user back to the login page; the API is the authority.
 *
 * The role ladder is duplicated from @snowball/shared on purpose: the
 * dashboard consumes that package as types only (its `dist/` is CommonJS,
 * which Vite does not pre-bundle for linked workspace packages).
 */

export type Role = 'operator' | 'supervisor' | 'admin';

export interface SessionUser {
  id: number;
  email: string;
  role: Role;
  client_id: number | null;
}

export interface Session {
  token: string;
  user: SessionUser;
}

const RANK: Record<Role, number> = { operator: 0, supervisor: 1, admin: 2 };
const STORAGE_KEY = 'snowball.session';

export function hasRole(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}
export const canAck = (role: Role): boolean => hasRole(role, 'supervisor');
export const canConfig = (role: Role): boolean => hasRole(role, 'supervisor');
export const isAdmin = (role: Role): boolean => role === 'admin';

export function decodeExp(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === 'number' ? exp : null;
  } catch {
    return null;
  }
}

export function isExpired(token: string, nowMs: number = Date.now()): boolean {
  const exp = decodeExp(token);
  return exp === null || exp * 1000 <= nowMs;
}

export function getSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as Session;
    if (!session.token || !session.user || isExpired(session.token)) {
      clearSession();
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

export function setSession(session: Session): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // storage unavailable (private mode): the in-memory state in App still works
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
