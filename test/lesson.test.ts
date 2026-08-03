import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { _setDbForTests, getDb } from '../server/db';
import { buildLesson } from '../server/lesson/build';
import { seedKatakanaDeck } from '../server/lesson/kana-deck';
import * as srs from '../server/srs/store';
import { parsePlain } from '../server/lyrics/lrc';
import { parseYoutubeId, rebuildListeningCards, removeListeningCards } from '../server/routes/api';

/**
 * Fixture lines written by hand for these tests — plain sentences in a lyric
 * register, not taken from any song.
 */
const FIXTURE = [
  '夜空に星が光っている',
  '君の声を探している',
  '',
  '大人になっても忘れない',
  '走り続ければ届くだろう',
].join('\n');

beforeEach(() => {
  _setDbForTests(new Database(':memory:'));
});

afterEach(() => {
  _setDbForTests(null);
});

async function importFixture(youtubeId?: string) {
  const lines = parsePlain(FIXTURE);
  return buildLesson({
    title: 'Test Song',
    artist: 'Test Artist',
    source: 'paste',
    youtubeId: youtubeId ?? null,
    lines,
    raw: FIXTURE,
  });
}

describe('lesson build', () => {
  test('stores the song, its lines, and verse grouping', async () => {
    const res = await importFixture();
    expect(res.lineCount).toBe(4);
    // The blank line in the fixture separates two sections of two lines each.
    expect(res.verseCount).toBe(2);

    const db = getDb();
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM songs').get()?.n).toBe(1);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM lines').get()?.n).toBe(4);
  });

  test('creates vocab cards for words worth learning', async () => {
    const res = await importFixture();
    expect(res.wordsEnrolled).toBeGreaterThan(0);

    const cards = getDb()
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cards WHERE kind = 'vocab'")
      .get();
    expect(cards?.n).toBeGreaterThan(0);
  });

  test('every card gets an SRS row that is due immediately', async () => {
    await importFixture();
    const db = getDb();
    const orphans = db
      .query<{ n: number }, []>(
        'SELECT COUNT(*) AS n FROM cards c LEFT JOIN srs r ON r.card_id = c.id WHERE r.card_id IS NULL',
      )
      .get();
    expect(orphans?.n).toBe(0);
    expect(srs.stats().dueNow).toBe(srs.stats().totalCards);
  });

  test('creates grammar cards for detected patterns', async () => {
    await importFixture();
    const rows = getDb()
      .query<{ pattern: string }, []>('SELECT pattern FROM grammar_items')
      .all();
    const patterns = rows.map((r) => r.pattern).join(' ');
    expect(patterns).toContain('ている');
  });

  test('creates one cloze card per line at most', async () => {
    await importFixture();
    const db = getDb();
    const perLine = db
      .query<{ line_id: number; n: number }, []>(
        "SELECT line_id, COUNT(*) AS n FROM cards WHERE kind = 'cloze' GROUP BY line_id",
      )
      .all();
    for (const row of perLine) expect(row.n).toBeLessThanOrEqual(1);
    expect(perLine.length).toBeGreaterThan(0);
  });

  test('cloze fronts actually contain a blank', async () => {
    await importFixture();
    const rows = getDb()
      .query<{ front: string }, []>("SELECT front FROM cards WHERE kind = 'cloze'")
      .all();
    for (const r of rows) expect(JSON.parse(r.front).jp).toContain('＿＿＿');
  });

  test('skips listening cards without a video', async () => {
    await importFixture();
    const n = getDb()
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cards WHERE kind = 'listening'")
      .get();
    expect(n?.n).toBe(0);
  });

  test('re-importing the same song does not duplicate cards', async () => {
    const first = await importFixture();
    const before = getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM cards').get()?.n;

    const second = await importFixture();
    const after = getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM cards').get()?.n;

    expect(second.songId).toBe(first.songId);
    expect(after).toBe(before);
    expect(getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM songs').get()?.n).toBe(1);
  });

  test('vocabulary is shared across songs rather than duplicated', async () => {
    await importFixture();
    const wordsBefore = getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM words').get()?.n;

    await buildLesson({
      title: 'Second Song',
      artist: 'Other Artist',
      source: 'paste',
      lines: parsePlain('夜空に星が光っている'),
      raw: '夜空に星が光っている',
    });

    const wordsAfter = getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM words').get()?.n;
    expect(wordsAfter).toBe(wordsBefore);

    // But the word is now linked to both songs.
    const links = getDb()
      .query<{ n: number }, []>(
        `SELECT COUNT(DISTINCT song_id) AS n FROM word_songs
         WHERE word_id = (SELECT id FROM words WHERE lemma = '星')`,
      )
      .get();
    expect(links?.n).toBe(2);
  });

  test('preserves review history when a song is re-imported', async () => {
    await importFixture();
    const card = srs.queue({ limit: 1 })[0];
    srs.grade(card.id, 5);

    await importFixture();

    const reviews = getDb().query<{ n: number }, []>('SELECT COUNT(*) AS n FROM reviews').get();
    expect(reviews?.n).toBe(1);
  });

  test('creates listening cards when a video id is supplied and lines are timed', async () => {
    const timed = [
      { text: '夜空に星が光っている', timeMs: 1000 },
      { text: '君の声を探している', timeMs: 5000 },
    ];
    await buildLesson({
      title: 'Timed Song',
      artist: 'Test Artist',
      source: 'paste',
      youtubeId: 'dQw4w9WgXcQ',
      lines: timed,
      raw: timed.map((l) => l.text).join('\n'),
    });

    const rows = getDb()
      .query<{ front: string }, []>("SELECT front FROM cards WHERE kind = 'listening'")
      .all();
    expect(rows).toHaveLength(2);
    const audio = JSON.parse(rows[0].front).audio;
    expect(audio.youtubeId).toBe('dQw4w9WgXcQ');
    expect(audio.startMs).toBe(1000);
    // The clip runs until the next line starts.
    expect(audio.endMs).toBe(5000);
  });
});

