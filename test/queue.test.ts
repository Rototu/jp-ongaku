import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { _setDbForTests, getDb } from '../server/db';
import { buildLesson, rebuildLesson } from '../server/lesson/build';
import { seedKatakanaDeck } from '../server/lesson/kana-deck';
import * as srs from '../server/srs/store';
import { parsePlain } from '../server/lyrics/lrc';

/**
 * What a practice session is allowed to serve.
 *
 * The bug these cover: a song drill runs with `includeAhead`, and a flat due_at
 * ordering served the cards the user had answered four times in a row while the
 * back half of the song was never reached — then served them again in the next
 * session on the same day, minutes after earning a month-long interval.
 */

const SONG = [
  '夜空に星が光っている',
  '君の声を探している',
  '',
  '大人になっても忘れない',
  '走り続ければ届くだろう',
  '',
  '静かな朝が来る',
  '約束の場所へ歩く',
].join('\n');

beforeEach(() => {
  _setDbForTests(new Database(':memory:'));
});

afterEach(() => {
  _setDbForTests(null);
});

async function importSong() {
  return buildLesson({
    title: 'Queue Song',
    artist: 'Test Artist',
    source: 'paste',
    lines: parsePlain(SONG),
    raw: SONG,
  });
}

/** Pushes a card's schedule out as if it had been answered well, today. */
function settle(cardId: number, intervalDays: number) {
  const db = getDb();
  const due = new Date(Date.now() + intervalDays * 86_400_000).toISOString();
  db.prepare(
    'UPDATE srs SET reps = 4, interval_days = ?, due_at = ?, ease = 2.5 WHERE card_id = ?',
  ).run(intervalDays, due, cardId);
  db.prepare('INSERT INTO reviews (card_id, ts, quality, ms) VALUES (?, ?, 5, 900)').run(
    cardId,
    new Date().toISOString(),
  );
}

describe('practice queue', () => {
  test('a song drill reaches new cards before ones already known', async () => {
    const song = await importSong();
    const db = getDb();
    const all = db
      .query<{ card_id: number }, [number]>(
        'SELECT c.id AS card_id FROM cards c WHERE c.song_id = ? ORDER BY c.id LIMIT 8',
      )
      .all(song.songId);
    for (const row of all) settle(row.card_id, 45);

    const cards = srs.queue({ songId: song.songId, limit: 20, includeAhead: true });
    expect(cards.length).toBeGreaterThan(0);
    const settled = new Set(all.map((r) => r.card_id));
    expect(cards.some((c) => settled.has(c.id))).toBe(false);
    expect(cards.every((c) => c.srs.reps === 0)).toBe(true);
  });

  test('a card answered today does not come back in the next session', async () => {
    const song = await importSong();
    const first = srs.queue({ songId: song.songId, limit: 5, includeAhead: true });
    for (const card of first) srs.grade(card.id, 5);

    const second = srs.queue({ songId: song.songId, limit: 50, includeAhead: true });
    for (const card of first) {
      expect(second.some((c) => c.id === card.id)).toBe(false);
    }
  });

  test('a failed card still comes straight back, same session', async () => {
    const song = await importSong();
    const card = srs.queue({ songId: song.songId, limit: 1, includeAhead: true })[0];
    srs.grade(card.id, 0);

    const again = srs.queue({ songId: song.songId, limit: 50, includeAhead: true });
    expect(again.some((c) => c.id === card.id)).toBe(true);
  });

  test('new cards arrive in the order the lines are sung', async () => {
    const song = await importSong();
    const cards = srs.queue({ songId: song.songId, limit: 200, includeAhead: true });
    const idxOf = getDb().query<{ idx: number }, [number]>(
      'SELECT l.idx FROM cards c JOIN lines l ON l.id = c.line_id WHERE c.id = ?',
    );

    const lineIdx = cards
      .map((c) => idxOf.get(c.id)?.idx)
      .filter((n): n is number => typeof n === 'number');
    // Interleaving kinds means the sequence is not strictly sorted, but it must
    // not run backwards across the song: the last line seen should be near the end.
    expect(Math.max(...lineIdx)).toBeGreaterThan(Math.min(...lineIdx));
    expect(lineIdx.slice(0, 3).every((i) => i < 4)).toBe(true);
  });

  test('a song with nothing but settled cards still yields a session', async () => {
    const song = await importSong();
    const db = getDb();
    const ids = db
      .query<{ id: number }, [number]>('SELECT id FROM cards WHERE song_id = ?')
      .all(song.songId);
    // Settled a week ago, so nothing was reviewed today.
    const due = new Date(Date.now() + 40 * 86_400_000).toISOString();
    const then = new Date(Date.now() - 7 * 86_400_000).toISOString();
    for (const row of ids) {
      db.prepare('UPDATE srs SET reps = 4, interval_days = 45, due_at = ? WHERE card_id = ?').run(
        due,
        row.id,
      );
      db.prepare('INSERT INTO reviews (card_id, ts, quality, ms) VALUES (?, ?, 5, 800)').run(
        row.id,
        then,
      );
    }

    const cards = srs.queue({ songId: song.songId, limit: 10, includeAhead: true });
    expect(cards.length).toBeGreaterThan(0);
  });

  /**
   * The katakana deck is the case that made this matter: seeded in one pass from a
   * written-out table, so any ordering finer than the day it is due in replays the
   * table — and ギャ, ギュ, ギョ in a row are answered from the first one.
   */
  test('a deck seeded in one pass is not served in the order it was written', () => {
    seedKatakanaDeck();
    const db = getDb();
    const tableOrder = db
      .query<{ id: number }, []>("SELECT id FROM cards WHERE kind = 'kana' ORDER BY id")
      .all()
      .map((r) => r.id);
    expect(tableOrder.length).toBeGreaterThan(40);

    const first = srs.queue({ limit: 40, kinds: ['kana'] }).map((c) => c.id);
    const second = srs.queue({ limit: 40, kinds: ['kana'] }).map((c) => c.id);

    expect(first.length).toBe(40);
    // Both the order and the selection move between sessions. Either being equal
    // to the table's own order across 40 cards would be astronomically unlikely
    // by chance, so this fails only if the shuffle is gone.
    expect(first).not.toEqual(tableOrder.slice(0, 40));
    expect(first).not.toEqual(second);
  });

  test('the shuffle still respects what is due: overdue days come first', () => {
    seedKatakanaDeck();
    const db = getDb();
    const ids = db
      .query<{ id: number }, []>("SELECT id FROM cards WHERE kind = 'kana' ORDER BY id LIMIT 20")
      .all()
      .map((r) => r.id);

    // Ten cards a week overdue, ten due within the hour. Nothing else is due.
    db.prepare("UPDATE srs SET due_at = datetime('now', '+30 days')").run();
    const stale = ids.slice(0, 10);
    const fresh = ids.slice(10);
    for (const id of stale) {
      db.prepare(
        "UPDATE srs SET reps = 3, interval_days = 5, due_at = datetime('now', '-7 days') WHERE card_id = ?",
      ).run(id);
    }
    for (const id of fresh) {
      db.prepare(
        "UPDATE srs SET reps = 3, interval_days = 5, due_at = datetime('now', '-10 minutes') WHERE card_id = ?",
      ).run(id);
    }

    const served = srs.queue({ limit: 20, kinds: ['kana'] }).map((c) => c.id);
    expect(served.slice(0, 10).sort()).toEqual([...stale].sort());
  });

  test('the plain review queue still refuses cards that are not due', async () => {
    const song = await importSong();
    const card = srs.queue({ songId: song.songId, limit: 1, includeAhead: true })[0];
    srs.grade(card.id, 5);
    expect(srs.queue({ limit: 200 }).some((c) => c.id === card.id)).toBe(false);
  });
});

