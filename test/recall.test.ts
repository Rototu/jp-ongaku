import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { _setDbForTests, getDb } from '../server/db';
import { buildLesson } from '../server/lesson/build';
import { RECALL_UNLOCK_DAYS, unlockRecallCards } from '../server/srs/recall';
import * as srs from '../server/srs/store';
import { parsePlain } from '../server/lyrics/lrc';
import type { Card } from '../shared/types';

/**
 * Recall cards: English meaning in, Japanese out.
 *
 * What matters is when they appear — never with the lesson, only once the
 * vocabulary card has held — and that the front gives nothing away.
 */

const SONG = ['夜空に星が光っている', '君の声を探している'].join('\n');

beforeEach(() => {
  _setDbForTests(new Database(':memory:'));
});

afterEach(() => {
  _setDbForTests(null);
});

async function importSong() {
  return buildLesson({
    title: 'Recall Song',
    artist: 'Test Artist',
    source: 'paste',
    lines: parsePlain(SONG),
    raw: SONG,
  });
}

function cardsOfKind(kind: string): Card[] {
  const ids = getDb()
    .query<{ id: number }, [string]>('SELECT id FROM cards WHERE kind = ? ORDER BY id')
    .all(kind);
  return ids.map((r) => srs.getCard(r.id)!);
}

function setInterval(cardId: number, days: number) {
  getDb()
    .prepare('UPDATE srs SET reps = 3, interval_days = ? WHERE card_id = ?')
    .run(days, cardId);
}

describe('recall cards', () => {
  test('a lesson makes none', async () => {
    await importSong();
    expect(cardsOfKind('vocab').length).toBeGreaterThan(0);
    expect(cardsOfKind('recall')).toHaveLength(0);
  });

  test('a vocabulary card below the bar earns nothing', async () => {
    await importSong();
    const vocab = cardsOfKind('vocab')[0];
    setInterval(vocab.id, RECALL_UNLOCK_DAYS - 1);
    expect(unlockRecallCards()).toBe(0);
  });

  test('holding long enough unlocks exactly one, and only once', async () => {
    await importSong();
    const vocab = cardsOfKind('vocab')[0];
    setInterval(vocab.id, RECALL_UNLOCK_DAYS);
    expect(unlockRecallCards()).toBe(1);
    expect(unlockRecallCards()).toBe(0);

    const [recall] = cardsOfKind('recall');
    expect(recall.songId).toBe(vocab.songId);
    expect(recall.back.answer).toBe(vocab.front.jp!);
    expect(recall.back.reading).toBe(vocab.back.reading!);
    expect(recall.srs.reps).toBe(0);
  });

  test('the front shows the meaning and none of the answer', async () => {
    await importSong();
    const vocab = cardsOfKind('vocab')[0];
    setInterval(vocab.id, RECALL_UNLOCK_DAYS);
    unlockRecallCards();

    const [recall] = cardsOfKind('recall');
    expect(recall.front.meaning).toBeTruthy();
    expect(recall.front.jp).toBeUndefined();
    expect(recall.front.furigana).toBeUndefined();
    expect(recall.front.romaji).toBeUndefined();
    const front = JSON.stringify(recall.front);
    expect(front).not.toContain(recall.back.answer);
    expect(front).not.toContain(recall.back.reading!);
  });

  test('a gloss that spells the answer is kept off the front', () => {
    const db = getDb();
    const now = new Date().toISOString();
    const addWord = (lemma: string, reading: string, glosses: string[]) => {
      const word = db
        .query<{ id: number }, [string, string, string, string]>(
          `INSERT INTO words (lemma, reading, romaji, furigana, glosses, pos, created_at)
           VALUES (?, ?, '', '[]', ?, 'noun', ?) RETURNING id`,
        )
        .get(lemma, reading, JSON.stringify(glosses), now)!;
      const card = db
        .query<{ id: number }, [number, string, string]>(
          `INSERT INTO cards (kind, word_id, dedupe_key, front, back, created_at)
           VALUES ('vocab', ?, ?, '{}', '{}', ?) RETURNING id`,
        )
        .get(word.id, `vocab:${word.id}`, now)!;
      db.prepare('INSERT INTO srs (card_id, due_at, interval_days) VALUES (?, ?, ?)').run(
        card.id,
        now,
        RECALL_UNLOCK_DAYS,
      );
    };
    addWord('寿司', 'すし', ['sushi', 'vinegared rice']);
    addWord('カラオケ', 'カラオケ', ['karaoke']);

    expect(unlockRecallCards()).toBe(1);
    const [recall] = cardsOfKind('recall');
    expect(recall.back.answer).toBe('寿司');
    expect(recall.front.meaning).toBe('vinegared rice');
  });

  test('a retired vocabulary card stays retired', async () => {
    await importSong();
    const vocab = cardsOfKind('vocab')[0];
    setInterval(vocab.id, 30);
    srs.setSuspended(vocab.id, true);
    expect(unlockRecallCards()).toBe(0);
  });

  test('grading a vocabulary card past the bar unlocks its recall card', async () => {
    await importSong();
    const vocab = cardsOfKind('vocab')[0];
    // Two good answers already behind it; the next stretches the interval well
    // past the bar.
    getDb()
      .prepare('UPDATE srs SET reps = 2, interval_days = 6 WHERE card_id = ?')
      .run(vocab.id);
    srs.grade(vocab.id, 4);

    const recall = cardsOfKind('recall');
    expect(recall).toHaveLength(1);
    expect(recall[0].back.answer).toBe(vocab.front.jp!);
  });

  test('recall cards come up in a recall-only queue', async () => {
    await importSong();
    for (const vocab of cardsOfKind('vocab')) setInterval(vocab.id, RECALL_UNLOCK_DAYS);
    const made = unlockRecallCards();
    expect(made).toBeGreaterThan(0);

    const queue = srs.queue({ kinds: ['recall'], limit: 50 });
    expect(queue).toHaveLength(made);
    expect(queue.every((c) => c.kind === 'recall')).toBe(true);
  });
});
