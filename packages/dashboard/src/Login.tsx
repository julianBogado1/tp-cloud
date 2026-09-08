import { useState, type FormEvent } from 'react';
import { login } from './api';
import type { Session } from './auth';

// Known API error strings (packages/api/src/auth/routes.ts and auth/middleware.ts)
// mapped to Spanish; anything else (including a raw network failure) falls
// back to a generic Spanish message rather than leaking English to the UI.
const ERROR_MESSAGES: Record<string, string> = {
  'invalid credentials': 'Email o contraseña incorrectos',
  'too many attempts, retry later': 'Demasiados intentos, esperá un momento y volvé a intentar',
  'email and password are required': 'Email y contraseña son obligatorios',
  'internal error': 'Error interno del servidor',
};
const GENERIC_ERROR = 'No se pudo iniciar sesión. Intentá de nuevo.';

export function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onLogin(await login(email, password));
    } catch (err) {
      setError(ERROR_MESSAGES[(err as Error).message] ?? GENERIC_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app login">
      <form className="login-card" onSubmit={submit}>
        <h1>Snowball</h1>
        <p className="muted">Monitoreo de cadena de frío</p>
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Contraseña
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Ingresando…' : 'Ingresar'}</button>
      </form>
    </main>
  );
}
