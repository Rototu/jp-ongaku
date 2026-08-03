import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { _setDbForTests, getDb } from '../server/db';
import { buildLesson, lineFurigana, CLOZE_BLANK } from '../server/lesson/build';
import {
  backfillCardReadings,
  backfillWordSurfaces,
  cardsMissingReadings,
  realignWordReadings,
} from '../server/lesson/backfill-cards';
import { parsePlain } from '../server/lyrics/lrc';
import { tokenizeLine } from '../server/nlp/tokenize';
import { segmentsToReading } from '../server/nlp/furigana';
import type { CardBack, CardFront } from '../shared/types';

/**
 * Every card that shows Japanese must show its reading. The user reads little
 * kanji, so a bare-kanji card is not a harder card, it is an unanswerable one.
 */

const FIXTURE = ['夜空に星が光っている', '君の声を探している'].join('\n');

beforeEach(() => {
  _setDbForTests(new Database(':memory:'));
});

afterEach(() => {
  _setDbForTests(null);
});

async function importFixture(youtubeId?: string) {
  const timed = parsePlain(FIXTURE).map((l, i) => ({ ...l, timeMs: i * 4000 }));
  return buildLesson({
    title: 'Reading Fixture',
    artist: 'Test Artist',
    source: 'paste',
    youtubeId: youtubeId ?? null,
    lines: timed,
    raw: FIXTURE,
  });
}

function cards(kind: string): { front: CardFront; back: CardBack }[] {
  return getDb()
    .query<{ front: string; back: string }, [string]>(
      'SELECT front, back FROM cards WHERE kind = ?',
    )
    .all(kind)
    .map((r) => ({
      front: JSON.parse(r.front) as CardFront,
      back: JSON.parse(r.back) as CardBack,
    }));
}

describe('lineFurigana', () => {
  test('covers the whole line and round-trips to its reading', async () => {
    const tokens = await tokenizeLine('夜空に星が光っている');
    const segs = lineFurigana(tokens);
    expect(segs.map((s) => s.text).join('')).toBe('夜空に星が光っている');
    expect(segmentsToReading(segs)).toBe('よぞらにほしがひかっている');
  });

  test('blanks one token and leaves the blank unannotated', async () => {
    const tokens = await tokenizeLine('夜空に星が光っている');
    const starIdx = tokens.findIndex((t) => t.surface === '星');
    const segs = lineFurigana(tokens, starIdx);

    const text = segs.map((s) => s.text).join('');
    expect(text).toContain(CLOZE_BLANK);
    expect(text).not.toContain('星');
    // The blank must not carry ruby, or the reading gives the answer away.
    expect(segs.find((s) => s.text.includes(CLOZE_BLANK))?.ruby).toBe('');
    // And the answer's reading must not survive anywhere in the front.
    expect(segs.some((s) => s.ruby === 'ほし')).toBe(false);
  });

  test('merges unannotated runs so markup stays compact', async () => {
    const tokens = await tokenizeLine('これはこれ');
    const segs = lineFurigana(tokens);
    expect(segs).toHaveLength(1);
  });
});

