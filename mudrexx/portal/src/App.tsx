import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError, api, type PublicUser } from './api';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Admins } from './pages/Admins';
import { Payments } from './pages/Payments';
import { Security } from './pages/Security';

type Page = 'dashboard' | 'admins' | 'payments' | 'security';

const PAGES: { id: Page; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'admins', label: 'Admins' },
  { id: 'payments', label: 'Payments' },
  { id: 'security', label: 'Security' },
];

export function App() {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [page, setPage] = useState<Page>('dashboard');

  // Resolve the existing session, if any. A 401 here is the normal
  // "not logged in" path and must not surface as an error.
  const loadSession = useCallback(async () => {
    try {
      const me = await api.get<{ user: PublicUser } | PublicUser>('/auth/me');
      const resolved = (me as { user?: PublicUser }).user ?? (me as PublicUser);
      setUser(resolved ?? null);
    } catch (err) {
      if (!(err instanceof ApiRequestError) || err.status !== 401) {
        // Non-auth failures (proxy down, gateway HTML) still leave the user
        // logged out, but the login screen will surface the real reason.
        console.warn('session check failed:', err);
      }
      setUser(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  async function logout() {
    try {
      await api.post('/auth/logout');
    } catch {
      /* the cookie is cleared server-side; a failure here is not actionable */
    }
    setUser(null);
    setPage('dashboard');
  }

  if (checking) {
    return (
      <div className="login-wrap">
        <p className="muted">Checking session…</p>
      </div>
    );
  }

  if (!user) return <Login onSignedIn={setUser} />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          MUDREXX
          <small>Chief Control Portal</small>
        </div>
        <nav className="nav">
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={page === p.id ? 'active' : ''}
              onClick={() => setPage(p.id)}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <div className="foot">
          <div className="who">
            {user.fullName || user.email}
            <br />
            <span className="pill">{user.role}</span>
          </div>
          <button onClick={logout}>Sign out</button>
        </div>
      </aside>
      <main className="main">
        {page === 'dashboard' && <Dashboard />}
        {page === 'admins' && <Admins />}
        {page === 'payments' && <Payments />}
        {page === 'security' && <Security />}
      </main>
    </div>
  );
}
