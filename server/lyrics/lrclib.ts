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
  lineCount: number;
  /** Where the last timestamp falls — how much song the lyrics actually cover. */
  lyricSpanSec: number | null;
  /**
   * Where the first line lands. The telling number when two entries carry the
   * same words: one timed for the single, one for an edit without its intro.
   */
  lyricStartSec: number | null;
  /**
   * True when the record's own `duration` disagrees with its timings, which on a
   * crowdsourced database happens often enough to mislead: an entry labelled
   * 1:30 whose lyrics run to 3:18 is the full song with a wrong length.
   */
  durationMismatch: boolean;
  /** How many other records carried the same lyrics and were folded into this. */
  duplicates: number;
}

export interface LrclibRecord {
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

/** Last timestamp in an LRC body, in ms — null when there are no timings. */
export function lyricSpanMs(record: LrclibRecord): number | null {
  if (!record.syncedLyrics) return null;
  const { lines } = parseLrc(record.syncedLyrics);
  let last: number | null = null;
  for (const line of lines) {
    if (line.timeMs !== null && (last === null || line.timeMs > last)) last = line.timeMs;
  }
  return last;
}

/** Where the first timestamp falls — how long the intro runs before line one. */
export function lyricStartMs(record: LrclibRecord): number | null {
  if (!record.syncedLyrics) return null;
  const { lines } = parseLrc(record.syncedLyrics);
  let first: number | null = null;
  for (const line of lines) {
    if (line.timeMs !== null && (first === null || line.timeMs < first)) first = line.timeMs;
  }
  return first;
}

/**
 * A stated length that cannot describe these lyrics, in either direction.
 *
 * Too short is the obvious case — timings running past the end of the track. Too
 * long matters just as much for choosing between entries: uploads carrying a
 * whole album's length against one song's lyrics are common, and treating those
 * durations as candidates drags any average or median towards nonsense.
 */
function mismatched(durationSec: number | null, spanMs: number | null): boolean {
  if (durationSec === null || spanMs === null) return false;
  const statedMs = durationSec * 1000;
  // 10s of grace below: the last line legitimately rings out past the final
  // timestamp. Two minutes above: a generous outro, beyond which the number is
  // describing something other than this song.
  return spanMs > statedMs + 10_000 || statedMs > spanMs + 120_000;
}

/**
 * The length to store for the song.
 *
 * The scrub bar and the timing-based verse grouping both read this, so a
 * duration shorter than the lyrics themselves would leave two thirds of the
 * track unreachable. Where the record's timings outrun its stated duration the
 * timings win, since they are what playback is matched against.
 */
export function sanitizedDurationMs(record: LrclibRecord): number | null {
  const spanMs = lyricSpanMs(record);
  const statedMs = record.duration ? Math.round(record.duration * 1000) : null;
  if (spanMs === null) return statedMs;
  // The tail matches the fallback the player uses when nothing is known at all.
  const fromLyrics = spanMs + 8000;
  if (statedMs === null) return fromLyrics;
  return mismatched(record.duration, spanMs) ? fromLyrics : statedMs;
}

/**
 * What makes two entries the same lesson: the same words *and* the same timings.
 *
 * Timings are identity, not metadata. The same lyrics exist timed against
 * different cuts of a song — the single and an opening-theme edit that drops a
 * 20-second intro — and those are two different lessons: play one against the
 * other's video and every line arrives early. Collapsing them would hide the only
 * choice that matters, so the signature carries the shape of the timing set. It
 * uses line count with the first and last second rather than every timestamp, so
 * entries that differ only by hundredths still count as one.
 */
function lyricFingerprint(r: LrclibRecord): string {
  const body = r.syncedLyrics ?? r.plainLyrics ?? '';
  const text = body
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
  if (!text || !r.syncedLyrics) return text;

  const { lines } = parseLrc(r.syncedLyrics);
  const start = lyricStartMs(r);
  const end = lyricSpanMs(r);
  const sec = (ms: number | null) => (ms === null ? 'x' : Math.round(ms / 1000));
  return `${text}|${lines.length}|${sec(start)}|${sec(end)}`;
}

/**
 * Which entry of a true-duplicate group to show.
 *
 * Sound metadata first, then synced over plain, then the length its siblings agree
 * on — the median of the lengths that could describe these lyrics at all. Picking
 * the oldest id instead, as this used to, means one wrong upload decides the
 * song's length for the whole group: the entry filed as 3:51 for a 4:21 track was
 * simply the lowest id among eleven.
 */
function representative(group: LrclibRecord[]): LrclibRecord {
  const plausible = group
    .map((r) => ({ dur: r.duration, span: lyricSpanMs(r) }))
    .filter((x) => x.dur !== null && !mismatched(x.dur, x.span))
    .map((x) => x.dur as number)
    .sort((a, b) => a - b);
  const median = plausible.length > 0 ? plausible[Math.floor(plausible.length / 2)] : null;

  return [...group].sort((a, b) => {
    const aBad = mismatched(a.duration, lyricSpanMs(a));
    const bBad = mismatched(b.duration, lyricSpanMs(b));
    if (aBad !== bBad) return aBad ? 1 : -1;
    if (!!a.syncedLyrics !== !!b.syncedLyrics) return a.syncedLyrics ? -1 : 1;
    if (median !== null && a.duration !== null && b.duration !== null) {
      const closer = Math.abs(a.duration - median) - Math.abs(b.duration - median);
      // Half a second of slack: iTunes-style fractional lengths differ in the
      // decimals for what is plainly the same release.
      if (Math.abs(closer) > 0.5) return closer;
    }
    return a.id - b.id;
  })[0];
}

function toHit(r: LrclibRecord, duplicates = 0): LrclibHit {
  const spanMs = lyricSpanMs(r);
  const startMs = lyricStartMs(r);
  const { lines } = r.syncedLyrics
    ? parseLrc(r.syncedLyrics)
    : { lines: r.plainLyrics ? parsePlain(r.plainLyrics) : [] };
  return {
    id: r.id,
    trackName: r.trackName,
    artistName: r.artistName,
    albumName: r.albumName,
    duration: r.duration,
    instrumental: r.instrumental,
    hasSynced: !!r.syncedLyrics,
    japanese: hasJapanese(r.syncedLyrics) || hasJapanese(r.plainLyrics),
    lineCount: lines.length,
    lyricSpanSec: spanMs === null ? null : Math.round(spanMs / 1000),
    lyricStartSec: startMs === null ? null : Math.round(startMs / 1000),
    durationMismatch: mismatched(r.duration, spanMs),
    duplicates,
  };
}

/**
 * Collapses records that carry the same lyrics and ranks what is left.
 *
 * LRCLIB is crowdsourced, so one song arrives as several entries with identical
 * lyrics and disagreeing metadata — including short "TV size" lengths attached
 * to the full-length lyrics. Offering all of them invites picking the one whose
 * stated length is wrong, so identical lyrics are shown once, represented by the
 * record whose own duration agrees with its timings.
 */
export function rankHits(records: LrclibRecord[]): LrclibHit[] {
  const groups = new Map<string, LrclibRecord[]>();
  for (const r of records) {
    if (r.instrumental) continue;
    const key = lyricFingerprint(r);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }

  const hits: LrclibHit[] = [];
  for (const group of groups.values()) hits.push(toHit(representative(group), group.length - 1));

  return hits
    .sort((a, b) => {
      if (a.japanese !== b.japanese) return a.japanese ? -1 : 1;
      if (a.hasSynced !== b.hasSynced) return a.hasSynced ? -1 : 1;
      return 0;
    })
    .slice(0, 20);
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

  return rankHits(records);
}

export interface FetchedLyrics {
  lrclibId: number;
  title: string;
  artist: string;
  album: string | null;
  /** Corrected where the record's timings outrun its stated length. */
  durationMs: number | null;
  /** The length the record claimed, when that disagreed with its timings. */
  statedDurationMs: number | null;
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
  const durationMs = sanitizedDurationMs(r);
  const statedMs = r.duration ? Math.round(r.duration * 1000) : null;
  // Only worth reporting when it was actually overruled.
  const statedDurationMs = statedMs !== null && statedMs !== durationMs ? statedMs : null;

  if (r.syncedLyrics) {
    const { lines } = parseLrc(r.syncedLyrics);
    if (lines.length > 0) {
      return {
        lrclibId: r.id,
        title: r.trackName,
        artist: r.artistName,
        album: r.albumName,
        durationMs,
        statedDurationMs,
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
      durationMs,
      statedDurationMs,
      synced: false,
      lines: parsePlain(r.plainLyrics),
      raw: r.plainLyrics,
    };
  }
  throw new NotFound();
}
