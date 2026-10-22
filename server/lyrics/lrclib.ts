import type { LyricProvider } from './providers';
import { NotFound, type LyricRecord } from './rank';

/**
 * LRCLIB client (https://lrclib.net).
 *
 * LRCLIB is an open, crowdsourced lyrics database with a public API intended
 * for third-party apps — no key, no scraping of licensed lyric sites. Many
 * entries include time-synced lyrics, which gives karaoke playback for free.
 */

const BASE = 'https://lrclib.net/api';
const UA = 'jp-ongaku/0.1 (local Japanese study app)';
const TIMEOUT_MS = 15_000;

/**
 * LRCLIB answers 503 "ServerOverloaded" when an uncached search runs past about
 * a second, which is common for Japanese queries it has not seen before. The
 * query keeps running and is cached, so the same request a moment later usually
 * succeeds in well under that.
 */
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [700, 1500, 3000];

async function get<T>(path: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${BASE}${path}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) throw new NotFound();
    if (RETRY_STATUSES.has(res.status) && attempt < RETRY_DELAYS_MS.length) {
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      continue;
    }
    if (!res.ok) throw new Error(`LRCLIB responded ${res.status}`);
    return (await res.json()) as T;
  }
}

type ApiRecord = Omit<LyricRecord, 'provider'>;

const tag = (r: ApiRecord): LyricRecord => ({ ...r, provider: 'lrclib' });

async function search(query: string, artist?: string): Promise<LyricRecord[]> {
  const params = new URLSearchParams();
  if (artist) {
    params.set('track_name', query);
    params.set('artist_name', artist);
  } else {
    params.set('q', query);
  }

  let records: ApiRecord[];
  try {
    records = await get<ApiRecord[]>(`/search?${params.toString()}`);
  } catch (err) {
    if (err instanceof NotFound) return [];
    throw err;
  }

  // An artist-scoped search that finds nothing is common: LRCLIB matches the
  // artist field literally, and a channel name is not always what the uploader
  // filed the song under. Fall back to the title alone rather than dead-ending.
  if (records.length === 0 && artist) {
    try {
      records = await get<ApiRecord[]>(`/search?q=${encodeURIComponent(query)}`);
    } catch (err) {
      if (!(err instanceof NotFound)) throw err;
    }
  }

  return records.map(tag);
}

export const lrclib: LyricProvider = {
  id: 'lrclib',
  label: 'LRCLIB',
  search,
  get: async (id) => tag(await get<ApiRecord>(`/get/${id}`)),
};