/**
 * A song can be pointed at a different upload later: the first video was a live
 * take, or the wrong song, or went private. Listening cards embed the video id in
 * their clip, so changing the video has to reach them too.
 */
describe('changing a song’s video', () => {
  async function timedSong(youtubeId: string | null) {
    const timed = [
      { text: '夜空に星が光っている', timeMs: 1000 },
      { text: '君の声を探している', timeMs: 5000 },
    ];
    return buildLesson({
      title: 'Timed Song',
      artist: 'Test Artist',
      source: 'paste',
      youtubeId,
      lines: timed,
      raw: timed.map((l) => l.text).join('\n'),
    });
  }

  function listening(): { id: number; audio: { youtubeId: string; startMs: number } }[] {
    return getDb()
      .query<{ id: number; front: string }, []>(
        "SELECT id, front FROM cards WHERE kind = 'listening' ORDER BY id",
      )
      .all()
      .map((r) => ({ id: r.id, audio: JSON.parse(r.front).audio }));
  }

  test('existing listening cards are repointed at the new video', async () => {
    const { songId } = await timedSong('dQw4w9WgXcQ');
    const before = listening();
    expect(before).toHaveLength(2);

    getDb().prepare('UPDATE songs SET youtube_id = ? WHERE id = ?').run('abcdefghijk', songId);
    rebuildListeningCards(songId);

    const after = listening();
    expect(after.map((c) => c.audio.youtubeId)).toEqual(['abcdefghijk', 'abcdefghijk']);
    // Same cards, so the review history survives the swap.
    expect(after.map((c) => c.id)).toEqual(before.map((c) => c.id));
    expect(after[0].audio.startMs).toBe(1000);
  });

  test('a song timed before it had a video gets its listening cards on attach', async () => {
    const { songId } = await timedSong(null);
    expect(listening()).toHaveLength(0);

    getDb().prepare('UPDATE songs SET youtube_id = ? WHERE id = ?').run('dQw4w9WgXcQ', songId);
    rebuildListeningCards(songId);

    expect(listening()).toHaveLength(2);
  });

  test('review history is kept when a card is repointed', async () => {
    const { songId } = await timedSong('dQw4w9WgXcQ');
    const card = listening()[0];
    getDb()
      .prepare('INSERT INTO reviews (card_id, ts, quality, ms) VALUES (?, ?, 4, 1200)')
      .run(card.id, new Date().toISOString());

    getDb().prepare('UPDATE songs SET youtube_id = ? WHERE id = ?').run('abcdefghijk', songId);
    rebuildListeningCards(songId);

    const kept = getDb()
      .query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM reviews WHERE card_id = ?')
      .get(card.id);
    expect(kept?.n).toBe(1);
  });

  test('shifting the timings moves the listening clips with them', async () => {
    const { songId } = await timedSong('dQw4w9WgXcQ');
    const db = getDb();

    // The reported case in miniature: lyrics timed 19.5s early for this video.
    db.prepare(
      'UPDATE lines SET time_ms = MAX(0, time_ms + ?) WHERE song_id = ? AND time_ms IS NOT NULL',
    ).run(19_500, songId);
    rebuildListeningCards(songId);

    const clips = listening();
    expect(clips.map((c) => c.audio.startMs)).toEqual([20_500, 24_500]);
    // Same cards, so nothing learnt is lost to a re-sync.
    expect(clips).toHaveLength(2);
  });

  test('clearing the video removes the cards that needed it', async () => {
    const { songId } = await timedSong('dQw4w9WgXcQ');
    expect(listening()).toHaveLength(2);

    getDb().prepare('UPDATE songs SET youtube_id = NULL WHERE id = ?').run(songId);
    expect(removeListeningCards(songId)).toBe(2);
    expect(listening()).toHaveLength(0);
    // Other card kinds are untouched.
    expect(
      getDb()
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cards WHERE kind = 'vocab'")
        .get()?.n,
    ).toBeGreaterThan(0);
  });
});