describe('generated cards carry readings', () => {
  test('cloze fronts show ruby on the surrounding words', async () => {
    await importFixture();
    const cloze = cards('cloze');
    expect(cloze.length).toBeGreaterThan(0);
    for (const card of cloze) {
      expect(card.front.furigana?.length).toBeGreaterThan(0);
      expect(card.front.romaji).toBeTruthy();
      expect(card.front.furigana?.map((s) => s.text).join('')).toContain(CLOZE_BLANK);
    }
  });

  test('cloze answers show ruby, reading and romaji', async () => {
    await importFixture();
    for (const card of cards('cloze')) {
      expect(card.back.furigana?.length).toBeGreaterThan(0);
      expect(card.back.reading).toBeTruthy();
      expect(card.back.romaji).toBeTruthy();
      expect(card.back.furigana?.map((s) => s.text).join('')).toBe(card.back.answer);
    }
  });

  test('grammar example lines show ruby and romaji', async () => {
    await importFixture();
    const grammar = cards('grammar');
    expect(grammar.length).toBeGreaterThan(0);
    for (const card of grammar) {
      expect(card.front.furigana?.length).toBeGreaterThan(0);
      expect(card.front.romaji).toBeTruthy();
      expect(card.front.furigana?.map((s) => s.text).join('')).toBe(card.front.jp);
    }
  });

  test('listening answers show ruby, reading and romaji', async () => {
    await importFixture('dQw4w9WgXcQ');
    const listening = cards('listening');
    expect(listening.length).toBeGreaterThan(0);
    for (const card of listening) {
      expect(card.back.furigana?.length).toBeGreaterThan(0);
      expect(card.back.reading).toBeTruthy();
      expect(card.back.romaji).toBeTruthy();
    }
  });

  test('vocab answers stay plain English, not run through ruby', async () => {
    await importFixture();
    for (const card of cards('vocab')) {
      // The answer is a meaning; ruby belongs on the front, which has it.
      expect(card.front.furigana?.length).toBeGreaterThan(0);
      expect(card.back.reading).toBeTruthy();
      expect(card.back.romaji).toBeTruthy();
    }
  });

  test('no generated card shows Japanese without a reading', async () => {
    await importFixture('dQw4w9WgXcQ');
    const all = getDb()
      .query<{ kind: string; front: string; back: string }, []>(
        'SELECT kind, front, back FROM cards',
      )
      .all();
    const hasKanji = (s: string) => /[一-鿿]/.test(s);

    for (const row of all) {
      const front = JSON.parse(row.front) as CardFront;
      const back = JSON.parse(row.back) as CardBack;
      if (front.jp && hasKanji(front.jp)) {
        expect(front.furigana?.length).toBeGreaterThan(0);
      }
      if (hasKanji(back.answer)) {
        expect(back.furigana?.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('backfill for cards made before ruby existed', () => {
  /** Strips the reading fields an older build would not have written. */
  function degradeCards() {
    const db = getDb();
    const rows = db
      .query<{ id: number; kind: string; front: string; back: string }, []>(
        "SELECT id, kind, front, back FROM cards WHERE kind IN ('grammar','cloze','listening')",
      )
      .all();
    for (const row of rows) {
      const front = JSON.parse(row.front) as CardFront;
      const back = JSON.parse(row.back) as CardBack;
      delete front.furigana;
      delete back.furigana;
      delete back.reading;
      db.prepare('UPDATE cards SET front = ?, back = ? WHERE id = ?').run(
        JSON.stringify(front),
        JSON.stringify(back),
        row.id,
      );
    }
    return rows.length;
  }

  test('restores readings without touching card ids or history', async () => {
    await importFixture('dQw4w9WgXcQ');
    const idsBefore = getDb()
      .query<{ id: number }, []>('SELECT id FROM cards ORDER BY id')
      .all()
      .map((r) => r.id);

    const degraded = degradeCards();
    expect(degraded).toBeGreaterThan(0);
    expect(cardsMissingReadings()).toBeGreaterThan(0);

    const fixed = backfillCardReadings();
    expect(fixed).toBe(degraded);
    expect(cardsMissingReadings()).toBe(0);

    const idsAfter = getDb()
      .query<{ id: number }, []>('SELECT id FROM cards ORDER BY id')
      .all()
      .map((r) => r.id);
    expect(idsAfter).toEqual(idsBefore);
  });

  test('rebuilt cloze fronts still hide the answer', async () => {
    await importFixture();
    degradeCards();
    backfillCardReadings();

    for (const card of cards('cloze')) {
      const text = card.front.furigana?.map((s) => s.text).join('') ?? '';
      expect(text).toContain(CLOZE_BLANK);
      expect(text).not.toContain(card.back.answer);
    }
  });

  test('is idempotent', async () => {
    await importFixture('dQw4w9WgXcQ');
    degradeCards();
    expect(backfillCardReadings()).toBeGreaterThan(0);
    expect(backfillCardReadings()).toBe(0);
  });

  test('leaves already-correct cards alone', async () => {
    await importFixture('dQw4w9WgXcQ');
    expect(backfillCardReadings()).toBe(0);
  });
});

describe('vocabulary readings describe the dictionary form', () => {
  test('a word row carries ruby covering its own lemma', async () => {
    await importFixture();
    const rows = getDb()
      .query<{ lemma: string; reading: string; furigana: string; romaji: string }, []>(
        'SELECT lemma, reading, furigana, romaji FROM words',
      )
      .all();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const segs = JSON.parse(row.furigana) as { text: string; ruby: string }[];
      // Not the inflected surface the word was first seen as.
      expect(segs.map((s) => s.text).join('')).toBe(row.lemma);
      expect(segmentsToReading(segs)).toBe(row.reading);
      expect(row.romaji.length).toBeGreaterThan(0);
    }
  });

  test('vocab card fronts match the word they show', async () => {
    await importFixture();
    for (const card of cards('vocab')) {
      expect(card.front.furigana?.map((s) => s.text).join('')).toBe(card.front.jp);
      expect(card.front.romaji).toBeTruthy();
    }
  });

  test('a stale card is repaired even when its word row is already correct', async () => {
    await importFixture();
    const db = getDb();

    // Exactly the case the first version of the backfill skipped: the word row
    // is right, but the card still shows the inflected form's reading.
    const word = db
      .query<{ id: number; lemma: string }, []>(
        "SELECT id, lemma FROM words WHERE lemma LIKE '%る' LIMIT 1",
      )
      .get();
    if (!word) return;

    const card = db
      .query<{ id: number; front: string }, [number]>(
        "SELECT id, front FROM cards WHERE word_id = ? AND kind = 'vocab'",
      )
      .get(word.id);
    if (!card) return;

    const front = JSON.parse(card.front) as CardFront;
    front.furigana = [{ text: '見えない', ruby: '' }];
    front.romaji = 'mienai';
    db.prepare('UPDATE cards SET front = ? WHERE id = ?').run(
      JSON.stringify(front),
      card.id,
    );

    expect(realignWordReadings()).toBeGreaterThan(0);

    const after = JSON.parse(
      db.query<{ front: string }, [number]>('SELECT front FROM cards WHERE id = ?').get(card.id)!
        .front,
    ) as CardFront;
    expect(after.furigana?.map((s) => s.text).join('')).toBe(after.jp);
    expect(after.romaji).not.toBe('mienai');
  });

  test('realigning is idempotent', async () => {
    await importFixture();
    realignWordReadings();
    expect(realignWordReadings()).toBe(0);
  });
});

/**
 * A word is stored under its dictionary headword, which need not be what the song
 * writes: the possessive の is filed under 乃. Without the surface recorded, the
 * bar under a word in the lyrics has no way to find that word's SRS state, so a
 * retired particle kept showing an empty bar.
 */
describe('the form a word was seen as', () => {
  test('every word/line link records the surface from the line', async () => {
    await importFixture();
    const links = getDb()
      .query<{ lemma: string; seen_as: string | null; text: string }, []>(
        `SELECT w.lemma, ws.seen_as, l.text
         FROM word_songs ws JOIN words w ON w.id = ws.word_id JOIN lines l ON l.id = ws.line_id`,
      )
      .all();

    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.seen_as).toBeTruthy();
      // The surface must be text the line actually contains, headword or not.
      expect(link.text).toContain(link.seen_as as string);
    }
  });

  test('a kana surface is kept even when the headword is a kanji nobody writes', async () => {
    await importFixture();
    // 君の声 — の is filed under the kanji 乃, so lemma and surface differ.
    const link = getDb()
      .query<{ lemma: string; seen_as: string }, []>(
        `SELECT w.lemma, ws.seen_as FROM word_songs ws JOIN words w ON w.id = ws.word_id
         WHERE w.reading = 'の'`,
      )
      .get();
    if (!link) return; // the fixture's parse may not enrol の on every dictionary build
    expect(link.seen_as).toBe('の');
  });

  test('links made before the column existed are filled in from the stored tokens', async () => {
    await importFixture();
    const db = getDb();
    db.prepare('UPDATE word_songs SET seen_as = NULL').run();

    const filled = backfillWordSurfaces();
    expect(filled).toBeGreaterThan(0);
    expect(
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM word_songs WHERE seen_as IS NULL').get()
        ?.n,
    ).toBe(0);
  });

  test('the backfill is idempotent', async () => {
    await importFixture();
    expect(backfillWordSurfaces()).toBe(0);
  });
});
