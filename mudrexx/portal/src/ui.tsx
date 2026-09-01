import { useCallback, useEffect, useState } from 'react';
import { ApiRequestError } from './api';

/** Loads data on mount and exposes a manual reload for post-mutation refresh. */
export function useAsync<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [loading, setLoading] = useState(true);

  // The loader identity is intentionally controlled by `deps`, not by the
  // function reference, so inline arrow loaders do not cause a refetch loop.
  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await loader());
    } catch (err) {
      setError(
        err instanceof ApiRequestError ? err : new ApiRequestError('UNKNOWN', String(err), 0),
      );
    } finally {
      setLoading(false);
    }
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void run();
  }, [run]);

  return { data, error, loading, reload: run };
}

export function ErrorBox({ error }: { error: ApiRequestError }) {
  return (
    <div className="alert error">
      <strong>{error.code}</strong> — {error.message}
    </div>
  );
}

export function formatDate(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const date =
    typeof value === 'number'
      ? new Date(value < 1e12 ? value * 1000 : value)
      : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}

const OK_STATES = ['ACTIVE', 'APPROVED', 'VERIFIED', 'PAID', 'COMPLETED', 'SUCCESS'];
const BAD_STATES = ['BLOCKED', 'REJECTED', 'FAILED', 'SUSPENDED', 'CANCELLED', 'EXPIRED'];

export function StatusPill({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="muted">—</span>;
  const text = String(value).toUpperCase();
  const tone = OK_STATES.includes(text) ? 'ok' : BAD_STATES.includes(text) ? 'danger' : 'warn';
  return <span className={`pill ${tone}`}>{text}</span>;
}

/** Renders whichever of the candidate keys the row actually provides. */
export function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return null;
}
