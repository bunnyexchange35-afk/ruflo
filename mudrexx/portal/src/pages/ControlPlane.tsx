import { useState, type FormEvent } from 'react';
import { ApiRequestError, api } from '../api';
import { ErrorBox, formatDate, useAsync } from '../ui';

interface Health {
  status: string;
  table: string;
  region: string;
  keySchema: { partitionKey: string; sortKey: string };
  credentials: string;
  latencyMs: number;
}

interface Note {
  sk: string;
  body: string;
  authorEmail: string | null;
  createdAt: string | null;
}

/**
 * Control plane — data stored in DynamoDB (ruflo-cp) rather than in D1.
 *
 * MUDREXX domain data stays behind the Worker; this page is for operator
 * annotations and for confirming the AWS integration is actually wired up.
 */
export function ControlPlane() {
  const health = useAsync<Health>(() => api.get<Health>('/cp/health'), []);
  const [entity, setEntity] = useState('admin:example');
  const [query, setQuery] = useState('admin:example');

  const notes = useAsync<{ notes: Note[] }>(
    () => api.get<{ notes: Note[] }>(`/cp/notes?entity=${encodeURIComponent(query)}`),
    [query],
  );

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<ApiRequestError | null>(null);

  async function addNote(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setWriteError(null);
    try {
      await api.post('/cp/notes', { entity: query, body });
      setDraft('');
      await notes.reload();
    } catch (err) {
      setWriteError(
        err instanceof ApiRequestError ? err : new ApiRequestError('UNKNOWN', String(err), 0),
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteNote(sk: string) {
    setBusy(true);
    setWriteError(null);
    try {
      await api.del(`/cp/notes?entity=${encodeURIComponent(query)}&sk=${encodeURIComponent(sk)}`);
      await notes.reload();
    } catch (err) {
      setWriteError(
        err instanceof ApiRequestError ? err : new ApiRequestError('UNKNOWN', String(err), 0),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2>Control plane</h2>
      <p className="sub">
        Operator notes stored in DynamoDB (<span className="mono">ruflo-cp</span>), separate from
        the MUDREXX database.
      </p>

      <section className="panel">
        <header>
          <span>AWS connection</span>
          <button className="sm" onClick={() => void health.reload()}>
            Re-check
          </button>
        </header>
        <div style={{ padding: '1rem' }}>
          {health.loading ? (
            <span className="muted">Checking…</span>
          ) : health.error ? (
            <ErrorBox error={health.error} />
          ) : health.data ? (
            <div className="cards" style={{ marginBottom: 0 }}>
              <Info label="Status" value={health.data.status} tone="ok" />
              <Info label="Table" value={health.data.table} />
              <Info label="Region" value={health.data.region} />
              <Info
                label="Keys"
                value={`${health.data.keySchema.partitionKey} / ${health.data.keySchema.sortKey}`}
              />
              <Info label="Auth" value={health.data.credentials} />
              <Info label="Latency" value={`${health.data.latencyMs} ms`} />
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel">
        <header>
          <span>Notes</span>
        </header>
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--border)' }}>
          <form
            style={{ display: 'flex', gap: '0.5rem' }}
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(entity.trim());
            }}
          >
            <input
              aria-label="Entity key"
              value={entity}
              onChange={(e) => setEntity(e.target.value)}
              placeholder="admin:usr_123"
            />
            <button type="submit">Load</button>
          </form>
          <p className="muted" style={{ margin: '0.5rem 0 0', fontSize: 12 }}>
            Any stable key works — for example <span className="mono">admin:usr_123</span> or{' '}
            <span className="mono">payment:pay_456</span>.
          </p>
        </div>

        {writeError && (
          <div style={{ padding: '1rem 1rem 0' }}>
            <ErrorBox error={writeError} />
          </div>
        )}

        <form style={{ padding: '1rem', display: 'flex', gap: '0.5rem' }} onSubmit={addNote}>
          <input
            aria-label="New note"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a note…"
            maxLength={2000}
          />
          <button className="primary" disabled={busy || !draft.trim()} type="submit">
            {busy ? '…' : 'Add'}
          </button>
        </form>

        {notes.loading ? (
          <p className="empty">Loading notes…</p>
        ) : notes.error ? (
          <div style={{ padding: '0 1rem 1rem' }}>
            <ErrorBox error={notes.error} />
          </div>
        ) : notes.data?.notes?.length ? (
          <table>
            <thead>
              <tr>
                <th>Note</th>
                <th>Author</th>
                <th>When</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {notes.data.notes.map((note) => (
                <tr key={note.sk}>
                  <td>{note.body}</td>
                  <td className="mono">{note.authorEmail ?? '—'}</td>
                  <td className="muted">{formatDate(note.createdAt)}</td>
                  <td className="actions">
                    <button
                      className="sm danger"
                      disabled={busy}
                      onClick={() => void deleteNote(note.sk)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="empty">No notes for this key yet.</p>
        )}
      </section>
    </>
  );
}

function Info({ label, value, tone }: { label: string; value: string; tone?: 'ok' }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div style={{ marginTop: '0.35rem', fontWeight: 600 }}>
        {tone === 'ok' ? <span className="pill ok">{value}</span> : <span className="mono">{value}</span>}
      </div>
    </div>
  );
}
