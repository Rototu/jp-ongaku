import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { _setDbForTests, getDb } from '../server/db';
import * as srs from '../server/srs/store';

/**
 * The numbers the redesigned screens are built on.
 *
 * Today composes a setlist from `dueByKind`, the word garden and the review card
 * both draw a ring from `mastery`, and Progress draws the song map from
 * `songMap`. All three used to be invented in the UI; these tests pin them to the
 * database so a screen can never quietly show a plausible number.
 */

beforeEach(() => {
  _setDbForTests(new Database(':memory:'));
});

afterEach(() => {
  _setDbForTests(null);
});

/** A song with `lines` lines, and one card per line so the map has something to shade. */
function seedSong(title: string, lines: number): { songId: number; lineIds: number[] } {
  const db = getDb();
  const song = db
    .prepare(
      `INSERT INTO songs (title, artist, source, created_at) VALUES (?, 'Someone', 'paste', datetime('now'))
       RETURNING id`,
    )
    .get(title) as { id: number };

  const lineIds: number[] = [];
  for (let i = 0; i < lines; i++) {
    const line = db
      .prepare(
        `INSERT INTO lines (song_id, idx, text, tokens, verse_idx) VALUES (?, ?, ?, '[]', 0)
         RETURNING id`,
      )
      .get(song.id, i, `line ${i}`) as { id: number };
    lineIds.push(line.id);
  }
  return { songId: song.id, lineIds };
}

