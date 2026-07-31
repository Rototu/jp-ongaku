import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { _setDbForTests, getDb } from '../server/db';
import { buildLesson } from '../server/lesson/build';
import { pruneMismatchedGrammarCards } from '../server/lesson/regrade-grammar';
import { PATTERNS, markerPresent } from '../server/nlp/grammar';
import { tokenizeLine } from '../server/nlp/tokenize';
import { parsePlain } from '../server/lyrics/lrc';
import type { CardFront } from '../shared/types';

/**
 * A grammar card must never ask about a form its example does not contain.
 *
 * All Japanese below is written by hand for these tests.
 */

const BY_KEY = new Map(PATTERNS.map((p) => [p.key, p]));

async function keysFor(text: string): Promise<string[]> {
  const tokens = await tokenizeLine(text);
  return tokens.flatMap((t) => t.grammar.map((g) => g.key));
}

describe('pattern detection accuracy', () => {
  test('〜たら is not reported as 〜ば', async () => {
    // 走れ is the potential/hypothetical stem; kuromoji tags it 仮定形, which is
    // the form ば attaches to — but there is no ば here.
    const keys = await keysFor('走れたら聞いて');
    expect(keys).toContain('conditional-tara');
    expect(keys).not.toContain('conditional-ba');
  });

  test('〜ば is still detected when it is really there', async () => {
    expect(await keysFor('続ければ届く')).toContain('conditional-ba');
  });

  test('a bare え-stem claims no conditional at all', async () => {
    const keys = await keysFor('走れ');
    expect(keys).not.toContain('conditional-ba');
    expect(keys).not.toContain('conditional-tara');
  });

  test('volitional needs the actual う, not just the stem it attaches to', async () => {
    expect(await keysFor('だろう')).toContain('volitional');
    expect(await keysFor('綺麗だった')).not.toContain('volitional');
  });

  test('conjugated tails are still recognised', async () => {
    // The auxiliary arrives as a stem: しまっ, いこ, き.
    expect(await keysFor('泣いてしまった')).toContain('te-shimau');
    expect(await keysFor('消えちゃった')).toContain('te-shimau');
    expect(await keysFor('歩いていこう')).toContain('te-iku');
    expect(await keysFor('帰ってきた')).toContain('te-kuru');
  });

  test('negatives and desideratives combine correctly', async () => {
    const keys = await keysFor('食べたくない');
    expect(keys).toContain('tai');
    expect(keys).toContain('negative');
  });

  test('literary negatives are detected', async () => {
    expect(await keysFor('歌わぬ')).toContain('negative');
  });

  test('every pattern a line claims has its marker in that line', async () => {
    const lines = [
      '夜空に星が光っている',
      '走れたら聞いて',
      '続ければ届くだろう',
      '大人になっても忘れない',
      '泣いてしまった',
      '歩いていこう',
      '静かだった',
      '見せてくれた',
      '食べさせる',
      '笑っていたい',
      '消えちゃう',
      '帰ってきて',
    ];
    for (const line of lines) {
      const tokens = await tokenizeLine(line);
      for (const token of tokens) {
        for (const note of token.grammar) {
          const pattern = BY_KEY.get(note.key);
          if (!pattern) continue;
          expect(markerPresent(pattern, token.surface)).toBe(true);
        }
      }
    }
  });
});

describe('marker guard', () => {
  test('rejects a pattern whose form is absent', () => {
    const ba = BY_KEY.get('conditional-ba')!;
    expect(markerPresent(ba, '走れたら')).toBe(false);
    expect(markerPresent(ba, '続ければ')).toBe(true);
  });

  test('patterns carried by inflection alone always pass', () => {
    const imperative = BY_KEY.get('imperative')!;
    expect(imperative.requires).toBeUndefined();
    expect(markerPresent(imperative, '走れ')).toBe(true);
  });

  test('every pattern except the inflection-only ones declares a marker', () => {
    const withoutMarker = PATTERNS.filter((p) => !p.requires).map((p) => p.key);
    expect(withoutMarker).toEqual(['imperative']);
  });
});

describe('generated grammar cards', () => {
  beforeEach(() => {
    _setDbForTests(new Database(':memory:'));
  });

  afterEach(() => {
    _setDbForTests(null);
  });

  const FIXTURE = ['走れたら聞いて', '続ければ届くだろう', '泣いてしまった'].join('\n');

  async function importFixture() {
    return buildLesson({
      title: 'Grammar Fixture',
      artist: 'Test Artist',
      source: 'paste',
      lines: parsePlain(FIXTURE),
      raw: FIXTURE,
    });
  }

  test('no card asks about a form missing from its example', async () => {
    await importFixture();
    const rows = getDb()
      .query<{ front: string; key: string }, []>(
        `SELECT c.front, g.key FROM cards c
         JOIN grammar_items g ON g.id = c.grammar_id WHERE c.kind = 'grammar'`,
      )
      .all();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const pattern = BY_KEY.get(row.key);
      if (!pattern) continue;
      const front = JSON.parse(row.front) as CardFront;
      expect(markerPresent(pattern, front.jp ?? '')).toBe(true);
    }
  });

  test('the prune finds nothing to remove on a freshly built lesson', async () => {
    await importFixture();
    expect(pruneMismatchedGrammarCards().removed).toBe(0);
  });

  test('the prune removes a card whose example lost its pattern', async () => {
    await importFixture();
    const db = getDb();

    // Simulate the old bug: point a 〜ば card at a line containing no ば.
    const card = db
      .query<{ id: number }, []>(
        `SELECT c.id FROM cards c JOIN grammar_items g ON g.id = c.grammar_id
         WHERE c.kind = 'grammar' AND g.key = 'conditional-ba' LIMIT 1`,
      )
      .get();
    expect(card).toBeTruthy();

    db.prepare('UPDATE cards SET front = ? WHERE id = ?').run(
      JSON.stringify({ prompt: 'What does 〜ば do?', jp: '走れたら聞いて' }),
      card!.id,
    );

    const before = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM cards').get()?.n ?? 0;
    const result = pruneMismatchedGrammarCards();
    expect(result.removed).toBe(1);

    const after = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM cards').get()?.n ?? 0;
    expect(after).toBe(before - 1);
    expect(db.query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM cards WHERE id = ?').get(card!.id)?.n).toBe(0);
  });

  test('the prune leaves correct cards and other kinds alone', async () => {
    await importFixture();
    const db = getDb();
    const vocabBefore =
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cards WHERE kind = 'vocab'").get()?.n ?? 0;

    pruneMismatchedGrammarCards();

    const vocabAfter =
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cards WHERE kind = 'vocab'").get()?.n ?? 0;
    expect(vocabAfter).toBe(vocabBefore);
  });
});
