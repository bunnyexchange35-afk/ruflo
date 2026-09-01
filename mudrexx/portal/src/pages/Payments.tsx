import { useState } from 'react';
import { ApiRequestError, api, rowsOf, type PaymentRow } from '../api';
import { ErrorBox, StatusPill, formatDate, pick, useAsync } from '../ui';

const FILTERS = ['ALL', 'PENDING', 'VERIFIED', 'REJECTED'] as const;

/** Payment verification queue (/api/chief/payments). */
export function Payments() {
  const [status, setStatus] = useState<(typeof FILTERS)[number]>('ALL');
  const { data, error, loading, reload } = useAsync<PaymentRow[]>(
    async () => rowsOf<PaymentRow>(await api.get(`/chief/payments?status=${status}`)),
    [status],
  );
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<ApiRequestError | null>(null);

  async function act(id: string, action: 'verify' | 'reject') {
    setPending(`${id}:${action}`);
    setActionError(null);
    try {
      await api.post(`/chief/payments/${encodeURIComponent(id)}/${action}`);
      await reload();
    } catch (err) {
      setActionError(
        err instanceof ApiRequestError ? err : new ApiRequestError('UNKNOWN', String(err), 0),
      );
    } finally {
      setPending(null);
    }
  }

  const payments = data ?? [];

  return (
    <>
      <h2>Payments</h2>
      <p className="sub">Verify or reject submitted payments.</p>

      {actionError && <ErrorBox error={actionError} />}
      {error && <ErrorBox error={error} />}

      <section className="panel">
        <header>
          <span>Payment queue</span>
          <span style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
            <select
              style={{ width: 'auto' }}
              value={status}
              onChange={(e) => setStatus(e.target.value as (typeof FILTERS)[number])}
            >
              {FILTERS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <button className="sm" onClick={() => void reload()}>
              Refresh
            </button>
          </span>
        </header>

        {loading ? (
          <p className="empty">Loading payments…</p>
        ) : payments.length ? (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>User</th>
                <th className="right">Amount</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((row, i) => {
                const id = String(row.id ?? i);
                const rowStatus = String(pick(row, ['status']) ?? '').toUpperCase();
                const anyBusy = pending?.startsWith(`${id}:`) ?? false;
                const amount = pick(row, ['amount', 'amount_cents', 'total']);
                const currency = pick(row, ['currency']) ?? '';
                return (
                  <tr key={id}>
                    <td className="mono">{id.slice(0, 10)}</td>
                    <td className="mono">{String(pick(row, ['user_id', 'userId']) ?? '—')}</td>
                    <td className="right mono">
                      {amount === null ? '—' : `${amount} ${currency}`.trim()}
                    </td>
                    <td>
                      <StatusPill value={rowStatus} />
                    </td>
                    <td className="muted">{formatDate(pick(row, ['created_at', 'createdAt']))}</td>
                    <td className="actions">
                      {rowStatus === 'PENDING' || rowStatus === '' ? (
                        <>
                          <button
                            className="sm ok"
                            disabled={anyBusy}
                            onClick={() => void act(id, 'verify')}
                          >
                            {pending === `${id}:verify` ? '…' : 'Verify'}
                          </button>
                          <button
                            className="sm danger"
                            disabled={anyBusy}
                            onClick={() => void act(id, 'reject')}
                          >
                            {pending === `${id}:reject` ? '…' : 'Reject'}
                          </button>
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="empty">No payments for this filter.</p>
        )}
      </section>
    </>
  );
}