describe('review queue', () => {
  test('serves due cards and interleaves kinds', async () => {
    await importFixture();
    const cards = srs.queue({ limit: 10 });
    expect(cards.length).toBeGreaterThan(1);

    // Consecutive identical kinds should be rare; assert not all-same.
    const kinds = new Set(cards.map((c) => c.kind));
    expect(kinds.size).toBeGreaterThan(1);
  });

  test('graded cards leave the due queue', async () => {
    await importFixture();
    const card = srs.queue({ limit: 1 })[0];
    srs.grade(card.id, 5);
    const stillDue = srs.queue({ limit: 100 }).some((c) => c.id === card.id);
    expect(stillDue).toBe(false);
  });

  test('failed cards come straight back', async () => {
    await importFixture();
    const card = srs.queue({ limit: 1 })[0];
    srs.grade(card.id, 0);
    // Due in ~10 minutes, so not in the immediate queue but visible with ahead.
    const ahead = srs.queue({ limit: 100, includeAhead: true }).some((c) => c.id === card.id);
    expect(ahead).toBe(true);
  });

  test('leeches are served first', async () => {
    await importFixture();
    const all = srs.queue({ limit: 50 });
    const victim = all[all.length - 1];
    for (let i = 0; i < 3; i++) srs.grade(victim.id, 0);

    const queue = srs.queue({ limit: 50, includeAhead: true });
    expect(queue[0].id).toBe(victim.id);
    expect(queue[0].srs.leech).toBe(true);
  });

  test('filters by song', async () => {
    await importFixture();
    await buildLesson({
      title: 'Second Song',
      artist: 'Other Artist',
      source: 'paste',
      lines: parsePlain('冬の朝は寒い'),
      raw: '冬の朝は寒い',
    });
    const songId = getDb()
      .query<{ id: number }, []>("SELECT id FROM songs WHERE title = 'Second Song'")
      .get()!.id;

    const cards = srs.queue({ limit: 50, songId });
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.songId === songId)).toBe(true);
  });

  test('suspended cards are never served', async () => {
    await importFixture();
    const card = srs.queue({ limit: 1 })[0];
    srs.setSuspended(card.id, true);
    expect(srs.queue({ limit: 100, includeAhead: true }).some((c) => c.id === card.id)).toBe(false);
  });
});

