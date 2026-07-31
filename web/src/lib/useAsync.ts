import { useCallback, useEffect, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  /** True only until the first result arrives. Safe to gate a full-page spinner on. */
  loading: boolean;
  /** True while a background refetch is in flight and stale data is on screen. */
  refreshing: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * Runs an async fetcher on mount and whenever `deps` change.
 *
 * Refetches are stale-while-revalidate: `data` keeps the previous value and
 * `loading` stays false, so a polling caller does not blank the screen every few
 * seconds. Callers that gate rendering on `loading` therefore only ever show a
 * spinner on the very first load, and long-lived children — an embedded video
 * player, say — are never unmounted by a refresh.
 */
export function useAsync<T>(fetcher: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    setRefreshing(true);
    setError(null);
    fetcher()
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Something went wrong');
      })
      .finally(() => {
        if (!cancelled) setRefreshing(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  // A dependency change (a different song id) clears the old result, since
  // showing one song's lines under another's title would be worse than a blank.
  useEffect(() => {
    setLoaded(false);
    setData(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, loading: !loaded, refreshing, error, reload };
}