describe('lesson rebuild', () => {
  test('rebuilding from stored lyrics keeps review history and card ids', async () => {
    const song = await importSong();
    const card = srs.queue({ songId: song.songId, limit: 1, includeAhead: true })[0];
    srs.grade(card.id, 5);

    const res = await rebuildLesson(song.songId);
    expect(res?.songId).toBe(song.songId);

    const db = getDb();
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM reviews').get()?.n).toBe(1);
    expect(
      db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM cards WHERE id = ?').get(card.id)
        ?.n,
    ).toBe(1);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM songs').get()?.n).toBe(1);
  });

  test('a rebuild drops cards the song no longer produces', async () => {
    const song = await importSong();
    const db = getDb();

    // A card left over from an earlier build of the same song: a cloze on a line
    // that no longer has a blank at that index.
    db.prepare(
      `INSERT INTO cards (kind, song_id, line_id, dedupe_key, front, back, created_at)
       VALUES ('cloze', ?, (SELECT id FROM lines WHERE song_id = ? AND idx = 0), 'cloze:stale:9',
               '{"prompt":"gone"}', '{"answer":"gone"}', ?)`,
    ).run(song.songId, song.songId, new Date().toISOString());

    const res = await rebuildLesson(song.songId);
    expect(res!.cardsPruned).toBeGreaterThan(0);
    expect(
      db
        .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cards WHERE dedupe_key = 'cloze:stale:9'")
        .get()?.n,
    ).toBe(0);
  });

  test('a rebuild keeps a vocabulary card the builder itself would not make', async () => {
    const song = await importSong();
    const db = getDb();
    // Stands in for a word the user enrolled from the song page: it sits below the
    // bar the builder enrolls at, so a rebuild never produces its key.
    const word = db
      .query<{ id: number }, [number]>(
        'SELECT word_id AS id FROM word_songs WHERE song_id = ? LIMIT 1',
      )
      .get(song.songId)!;
    db.prepare(
      `INSERT INTO cards (kind, song_id, word_id, dedupe_key, front, back, created_at)
       VALUES ('vocab', ?, ?, 'vocab:hand-picked', '{"prompt":"mine"}', '{"answer":"mine"}', ?)`,
    ).run(song.songId, word.id, new Date().toISOString());

    await rebuildLesson(song.songId);
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM cards WHERE dedupe_key = 'vocab:hand-picked'",
        )
        .get()?.n,
    ).toBe(1);
  });
});
