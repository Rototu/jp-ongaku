import type { ParsedLine } from './lrc';
import { parseLrc, parsePlain } from './lrc';
import type { ProviderId } from './providers';

/**
 * Lyric candidates from any provider: how they are deduplicated, ranked, and
 * turned into timed lines. Nothing here knows which service a record came from.
 */

export interface LyricHit {
  provider: ProviderId;
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

export interface LyricRecord {
  provider: ProviderId;
  /** The provider's own id, unique only within that provider. */
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

export class NotFound extends Error {
  constructor() {
    super('lyrics not found');
  }
}

/** Last timestamp in an LRC body, in ms — null when there are no timings. */
export function lyricSpanMs(record: LyricRecord): number | null {
  if (!record.syncedLyrics) return null;
  const { lines } = parseLrc(record.syncedLyrics);
  let last: number | null = null;
  for (const line of lines) {
    if (line.timeMs !== null && (last === null || line.timeMs > last)) last = line.timeMs;
  }
  return last;
}

/** Where the first timestamp falls — how long the intro runs before line one. */
export function lyricStartMs(record: LyricRecord): number | null {
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
export function sanitizedDurationMs(record: LyricRecord): number | null {
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
function lyricFingerprint(r: LyricRecord): string {
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
function representative(group: LyricRecord[]): LyricRecord {
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
    return a.provider.localeCompare(b.provider) || a.id - b.id;
  })[0];
}

function toHit(r: LyricRecord, duplicates = 0): LyricHit {
  const spanMs = lyricSpanMs(r);
  const startMs = lyricStartMs(r);
  const { lines } = r.syncedLyrics
    ? parseLrc(r.syncedLyrics)
    : { lines: r.plainLyrics ? parsePlain(r.plainLyrics) : [] };
  return {
    provider: r.provider,
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
 * The length a hit describes, in seconds: its timings where it has them.
 *
 * Used to compare a candidate against the recording the user is importing. The
 * timings are preferred over the stated duration for the same reason the rest of
 * this file prefers them — they are what playback is matched against.
 */
function effectiveLengthSec(hit: LyricHit): number | null {
  if (hit.lyricSpanSec !== null) return hit.lyricSpanSec;
  return hit.duration;
}

/**
 * Collapses records that carry the same lyrics and ranks what is left.
 *
 * Lyric databases are crowdsourced, so one song arrives as several entries with identical
 * lyrics and disagreeing metadata — including short "TV size" lengths attached
 * to the full-length lyrics. Offering all of them invites picking the one whose
 * stated length is wrong, so identical lyrics are shown once, represented by the
 * record whose own duration agrees with its timings.
 *
 * `targetDurationSec` is the length of the video the user is importing against,
 * when one is known. It only ever breaks ties below Japanese-script and
 * synced-lyrics, which remain the things that decide whether an entry is usable
 * at all — but among usable entries it is the difference between the full song
 * and a TV-size edit.
 */
export function rankHits(records: LyricRecord[], targetDurationSec?: number | null): LyricHit[] {
  const groups = new Map<string, LyricRecord[]>();
  for (const r of records) {
    if (r.instrumental) continue;
    const key = lyricFingerprint(r);
    if (!key) continue;
    const group = groups.get(key);
    if (group) group.push(r);
    else groups.set(key, [r]);
  }

  const hits: LyricHit[] = [];
  for (const group of groups.values()) hits.push(toHit(representative(group), group.length - 1));

  return hits
    .sort((a, b) => {
      if (a.japanese !== b.japanese) return a.japanese ? -1 : 1;
      if (a.hasSynced !== b.hasSynced) return a.hasSynced ? -1 : 1;
      if (targetDurationSec) {
        const aLen = effectiveLengthSec(a);
        const bLen = effectiveLengthSec(b);
        // A hit with no length at all sorts after ones that can be compared.
        if ((aLen === null) !== (bLen === null)) return aLen === null ? 1 : -1;
        if (aLen !== null && bLen !== null) {
          const gap = Math.abs(aLen - targetDurationSec) - Math.abs(bLen - targetDurationSec);
          // Five seconds of slack: entries within it are the same cut, and their
          // line counts and start times are the more useful tie-break.
          if (Math.abs(gap) > 5) return gap;
        }
      }
      return 0;
    })
    .slice(0, 20);
}

export interface FetchedLyrics {
  provider: ProviderId;
  id: number;
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

export function toFetched(r: LyricRecord): FetchedLyrics {
  const durationMs = sanitizedDurationMs(r);
  const statedMs = r.duration ? Math.round(r.duration * 1000) : null;
  // Only worth reporting when it was actually overruled.
  const statedDurationMs = statedMs !== null && statedMs !== durationMs ? statedMs : null;

  if (r.syncedLyrics) {
    const { lines } = parseLrc(r.syncedLyrics);
    if (lines.length > 0) {
      return {
        provider: r.provider,
        id: r.id,
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
      provider: r.provider,
      id: r.id,
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
