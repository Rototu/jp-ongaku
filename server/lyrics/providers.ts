import { lrclib } from './lrclib';
import { rankHits, toFetched, type FetchedLyrics, type LyricHit, type LyricRecord } from './rank';

export type ProviderId = 'lrclib';

/**
 * One lyric database.
 *
 * `search` returns records with their lyric bodies already present: ranking,
 * deduplication and the Japanese check all read the words, so a provider whose
 * search API returns metadata only fetches the bodies itself.
 */
export interface LyricProvider {
  id: ProviderId;
  /** The name shown to the user beside a hit and in import notices. */
  label: string;
  search(query: string, artist?: string): Promise<LyricRecord[]>;
  /** Throws NotFound when the provider no longer has that id. */
  get(id: number): Promise<LyricRecord>;
}

const PROVIDERS: Record<ProviderId, LyricProvider> = { lrclib };

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && Object.hasOwn(PROVIDERS, value);
}

export function providerLabel(id: ProviderId): string {
  return PROVIDERS[id].label;
}

/**
 * Searches every provider at once and ranks the merged results.
 *
 * One provider being down or overloaded should not hide what the others found,
 * so this fails only when every provider failed.
 */
export async function search(
  query: string,
  artist?: string,
  targetDurationSec?: number | null,
): Promise<LyricHit[]> {
  const results = await Promise.allSettled(
    Object.values(PROVIDERS).map((p) => p.search(query, artist)),
  );
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length === results.length) throw failed[0].reason;
  const records = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  return rankHits(records, targetDurationSec);
}

export async function fetchLyrics(provider: ProviderId, id: number): Promise<FetchedLyrics> {
  return toFetched(await PROVIDERS[provider].get(id));
}
