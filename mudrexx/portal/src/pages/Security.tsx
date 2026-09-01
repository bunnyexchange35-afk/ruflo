import { useState } from 'react';
import { ApiRequestError, api, rowsOf, type AuditRow, type SessionRow } from '../api';
import { ErrorBox, formatDate, pick, useAsync } from '../ui';

/** Active sessions and the audit trail (/api/chief/security/*). */
export function Security() {
  const sessions = useAsync<SessionRow[]>(
    async () => rowsOf<SessionRow>(await api.get('/chief/security/sessions')),
    [],
  );
  const audit = useAsync<AuditRow[]>(
    async () => rowsOf<AuditRow>(await api.get('/chief/security/audit')),
    [],
  );

  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<ApiRequestError | null>(null);

  async function revoke(id: string) {
    setRevoking(id);
    setRevokeError(null);
    try {
      await api.post(`/chief/security/sessions/${encodeURIComponent(id)}/revoke`);
      await sessions.reload();
    } catch (err) {
      setRevokeError(
        err instanceof ApiRequestError ? err : new ApiRequestError('UNKNOWN', String(err), 0),
      );
    } finally {
      setRevoking(null);
    }
  }

  return (
    <>
      <h2>Security</h2>
      <p className="sub">Active sessions and the audit trail.</p>

      {revokeError && <ErrorBox error={revokeError} />}

      <section className="panel">
        <header>
          <span>Active sessions</span>
          <button className="sm" onClick={() => void sessions.reload()}>
            Refresh
          </button>
        </header>
        {sessions.loading ? (
          <p className="empty">Loading sessions…</p>
        ) : sessions.error ? (
          <div style={{ padding: '1rem' }}>
            <ErrorBox error={sessions.error} />
          </div>
        ) : sessions.data?.length ? (
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>User</th>
                <th>Created</th>
                <th>Expires</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.map((row, i) => {
                const id = String(row.id ?? i);
                return (
                  <tr key={id}>
                    <td className="mono">{id.slice(0, 10)}</td>
                    <td className="mono">{String(pick(row, ['user_id', 'userId']) ?? '—')}</td>
                    <td className="muted">{formatDate(pick(row, ['created_at', 'createdAt']))}</td>
                    <td className="muted">{formatDate(pick(row, ['expires_at', 'expiresAt']))}</td>
                    <td className="actions">
                      <button
                        className="sm danger"
                        disabled={revoking === id}
                        onClick={() => void revoke(id)}
                      >
                        {revoking === id ? '…' : 'Revoke'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="empty">No active sessions.</p>
        )}
      </section>

      <section className="panel">
        <header>
          <span>Audit trail</span>
          <button className="sm" onClick={() => void audit.reload()}>
            Refresh
          </button>
        </header>
        {audit.loading ? (
          <p className="empty">Loading audit trail…</p>
        ) : audit.error ? (
          <div style={{ padding: '1rem' }}>
            <ErrorBox error={audit.error} />
          </div>
        ) : audit.data?.length ? (
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Actor</th>
                <th>Target</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.map((row, i) => (
                <tr key={String(row.id ?? i)}>
                  <td>{String(pick(row, ['action', 'event', 'type']) ?? '—')}</td>
                  <td className="mono">{String(pick(row, ['actor_id', 'user_id']) ?? '—')}</td>
                  <td className="mono">
                    {String(pick(row, ['target_id', 'entity_id', 'resource']) ?? '—')}
                  </td>
                  <td className="muted">{formatDate(pick(row, ['created_at', 'createdAt']))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">No audit entries.</p>
        )}
      </section>
    </>
  );
}
