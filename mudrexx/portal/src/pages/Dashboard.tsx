import { api, type AuditRow, type Dashboard as DashboardData } from '../api';
import { ErrorBox, StatusPill, formatDate, pick, useAsync } from '../ui';

export function Dashboard() {
  const { data, error, loading } = useAsync<DashboardData>(
    () => api.get<DashboardData>('/chief/dashboard'),
    [],
  );

  if (loading) return <p className="muted">Loading dashboard…</p>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;

  const counts = data.counts ?? { users: 0, admins: 0, activeSessions: 0, payments: 0 };

  return (
    <>
      <h2>Dashboard</h2>
      <p className="sub">Live totals from the MUDREXX backend.</p>

      <div className="cards">
        <Stat label="Users" value={counts.users} />
        <Stat label="Admins" value={counts.admins} />
        <Stat label="Active sessions" value={counts.activeSessions} />
        <Stat label="Payments" value={counts.payments} />
      </div>

      <section className="panel">
        <header>Recent admins</header>
        {data.recentAdmins?.length ? (
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Email</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.recentAdmins.map((admin) => (
                <tr key={admin.id}>
                  <td className="mono">{admin.humanId ?? '—'}</td>
                  <td>{admin.fullName ?? '—'}</td>
                  <td className="mono">{admin.email}</td>
                  <td>
                    <StatusPill value={admin.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">No admins yet.</p>
        )}
      </section>

      <section className="panel">
        <header>Recent activity</header>
        {data.recentAudit?.length ? (
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Actor</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {data.recentAudit.map((row: AuditRow, i) => (
                <tr key={row.id ?? i}>
                  <td>{String(pick(row, ['action', 'event', 'type']) ?? '—')}</td>
                  <td className="mono">{String(pick(row, ['actor_id', 'user_id']) ?? '—')}</td>
                  <td className="muted">{formatDate(pick(row, ['created_at', 'createdAt']))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">No audit entries yet.</p>
        )}
      </section>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{value ?? 0}</div>
    </div>
  );
}
