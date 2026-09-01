import { useState, type FormEvent } from 'react';
import { ApiRequestError, api, type PublicUser } from '../api';

/**
 * SUPER_ADMIN sign-in.
 *
 * This posts to /api/auth/super-admin/login, which only accepts SUPER_ADMIN.
 * The portal declares the role it serves; the database decides. An ADMIN
 * authenticating here is rejected by the backend, not by this form.
 */
export function Login({ onSignedIn }: { onSignedIn: (user: PublicUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ user: PublicUser }>('/auth/super-admin/login', {
        email: email.trim(),
        password,
      });
      onSignedIn(result.user);
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? err
          : new ApiRequestError('UNKNOWN', 'Sign-in failed.', 0),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>MUDREXX</h1>
        <p className="sub">Chief Control Portal — SUPER_ADMIN only</p>

        {error && (
          <div className="alert error">
            <strong>{error.code}</strong> — {error.message}
            {error.code === 'BAD_GATEWAY' || error.code === 'NETWORK' ? (
              <>
                <br />
                <br />
                Set <code>MUDREXX_API_ORIGIN</code> in the Vercel project to your Worker URL
                and redeploy.
              </>
            ) : null}
          </div>
        )}

        <div className="field">
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>

        <button className="primary" style={{ width: '100%' }} disabled={busy} type="submit">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
