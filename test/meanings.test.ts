import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { _setDbForTests } from '../server/db';
import { buildLesson } from '../server/lesson/build';
import { parsePlain } from '../server/lyrics/lrc';
import * as srs from '../server/srs/store';
import { tokenizeLine } from '../server/nlp/tokenize';
import { glossesFor, isNegated, negateGloss } from '../server/nlp/polarity';
import type { Card } from '../shared/types';

/**
 * What a card says a word means.
 *
 * Two failures behind these: a kana-written verb resolving to a homophonous noun
 * (きいて glossed "chrysanthemum", from 菊), and an inflected negative carrying
 * its positive dictionary meaning (見えない glossed "to be visible"). All Japanese
 * here is written by hand for the test.
 */

beforeEach(() => {
  _setDbForTests(new Database(':memory:'));
});

afterEach(() => {
  _setDbForTests(null);
});

async function cardsFor(text: string): Promise<Card[]> {
  const song = await buildLesson({
    title: 'Meaning Song',
    artist: 'Test Artist',
    source: 'paste',
    lines: parsePlain(text),
    raw: text,
  });
  return srs.queue({ songId: song.songId, limit: 200, includeAhead: true });
}

describe('word class', () => {
  test('a kana-written verb resolves to the verb, not a homophonous noun', async () => {
    const tokens = await tokenizeLine('きいて');
    const entry = tokens[0]?.entry;
    expect(entry?.headword).toBe('聞く');
  });

  test('kana spellings that used to resolve to the wrong entry still hold', async () => {
    const iu = await tokenizeLine('いつか');
    expect(iu[0]?.entry?.headword).toBe('何時か');
    const naru = await tokenizeLine('なる');
    expect(naru[0]?.entry?.headword).toBe('成る');
  });
});

describe('negation', () => {
  test('a negated chunk is recognised and its gloss flipped', async () => {
    const tokens = await tokenizeLine('見えない');
    const token = tokens[0]!;
    expect(isNegated(token)).toBe(true);
    expect(glossesFor(token)?.[0]).toBe('not to be seen');
  });

  test('an affirmative chunk keeps the dictionary gloss', async () => {
    const tokens = await tokenizeLine('見える');
    expect(isNegated(tokens[0]!)).toBe(false);
    expect(glossesFor(tokens[0]!)?.[0]).toBe('to be seen');
  });

  test('negateGloss reads correctly for verbs and adjectives', () => {
    expect(negateGloss('to be visible')).toBe('not to be visible');
    expect(negateGloss('warm')).toBe('not warm');
  });

  test('a cloze card on a negative surface says so on its back', async () => {
    const cards = await cardsFor('見えない星を探している');
    const cloze = cards.find((c) => c.kind === 'cloze' && c.back.answer === '見えない');
    expect(cloze).toBeTruthy();
    expect(cloze!.back.glosses?.[0]?.startsWith('not ')).toBe(true);
    expect(cloze!.back.note).toContain('Negative form of 見える');
  });

  test('a vocab card still asks about the dictionary form', async () => {
    const cards = await cardsFor('見えない星を探している');
    const vocab = cards.find((c) => c.kind === 'vocab' && c.front.jp === '見える');
    expect(vocab).toBeTruthy();
    // The lemma's own meaning is not negated — the card is asking about 見える.
    expect(vocab!.back.answer.startsWith('to be seen')).toBe(true);
    expect(vocab!.back.note).toContain('見えない');
  });
});
