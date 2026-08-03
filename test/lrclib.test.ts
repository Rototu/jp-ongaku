import { describe, expect, test } from 'bun:test';
import { lyricSpanMs, rankHits, sanitizedDurationMs, type LrclibRecord } from '../server/lyrics/lrclib';

/**
 * LRCLIB is crowdsourced, so a song arrives as several entries whose metadata
 * disagrees — most damagingly a short "TV size" length filed against the full
 * lyrics. Fixtures below are invented, in the shape the real API returns.
 */

const SYNCED_FULL = ['[00:10.00]あさ', '[01:30.00]ひかり', '[03:18.00]おわり'].join('\n');
const SYNCED_SHORT = ['[00:10.00]あさ', '[01:20.00]ひかり'].join('\n');
/** The same three lines timed against a cut with no intro: 20s earlier throughout. */
const SYNCED_NO_INTRO = ['[00:30.00]あさ', '[01:50.00]ひかり', '[03:38.00]おわり'].join('\n');
/** Same timings as SYNCED_FULL to within hundredths — a true duplicate. */
const SYNCED_FULL_JITTER = ['[00:10.04]あさ', '[01:29.96]ひかり', '[03:18.02]おわり'].join('\n');

function record(over: Partial<LrclibRecord> = {}): LrclibRecord {
  return {
    id: 1,
    trackName: 'Track',
    artistName: 'Artist',
    albumName: null,
    duration: 204,
    instrumental: false,
    plainLyrics: null,
    syncedLyrics: SYNCED_FULL,
    ...over,
  };
}

describe('lyricSpanMs', () => {
  test('reports the last timestamp', () => {
    expect(lyricSpanMs(record())).toBe(198_000);
  });

  test('is null without synced lyrics', () => {
    expect(lyricSpanMs(record({ syncedLyrics: null, plainLyrics: 'あさ' }))).toBeNull();
  });
});

describe('sanitizedDurationMs', () => {
  test('keeps a stated length that agrees with the timings', () => {
    expect(sanitizedDurationMs(record({ duration: 204 }))).toBe(204_000);
  });

  test('overrules a length shorter than the lyrics themselves', () => {
    // The reported bug: a 1:30 entry carrying the full 3:18 of lyrics.
    expect(sanitizedDurationMs(record({ duration: 90 }))).toBe(206_000);
  });

  test('tolerates a final line ringing out past the last timestamp', () => {
    expect(sanitizedDurationMs(record({ duration: 196 }))).toBe(196_000);
  });

  test('falls back to the timings when no length is given', () => {
    expect(sanitizedDurationMs(record({ duration: null }))).toBe(206_000);
  });

  test('keeps the stated length for unsynced lyrics', () => {
    expect(
      sanitizedDurationMs(record({ duration: 90, syncedLyrics: null, plainLyrics: 'あさ' })),
    ).toBe(90_000);
  });
});

describe('rankHits', () => {
  test('shows identical lyrics once, keeping the entry with sane metadata', () => {
    const hits = rankHits([
      record({ id: 31624313, duration: 90 }),
      record({ id: 27460363, duration: 204 }),
      record({ id: 33995867, duration: 204 }),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(27460363);
    expect(hits[0].duplicates).toBe(2);
    expect(hits[0].durationMismatch).toBe(false);
  });

  test('keeps a genuinely shorter cut as its own result', () => {
    const hits = rankHits([
      record({ id: 1, duration: 204 }),
      record({ id: 2, duration: 90, syncedLyrics: SYNCED_SHORT }),
    ]);
    expect(hits.map((h) => h.id).sort()).toEqual([1, 2]);
    expect(hits.find((h) => h.id === 2)?.lyricSpanSec).toBe(80);
  });

  test('flags a lone entry whose length disagrees with its timings', () => {
    const hits = rankHits([record({ duration: 90 })]);
    expect(hits[0].durationMismatch).toBe(true);
    expect(hits[0].lyricSpanSec).toBe(198);
    expect(hits[0].lineCount).toBe(3);
  });

  test('the same words timed against a different cut stay a separate choice', () => {
    // The reported case: eleven entries, two timing sets ~20s apart. Collapsing
    // them left one option, and it was the one that fought the video.
    const hits = rankHits([
      record({ id: 1, duration: 262, syncedLyrics: SYNCED_FULL }),
      record({ id: 2, duration: 231, syncedLyrics: SYNCED_FULL }),
      record({ id: 3, duration: 262, syncedLyrics: SYNCED_NO_INTRO }),
    ]);
    expect(hits).toHaveLength(2);
    const starts = hits.map((h) => h.lyricStartSec).sort((a, b) => (a ?? 0) - (b ?? 0));
    expect(starts).toEqual([10, 30]);
  });

  test('entries differing only by hundredths of a second are one choice', () => {
    const hits = rankHits([
      record({ id: 1, duration: 262, syncedLyrics: SYNCED_FULL }),
      record({ id: 2, duration: 262, syncedLyrics: SYNCED_FULL_JITTER }),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].duplicates).toBe(1);
  });

  test('the kept entry takes the length its siblings agree on, not the lowest id', () => {
    // Exactly the shape that made a 4:21 track import as 3:51: the odd length
    // happened to sit on the oldest id, with six absurd ones alongside it.
    const hits = rankHits([
      record({ id: 100, duration: 231, syncedLyrics: SYNCED_FULL }),
      record({ id: 200, duration: 262, syncedLyrics: SYNCED_FULL }),
      record({ id: 300, duration: 262, syncedLyrics: SYNCED_FULL }),
      record({ id: 400, duration: 893, syncedLyrics: SYNCED_FULL }),
      record({ id: 500, duration: 1033, syncedLyrics: SYNCED_FULL }),
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].duration).toBe(262);
  });

  test('a length far longer than the lyrics is treated as wrong, not as an outro', () => {
    const hits = rankHits([record({ duration: 900, syncedLyrics: SYNCED_FULL })]);
    expect(hits[0].durationMismatch).toBe(true);
    // Stored length comes from the timings instead of the album-sized number.
    expect(sanitizedDurationMs(record({ duration: 900, syncedLyrics: SYNCED_FULL }))).toBe(206_000);
  });

  test('reports where the first line lands, for choosing against a video', () => {
    expect(rankHits([record({ syncedLyrics: SYNCED_FULL })])[0].lyricStartSec).toBe(10);
    expect(rankHits([record({ syncedLyrics: SYNCED_NO_INTRO })])[0].lyricStartSec).toBe(30);
    expect(
      rankHits([record({ syncedLyrics: null, plainLyrics: 'あさ' })])[0].lyricStartSec,
    ).toBeNull();
  });

  test('drops instrumentals and empty records', () => {
    const hits = rankHits([
      record({ id: 1, instrumental: true }),
      record({ id: 2, syncedLyrics: null, plainLyrics: null }),
      record({ id: 3 }),
    ]);
    expect(hits.map((h) => h.id)).toEqual([3]);
  });

  test('ranks Japanese lyrics with timings first', () => {
    const hits = rankHits([
      record({ id: 1, syncedLyrics: null, plainLyrics: 'romaji only here' }),
      record({ id: 2, syncedLyrics: null, plainLyrics: 'あさ ひかり' }),
      record({ id: 3 }),
    ]);
    expect(hits.map((h) => h.id)).toEqual([3, 2, 1]);
  });
});
