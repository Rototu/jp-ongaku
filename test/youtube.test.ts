import { describe, expect, test } from 'bun:test';
import {
  looksLikeYoutube,
  searchCandidates,
  splitTitle,
  videoIdFrom,
} from '../server/lyrics/youtube';
import { rankHits, type LrclibRecord } from '../server/lyrics/lrclib';

/**
 * Turning a pasted link into a song to import.
 *
 * Titles below are the shapes real uploads take, written by hand here. Song and
 * band names are used as examples of the *format* — none of the lyrics or
 * metadata is reproduced.
 */

describe('video ids', () => {
  test('reads every link shape and a bare id', () => {
    expect(videoIdFrom('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(videoIdFrom('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe('dQw4w9WgXcQ');
    expect(videoIdFrom('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(videoIdFrom('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(videoIdFrom('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(videoIdFrom('https://example.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(videoIdFrom('nonsense')).toBeNull();
  });

  test('only a real link counts as one', () => {
    expect(looksLikeYoutube('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
    expect(looksLikeYoutube('紅蓮華')).toBe(false);
    expect(looksLikeYoutube('https://youtube.com/watch?v=short')).toBe(false);
  });
});

describe('splitting an upload title', () => {
  test('artist and song around a dash', () => {
    const s = splitTitle('LiSA - 炎 (Official Video)', 'LiSA Official');
    expect(s.title).toBe('炎');
    expect(s.artist).toBe('LiSA');
  });

  test('a slash reads the Japanese way round: song first', () => {
    const s = splitTitle('炎 / LiSA', 'SomeUploader');
    expect(s.title).toBe('炎');
    expect(s.artist).toBe('LiSA');
  });

  test('the channel settles which side is the artist', () => {
    const s = splitTitle('あいうえお - かきくけこ', 'かきくけこ');
    expect(s.artist).toBe('かきくけこ');
    expect(s.title).toBe('あいうえお');
  });

  test('a quoted song title wins over the separator rules', () => {
    const s = splitTitle('YOASOBI「群青」Official Music Video', 'Ayase / YOASOBI');
    expect(s.title).toBe('群青');
    expect(s.artist).toBe('YOASOBI');
    expect(s.guessedBy).toBe('brackets');
  });

  test('upload noise in brackets is dropped, real brackets kept', () => {
    expect(splitTitle('Kessoku Band - 星座になれたら【MV】', 'ch').title).toBe('星座になれたら');
    // A parenthesis that is part of the name has to survive.
    expect(splitTitle('Artist - Song (Piano Arrangement)', 'ch').title).toBe(
      'Song (Piano Arrangement)',
    );
  });

  test('the double-bracket form is the song, the single one a section of a show', () => {
    const s = splitTitle('Ikoku Nikki (Journal with Witch)「Opening」-『Sonare (ソナーレ)』by TOMOO', '小林');
    expect(s.title).toBe('Sonare (ソナーレ)');
    expect(s.artist).toBe('TOMOO');
  });

  test('no separator falls back to the channel, minus its boilerplate', () => {
    const s = splitTitle('群青', 'YOASOBI - Topic');
    expect(s.artist).toBe('YOASOBI');
    expect(s.title).toBe('群青');
    expect(s.guessedBy).toBe('channel');
  });
});

describe('lyric search candidates', () => {
  test('the title with its artist comes first, then progressively wider', () => {
    const candidates = searchCandidates({
      title: 'Sonare (ソナーレ)',
      artist: 'TOMOO',
      rawTitle: 'Show「Opening」-『Sonare (ソナーレ)』by TOMOO',
    });
    expect(candidates[0]).toEqual({ q: 'Sonare (ソナーレ)', artist: 'TOMOO' });
    // The parenthetical is dropped, which is how the database usually files it…
    expect(candidates).toContainEqual({ q: 'Sonare', artist: 'TOMOO' });
    // …and searched on its own, since it is often the Japanese spelling.
    expect(candidates).toContainEqual({ q: 'ソナーレ', artist: 'TOMOO' });
    // The whole upload title is the last resort.
    expect(candidates[candidates.length - 1].q).toBe(
      'Show「Opening」-『Sonare (ソナーレ)』by TOMOO',
    );
  });

  test('no duplicates when the title needs no cleaning', () => {
    const candidates = searchCandidates({ title: '群青', artist: 'YOASOBI', rawTitle: '群青' });
    expect(candidates).toEqual([{ q: '群青', artist: 'YOASOBI' }, { q: '群青', artist: undefined }]);
  });
});

/** Two entries for one song: the full cut and a TV-size edit of the same words. */
function record(id: number, lastSec: number, lines = 4): LrclibRecord {
  const stamps = Array.from({ length: lines }, (_, i) => {
    const at = Math.round((lastSec * (i + 1)) / lines);
    return `[${String(Math.floor(at / 60)).padStart(2, '0')}:${String(at % 60).padStart(2, '0')}.00] 夜空に星が光る ${i}`;
  });
  return {
    id,
    trackName: 'Test Song',
    artistName: 'Test Artist',
    albumName: null,
    duration: lastSec + 5,
    instrumental: false,
    plainLyrics: null,
    syncedLyrics: stamps.join('\n'),
  };
}

describe('ranking against the video length', () => {
  test('the cut closest to the video sorts first', () => {
    const full = record(1, 260);
    const tvSize = record(2, 88);
    // Different words, so they are not folded together as duplicates.
    tvSize.syncedLyrics = tvSize.syncedLyrics!.replace(/星が光る/g, '風が吹く');

    const forFullSong = rankHits([tvSize, full], 265);
    expect(forFullSong[0].id).toBe(1);

    const forEdit = rankHits([full, tvSize], 92);
    expect(forEdit[0].id).toBe(2);
  });

  test('with no length to compare, the order is left alone', () => {
    const a = record(1, 260);
    const b = record(2, 88);
    b.syncedLyrics = b.syncedLyrics!.replace(/星が光る/g, '風が吹く');
    const hits = rankHits([a, b]);
    expect(hits.map((h) => h.id)).toEqual([1, 2]);
  });

  test('Japanese script and timings still outrank a closer length', () => {
    const closeButEnglish: LrclibRecord = {
      id: 3,
      trackName: 'Test Song',
      artistName: 'Test Artist',
      albumName: null,
      duration: 200,
      instrumental: false,
      plainLyrics: 'stars in the night sky',
      syncedLyrics: null,
    };
    const japanese = record(1, 260);
    const hits = rankHits([closeButEnglish, japanese], 201);
    expect(hits[0].id).toBe(1);
  });
});