function addCard(opts: {
  kind: string;
  songId?: number;
  lineId?: number;
  answer?: string;
  front?: string;
  intervalDays?: number;
  reps?: number;
  lapses?: number;
  leech?: boolean;
  dueDaysFromNow?: number;
}): number {
  const db = getDb();
  const card = db
    .prepare(
      `INSERT INTO cards (kind, song_id, line_id, dedupe_key, front, back, created_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now')) RETURNING id`,
    )
    .get(
      opts.kind,
      opts.songId ?? null,
      opts.lineId ?? null,
      `k${Math.random()}`,
      JSON.stringify({ prompt: 'p', jp: opts.front ?? '' }),
      JSON.stringify({ answer: opts.answer ?? 'x' }),
    ) as { id: number };

  const due = new Date(Date.now() + (opts.dueDaysFromNow ?? -1) * 86_400_000).toISOString();
  db.prepare(
    `INSERT INTO srs (card_id, interval_days, reps, lapses, due_at, leech) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    card.id,
    opts.intervalDays ?? 0,
    opts.reps ?? 0,
    opts.lapses ?? 0,
    due,
    opts.leech ? 1 : 0,
  );
  return card.id;
}

describe('mastery', () => {
  test('a card never answered is at zero', () => {
    expect(srs.mastery({ intervalDays: 0, reps: 0, lapses: 0, leech: false })).toBe(0);
  });

  test('mastery is the interval measured against maturity, and caps at 100', () => {
    expect(srs.mastery({ intervalDays: 21, reps: 4, lapses: 0, leech: false })).toBe(100);
    expect(srs.mastery({ intervalDays: 200, reps: 9, lapses: 0, leech: false })).toBe(100);
    expect(srs.mastery({ intervalDays: 10.5, reps: 3, lapses: 0, leech: false })).toBe(50);
  });

  test('a leech can never read as solid, however long its interval', () => {
    const leech = srs.mastery({ intervalDays: 200, reps: 9, lapses: 4, leech: true });
    expect(leech).toBeLessThanOrEqual(40);
  });

  test('a card that has lapsed at all stays short of the top', () => {
    expect(srs.mastery({ intervalDays: 60, reps: 6, lapses: 1, leech: false })).toBe(88);
  });
});

describe('interval previews', () => {
  test('each button previews a different schedule, and again is the shortest', () => {
    const id = addCard({ kind: 'vocab', intervalDays: 6, reps: 2 });
    const p = srs.previewIntervals(id);
    expect(p.again).toBeLessThan(1);
    expect(p.good).toBeGreaterThan(p.again);
    expect(p.easy).toBeGreaterThanOrEqual(p.good);
  });

  test('an unknown card previews as a fresh one rather than throwing', () => {
    expect(srs.previewIntervals(9999).good).toBeGreaterThan(0);
  });
});

describe('due counts by kind', () => {
  test('the setlist can tell kana apart from everything else', () => {
    addCard({ kind: 'kana' });
    addCard({ kind: 'kana' });
    addCard({ kind: 'vocab' });
    // Not due for a week: it must not be counted.
    addCard({ kind: 'vocab', dueDaysFromNow: 7 });

    const s = srs.stats();
    expect(s.dueByKind.kana).toBe(2);
    expect(s.dueByKind.vocab).toBe(1);
    expect(s.dueNow).toBe(3);
  });
});

describe('song map', () => {
  test('one cell per line, unstudied lines marked rather than shaded', () => {
    const { songId, lineIds } = seedSong('Sonare', 3);
    addCard({ kind: 'vocab', songId, lineId: lineIds[0], intervalDays: 21, reps: 5 });
    addCard({ kind: 'vocab', songId, lineId: lineIds[1], reps: 0 });

    const rows = srs.songMap();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.lineCount).toBe(3);
    expect(row.cells).toHaveLength(3);
    expect(row.cells[0].mastery).toBe(100);
    // A card that exists but has never been answered is still "not studied".
    expect(row.cells[1].mastery).toBe(-1);
    // A line with no cards at all likewise.
    expect(row.cells[2].mastery).toBe(-1);
  });

  test('the percentage counts unstudied lines against the song, not out of it', () => {
    const { songId, lineIds } = seedSong('Half known', 4);
    for (const lineId of lineIds.slice(0, 2)) {
      addCard({ kind: 'vocab', songId, lineId, intervalDays: 21, reps: 5 });
    }

    const [row] = srs.songMap();
    // Two of four lines known cold — half, not 100%.
    expect(row.percent).toBe(50);
  });

  test('a line that keeps failing is flagged whatever its interval says', () => {
    const { songId, lineIds } = seedSong('Trouble', 1);
    addCard({
      kind: 'cloze',
      songId,
      lineId: lineIds[0],
      intervalDays: 30,
      reps: 4,
      lapses: 3,
      leech: true,
    });

    const [row] = srs.songMap();
    expect(row.cells[0].trouble).toBe(true);
    expect(row.cells[0].mastery).toBeLessThanOrEqual(40);
  });

  test('favourites lead the map', () => {
    seedSong('Ordinary', 1);
    const fav = seedSong('Favourite', 1);
    getDb().prepare('UPDATE songs SET favourite = 1 WHERE id = ?').run(fav.songId);

    expect(srs.songMap()[0].title).toBe('Favourite');
  });
});

describe('trouble clusters', () => {
  test('two cards answered with each other become one named pair', () => {
    const shi = addCard({ kind: 'kana', answer: 'shi', front: 'シ', lapses: 3, leech: true });
    addCard({ kind: 'kana', answer: 'tsu', front: 'ツ', lapses: 3, leech: true });
    // The user picked "tsu" when the answer was "shi", twice.
    for (let i = 0; i < 2; i++) {
      getDb()
        .prepare(
          `INSERT INTO reviews (card_id, ts, quality, ms, given) VALUES (?, datetime('now'), 1, 0, 'tsu')`,
        )
        .run(shi);
    }

    const [cluster] = srs.troubleClusters();
    // Shown as the glyphs, not as the romaji the card happens to answer with.
    expect(cluster.items).toEqual(['シ', 'ツ']);
    expect(cluster.cardIds).toHaveLength(2);
    expect(cluster.lapses).toBe(6);
  });

  test('a card that has only slipped once is not a cluster yet', () => {
    addCard({ kind: 'vocab', answer: 'x', lapses: 1 });
    expect(srs.troubleClusters()).toHaveLength(0);
  });

  test('the reason the user gave is read back in their own words', () => {
    const id = addCard({ kind: 'kana', answer: 'shi', front: 'シ', lapses: 3 });
    srs.setCardReason(id, 'looks-like-another');

    const [cluster] = srs.troubleClusters();
    expect(cluster.reason).toContain('look');
  });

  test('a free-text reason survives verbatim', () => {
    const id = addCard({ kind: 'vocab', answer: 'x', lapses: 2 });
    srs.setCardReason(id, 'I keep reading it as the other one');

    expect(srs.troubleClusters()[0].reason).toBe('I keep reading it as the other one');
  });
});

describe('listening accounting', () => {
  test('playback adds to today and nothing else', () => {
    srs.logListening(30);
    srs.logListening(15);

    const days = srs.stats().dailyListenSec;
    expect(days).toHaveLength(7);
    expect(days.at(-1)).toBe(45);
    expect(days.slice(0, 6).every((n) => n === 0)).toBe(true);
  });

  test('nonsense is ignored rather than stored', () => {
    srs.logListening(0);
    srs.logListening(-10);
    srs.logListening(Number.NaN);

    expect(srs.stats().dailyListenSec.at(-1)).toBe(0);
  });
});
