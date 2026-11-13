import { useState, type FormEvent } from 'react';
import { COGNITO, startLogin } from './cognito';

// Error codes that can come back from the login round trip (Hosted UI, the
// auth-callback Lambda, the nonce check in cognito.ts, or /auth/me) mapped to
// Spanish; anything else falls back to a generic message.
const ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'Cancelaste el inicio de sesión.',
  token_exchange_failed: 'Cognito no pudo completar el inicio de sesión. Intentá de nuevo.',
  state_mismatch: 'El inicio de sesión expiró o no se inició desde esta pestaña. Intentá de nuevo.',
  no_access: 'Tu usuario de Cognito no tiene acceso a Snowball o está desactivado. Pedile acceso a un administrador.',
};
const GENERIC_ERROR = 'No se pudo iniciar sesión. Intentá de nuevo.';

export function Login({ error }: { error?: string | null }) {
  const [busy, setBusy] = useState(false);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!COGNITO) return;
    setBusy(true);
    startLogin(COGNITO);
  }

  return (
    <main className="app login">
      <form className="login-card" onSubmit={submit}>
        <h1>Snowball</h1>
        <p className="muted">Monitoreo de cadena de frío</p>
        {error && <p className="error">{ERROR_MESSAGES[error] ?? GENERIC_ERROR}</p>}
        {COGNITO ? (
          <button type="submit" disabled={busy}>{busy ? 'Redirigiendo…' : 'Ingresar con Cognito'}</button>
        ) : (
          <p className="error">
            Falta configurar Cognito en el build (VITE_COGNITO_DOMAIN, VITE_COGNITO_CLIENT_ID, VITE_AUTH_API).
          </p>
        )}
      </form>
    </main>
  );
}
