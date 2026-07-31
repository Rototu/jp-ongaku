import type { ParsedLine } from './lrc';
import { parseLrc, parsePlain } from './lrc';

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

export interface LrclibHit {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  instrumental: boolean;
  hasSynced: boolean;
  /** True when the lyrics contain Japanese script. */
  japanese: boolean;
}

interface LrclibRecord {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

const JAPANESE_RE = /[぀-ゟ゠-ヿ一-鿿]/;

export function hasJapanese(text: string | null | undefined): boolean {
  return !!text && JAPANESE_RE.test(text);
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) throw new NotFound();
  if (!res.ok) throw new Error(`LRCLIB responded ${res.status}`);
  return (await res.json()) as T;
}

export class NotFound extends Error {
  constructor() {
    super('not found on LRCLIB');
  }
}

function toHit(r: LrclibRecord): LrclibHit {
  return {
    id: r.id,
    trackName: r.trackName,
    artistName: r.artistName,
    albumName: r.albumName,
    duration: r.duration,
    instrumental: r.instrumental,
    hasSynced: !!r.syncedLyrics,
    japanese: hasJapanese(r.syncedLyrics) || hasJapanese(r.plainLyrics),
  };
}

/**
 * Searches LRCLIB, ranking Japanese-script results with synced lyrics first —
 * an English romaji transcription of an anime OP is useless for studying kanji.
 */
export async function search(query: string, artist?: string): Promise<LrclibHit[]> {
  const params = new URLSearchParams();
  if (artist) {
    params.set('track_name', query);
    params.set('artist_name', artist);
  } else {
    params.set('q', query);
  }

  let records: LrclibRecord[];
  try {
    records = await get<LrclibRecord[]>(`/search?${params.toString()}`);
  } catch (err) {
    if (err instanceof NotFound) return [];
    throw err;
  }

  const hits = records.filter((r) => !r.instrumental).map(toHit);
  return hits
    .sort((a, b) => {
      if (a.japanese !== b.japanese) return a.japanese ? -1 : 1;
      if (a.hasSynced !== b.hasSynced) return a.hasSynced ? -1 : 1;
      return 0;
    })
    .slice(0, 20);
}

export interface FetchedLyrics {
  lrclibId: number;
  title: string;
  artist: string;
  album: string | null;
  durationMs: number | null;
  synced: boolean;
  lines: ParsedLine[];
  /** Original source text, kept so verse grouping can use its blank lines. */
  raw: string;
}

/** Fetches one LRCLIB record by id and parses it into timed lines. */
export async function fetchById(id: number): Promise<FetchedLyrics> {
  const r = await get<LrclibRecord>(`/get/${id}`);
  return toFetched(r);
}

/** Exact-match lookup, which LRCLIB serves faster than search. */
export async function fetchExact(
  track: string,
  artist: string,
  album?: string,
  durationSec?: number,
): Promise<FetchedLyrics> {
  const params = new URLSearchParams({ track_name: track, artist_name: artist });
  if (album) params.set('album_name', album);
  if (durationSec) params.set('duration', String(Math.round(durationSec)));
  const r = await get<LrclibRecord>(`/get?${params.toString()}`);
  return toFetched(r);
}

function toFetched(r: LrclibRecord): FetchedLyrics {
  if (r.syncedLyrics) {
    const { lines } = parseLrc(r.syncedLyrics);
    if (lines.length > 0) {
      return {
        lrclibId: r.id,
        title: r.trackName,
        artist: r.artistName,
        album: r.albumName,
        durationMs: r.duration ? Math.round(r.duration * 1000) : null,
        synced: lines.some((l) => l.timeMs !== null),
        lines,
        raw: r.syncedLyrics,
      };
    }
  }
  if (r.plainLyrics) {
    return {
      lrclibId: r.id,
      title: r.trackName,
      artist: r.artistName,
      album: r.albumName,
      durationMs: r.duration ? Math.round(r.duration * 1000) : null,
      synced: false,
      lines: parsePlain(r.plainLyrics),
      raw: r.plainLyrics,
    };
  }
  throw new NotFound();
}