describe('stats and reports', () => {
  test('counts reviews and computes accuracy', async () => {
    await importFixture();
    const cards = srs.queue({ limit: 4 });
    srs.grade(cards[0].id, 5);
    srs.grade(cards[1].id, 4);
    srs.grade(cards[2].id, 1);
    srs.grade(cards[3].id, 0);

    const s = srs.stats();
    expect(s.reviewsToday).toBe(4);
    expect(s.accuracy7d).toBeCloseTo(0.5, 5);
    expect(s.streakDays).toBe(1);
  });

  test('streak is zero before any review', async () => {
    await importFixture();
    expect(srs.stats().streakDays).toBe(0);
  });

  test('trouble lines surface repeatedly failed lines', async () => {
    await importFixture();
    const card = srs.queue({ limit: 50 }).find((c) => c.kind === 'cloze')!;
    srs.grade(card.id, 0);
    srs.grade(card.id, 0);

    const trouble = srs.troubleLines();
    expect(trouble.length).toBeGreaterThan(0);
    expect(trouble[0].lapses).toBeGreaterThanOrEqual(2);
    expect(trouble[0].text.length).toBeGreaterThan(0);
  });

  test('mistake patterns report grammar the user keeps failing', async () => {
    await importFixture();
    const grammarCards = srs.queue({ limit: 50, includeAhead: true }).filter(
      (c) => c.kind === 'grammar',
    );
    expect(grammarCards.length).toBeGreaterThan(0);
    srs.grade(grammarCards[0].id, 0);
    srs.grade(grammarCards[0].id, 1);

    const patterns = srs.mistakePatterns();
    expect(patterns.some((p) => p.kind === 'grammar')).toBe(true);
  });

  test('records the wrong answer given so confusions can be reported', async () => {
    await importFixture();
    const cloze = srs.queue({ limit: 50 }).find((c) => c.kind === 'cloze')!;
    srs.grade(cloze.id, 1, 500, 'まちがい');
    srs.grade(cloze.id, 1, 500, 'まちがい');
    const patterns = srs.mistakePatterns();
    // The two words live in `examples` so each can carry its own romaji; the
    // detail line stays English.
    const confusion = patterns.find((p) => p.kind === 'confusion');
    expect(confusion).toBeTruthy();
    expect(confusion!.examples.some((e) => e.text === 'まちがい')).toBe(true);
  });

  test('clearing a leech resets its lapse count', async () => {
    await importFixture();
    const card = srs.queue({ limit: 1 })[0];
    for (let i = 0; i < 3; i++) srs.grade(card.id, 0);
    expect(srs.getCard(card.id)!.srs.leech).toBe(true);

    srs.clearLeech(card.id);
    const after = srs.getCard(card.id)!;
    expect(after.srs.leech).toBe(false);
    expect(after.srs.lapses).toBe(0);
  });
});

describe('katakana deck', () => {
  test('seeds cards and is idempotent', () => {
    const first = seedKatakanaDeck();
    expect(first.created).toBeGreaterThan(60);

    const second = seedKatakanaDeck();
    expect(second.created).toBe(0);
    expect(second.total).toBe(first.total);
  });

  test('cards answer with romaji and flag look-alikes', () => {
    seedKatakanaDeck();
    const shi = getDb()
      .query<{ back: string }, []>("SELECT back FROM cards WHERE dedupe_key = 'kana:katakana:シ'")
      .get();
    const back = JSON.parse(shi!.back);
    expect(back.answer).toBe('shi');
    expect(back.note).toContain('ツ');
  });
});

describe('word enrollment', () => {
  test('a song-only word can be enrolled on demand', async () => {
    await importFixture();
    const db = getDb();
    // Find a word that did not get a card.
    const row = db
      .query<{ id: number }, []>(
        'SELECT w.id FROM words w LEFT JOIN cards c ON c.word_id = w.id WHERE c.id IS NULL LIMIT 1',
      )
      .get();
    if (!row) return; // fixture enrolled everything; nothing to assert

    const card = srs.enrollWord(row.id);
    expect(card).not.toBeNull();
    expect(card!.kind).toBe('vocab');
    expect(srs.queue({ limit: 100 }).some((c) => c.id === card!.id)).toBe(true);
  });
});

describe('youtube id parsing', () => {
  test('accepts bare ids, watch urls, short links and embeds', () => {
    expect(parseYoutubeId('dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYoutubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s')).toBe('dQw4w9WgXcQ');
    expect(parseYoutubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(parseYoutubeId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  test('rejects nonsense', () => {
    expect(parseYoutubeId('not a video')).toBeNull();
    expect(parseYoutubeId('')).toBeNull();
    expect(parseYoutubeId(null)).toBeNull();
  });
});
