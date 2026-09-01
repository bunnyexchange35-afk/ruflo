import { useState } from 'react';
import { ApiRequestError, api, rowsOf, type PublicUser } from '../api';
import { ErrorBox, StatusPill, formatDate, useAsync } from '../ui';

type Action = 'approve' | 'reject' | 'block' | 'unblock';

/** Admin lifecycle management (§ Chief Control Portal — /api/chief/admins). */
export function Admins() {
  const { data, error, loading, reload } = useAsync<PublicUser[]>(
    async () => rowsOf<PublicUser>(await api.get('/chief/admins')),
    [],
  );
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiRequestError | null>(null);

  async function act(id: string, action: Action) {
    setPending(`${id}:${action}`);
    setActionError(null);
    try {
      await api.post(`/chief/admins/${encodeURIComponent(id)}/${action}`);
      await reload();
    } catch (err) {
      setActionError(
        err instanceof ApiRequestError ? err : new ApiRequestError('UNKNOWN', String(err), 0),
      );
    } finally {
      setPending(null);
    }
  }

  if (loading) return <p className="muted">Loading admins…</p>;
  if (error) return <ErrorBox error={error} />;

  const admins = data ?? [];

  return (
    <>
      <h2>Admins</h2>
      <p className="sub">Approve, reject, block and unblock ADMIN accounts.</p>

      {actionError && <ErrorBox error={actionError} />}

      <section className="panel">
        <header>
          <span>All admins</span>
          <button className="sm" onClick={() => void reload()}>
            Refresh
          </button>
        </header>
        {admins.length ? (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Email</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {admins.map((admin) => {
                const status = String(admin.status ?? '').toUpperCase();
                const busy = (a: Action) => pending === `${admin.id}:${a}`;
                const anyBusy = pending?.startsWith(`${admin.id}:`) ?? false;
                return (
                  <tr key={admin.id}>
                    <td className="mono">{admin.humanId ?? '—'}</td>
                    <td>{admin.fullName ?? '—'}</td>
                    <td className="mono">{admin.email}</td>
                    <td>
                      <StatusPill value={admin.status} />
                    </td>
                    <td className="muted">{formatDate(admin.createdAt)}</td>
                    <td className="actions">
                      {status === 'PENDING' && (
                        <>
                          <button
                            className="sm ok"
                            disabled={anyBusy}
                            onClick={() => void act(admin.id, 'approve')}
                          >
                            {busy('approve') ? '…' : 'Approve'}
                          </button>
                          <button
                            className="sm danger"
                            disabled={anyBusy}
                            onClick={() => void act(admin.id, 'reject')}
                          >
                            {busy('reject') ? '…' : 'Reject'}
                          </button>
                        </>
                      )}
                      {status === 'BLOCKED' ? (
                        <button
                          className="sm"
                          disabled={anyBusy}
                          onClick={() => void act(admin.id, 'unblock')}
                        >
                          {busy('unblock') ? '…' : 'Unblock'}
                        </button>
                      ) : (
                        status !== 'PENDING' && (
                          <button
                            className="sm danger"
                            disabled={anyBusy}
                            onClick={() => void act(admin.id, 'block')}
                          >
                            {busy('block') ? '…' : 'Block'}
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="empty">No admin accounts found.</p>
        )}
      </section>
    </>
  );
}
