import { Router } from 'express';
import { isRole, type Role } from '@snowball/shared';
import { getAuth, requireRole } from './auth/middleware';
import { hashPassword } from './auth/password';
import { assertClientInvariant } from './auth/scope';
import { DuplicateEmailError, type DataAccess, type UserPatch } from './data-access';

/** Admin-only user management. index.ts mounts authenticate() on /api before this router. */

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const MIN_PASSWORD = 8;

function parseClientId(value: unknown): number | null | string {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  return 'client_id must be a positive integer or null';
}

export function createUsersRouter(data: DataAccess): Router {
  const router = Router();
  router.use('/users', requireRole('admin'));

  router.get('/users', async (_req, res) => {
    try {
      res.json(await data.listUsers());
    } catch (err) {
      console.error('GET /users failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.post('/users', async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) { res.status(400).json({ error: 'invalid email' }); return; }
    if (typeof body.password !== 'string' || body.password.length < MIN_PASSWORD) {
      res.status(400).json({ error: `password must have at least ${MIN_PASSWORD} characters` });
      return;
    }
    if (!isRole(body.role)) { res.status(400).json({ error: 'role must be operator, supervisor or admin' }); return; }
    const clientId = parseClientId(body.client_id);
    if (typeof clientId === 'string') { res.status(400).json({ error: clientId }); return; }
    try {
      assertClientInvariant(body.role, clientId);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      if (clientId !== null && !(await data.clientExists(clientId))) {
        res.status(400).json({ error: 'unknown client_id' });
        return;
      }
      const row = await data.createUser({
        email,
        password_hash: await hashPassword(body.password),
        role: body.role,
        client_id: clientId,
      });
      res.status(201).json(row);
    } catch (err) {
      if (err instanceof DuplicateEmailError) { res.status(409).json({ error: 'email already registered' }); return; }
      console.error('POST /users failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.patch('/users/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) { res.status(400).json({ error: 'user id must be a positive integer' }); return; }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const patch: UserPatch = {};
    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') { res.status(400).json({ error: 'active must be boolean' }); return; }
      patch.active = body.active;
    }
    if (body.role !== undefined) {
      if (!isRole(body.role)) { res.status(400).json({ error: 'role must be operator, supervisor or admin' }); return; }
      patch.role = body.role;
    }
    if (body.client_id !== undefined) {
      const clientId = parseClientId(body.client_id);
      if (typeof clientId === 'string') { res.status(400).json({ error: clientId }); return; }
      patch.client_id = clientId;
    }
    if (Object.keys(patch).length === 0) { res.status(400).json({ error: 'nothing to update' }); return; }

    const self = getAuth(res).userId;
    if (id === self && (patch.active === false || (patch.role !== undefined && patch.role !== 'admin'))) {
      res.status(400).json({ error: 'you cannot deactivate or demote yourself' });
      return;
    }
    try {
      const current = await data.findUserById(id);
      if (!current) { res.status(404).json({ error: 'not found' }); return; }
      const role: Role = patch.role ?? current.role;
      const clientId = patch.client_id !== undefined ? patch.client_id : current.client_id;
      try {
        assertClientInvariant(role, clientId);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
      if (clientId !== null && patch.client_id !== undefined && !(await data.clientExists(clientId))) {
        res.status(400).json({ error: 'unknown client_id' });
        return;
      }
      const row = await data.updateUser(id, patch);
      if (!row) { res.status(404).json({ error: 'not found' }); return; }
      res.json(row);
    } catch (err) {
      console.error(`PATCH /users/${id} failed:`, err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  return router;
}
