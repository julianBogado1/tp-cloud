import { useEffect, useState, type FormEvent } from 'react';
import { createUser, fetchUsers, updateUser, type UserRow } from './api';
import type { Role } from './auth';

const ROLES: Role[] = ['operator', 'supervisor', 'admin'];

export function UsersPanel({ selfId }: { selfId: number }) {
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', password: '', role: 'operator' as Role, client_id: '1' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchUsers().then(
      (u) => { if (!cancelled) setUsers(u); },
      (err: Error) => { if (!cancelled) setError(err.message); },
    );
    return () => { cancelled = true; };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createUser({
        email: form.email,
        password: form.password,
        role: form.role,
        client_id: form.role === 'admin' ? null : Number(form.client_id),
      });
      setUsers((prev) => [...(prev ?? []), created]);
      setForm({ email: '', password: '', role: 'operator', client_id: '1' });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: number, changes: { active?: boolean; role?: Role; client_id?: number | null }) {
    setError(null);
    try {
      const updated = await updateUser(id, changes);
      setUsers((prev) => prev?.map((u) => (u.id === id ? updated : u)) ?? prev);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (error && !users) return <p className="empty">{error}</p>;
  if (!users) return <p className="empty">Cargando…</p>;

  return (
    <section>
      <h2>Usuarios</h2>
      {error && <p className="error">{error}</p>}
      <table className="alerts">
        <thead>
          <tr><th>Email</th><th>Rol</th><th>Cliente</th><th>Activo</th><th></th></tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id} className={u.active ? '' : 'acked'}>
              <td>{u.email}{u.id === selfId && ' (vos)'}</td>
              <td>{u.role}</td>
              <td>{u.client_id ?? '—'}</td>
              <td>{u.active ? 'sí' : 'no'}</td>
              <td>
                {u.id !== selfId && (
                  <button className="link" onClick={() => patch(u.id, { active: !u.active })}>
                    {u.active ? 'Desactivar' : 'Activar'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form className="form" onSubmit={submit}>
        <h3>Nuevo usuario</h3>
        <label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
        <label>Contraseña<input type="password" minLength={8} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>
        <label>
          Rol
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        {form.role !== 'admin' && (
          <label>Cliente (id)<input type="number" min={1} value={form.client_id} onChange={(e) => setForm({ ...form, client_id: e.target.value })} required /></label>
        )}
        <button className="primary" type="submit" disabled={busy}>{busy ? 'Creando…' : 'Crear'}</button>
      </form>
    </section>
  );
}
