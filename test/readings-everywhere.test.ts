import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { _setDbForTests, getDb } from '../server/db';
import { buildLesson } from '../server/lesson/build';
import * as srs from '../server/srs/store';
import { parsePlain } from '../server/lyrics/lrc';
import { segmentsToReading } from '../server/nlp/furigana';
import { annotateText } from '../server/nlp/annotate';

/**
 * Kanji are decorative for this user: shown, never required. Any surface that
 * displays Japanese must therefore carry a reading — ruby, romaji, or both.
 * These tests cover the surfaces that are easy to forget: multiple-choice
 * options, the trouble-line list, the mistakes report, and the Japanese quoted
 * inside English explanations.
 *
 * Fixture lines are written by hand for these tests.
 */

const FIXTURE = ['夜空に星が光っている', '君の声を探している', '大人になっても忘れない'].join('\n');

const hasKanji = (s: string) => /[一-鿿]/.test(s);

beforeEach(() => {
  _setDbForTests(new Database(':memory:'));
});

afterEach(() => {
  _setDbForTests(null);
});

async function importFixture() {
  return buildLesson({
    title: 'Readings Fixture',
    artist: 'Test Artist',
    source: 'paste',
    lines: parsePlain(FIXTURE),
    raw: FIXTURE,
  });
}

/** Mirrors the choice builder the queue endpoint uses. */
function clozeChoicesFor(cardId: number) {
  const db = getDb();
  const card = srs.getCard(cardId)!;
  const answer = card.back.answer;
  const rows = db
    .query<{ lemma: string; furigana: string; romaji: string }, [string, number]>(
      `SELECT lemma, furigana, romaji FROM words
       WHERE lemma != ? AND length(lemma) BETWEEN 1 AND 6
       ORDER BY abs(priority - 50), RANDOM() LIMIT ?`,
    )
    .all(answer, 3);
  return [
    {
      text: answer,
      furigana: card.back.furigana ?? [],
      romaji: card.back.romaji ?? '',
    },
    ...rows.map((r) => ({
      text: r.lemma,
      furigana: JSON.parse(r.furigana),
      romaji: r.romaji ?? '',
    })),
  ];
}

describe('cloze choices', () => {
  test('every option carries ruby and romaji', async () => {
    await importFixture();
    const cloze = srs.queue({ limit: 50, includeAhead: true }).filter((c) => c.kind === 'cloze');
    expect(cloze.length).toBeGreaterThan(0);

    for (const card of cloze) {
      const choices = clozeChoicesFor(card.id);
      expect(choices.length).toBeGreaterThan(1);
      for (const choice of choices) {
        expect(choice.romaji.length).toBeGreaterThan(0);
        expect(choice.furigana.length).toBeGreaterThan(0);
        // The ruby must actually cover the option's text.
        expect(choice.furigana.map((s: { text: string }) => s.text).join('')).toBe(choice.text);
      }
    }
  });

  test('kanji options are never shown without a reading', async () => {
    await importFixture();
    const cloze = srs.queue({ limit: 50, includeAhead: true }).filter((c) => c.kind === 'cloze');
    for (const card of cloze) {
      for (const choice of clozeChoicesFor(card.id)) {
        if (!hasKanji(choice.text)) continue;
        const reading = segmentsToReading(choice.furigana);
        expect(reading.length).toBeGreaterThan(0);
        expect(hasKanji(reading)).toBe(false);
      }
    }
  });

  test('the correct answer is among the options', async () => {
    await importFixture();
    const cloze = srs.queue({ limit: 50, includeAhead: true }).filter((c) => c.kind === 'cloze');
    for (const card of cloze) {
      const texts = clozeChoicesFor(card.id).map((c) => c.text);
      expect(texts).toContain(card.back.answer);
    }
  });
});

describe('trouble lines', () => {
  test('carry ruby and romaji for the line', async () => {
    await importFixture();
    const card = srs.queue({ limit: 50, includeAhead: true }).find((c) => c.kind === 'cloze')!;
    srs.grade(card.id, 0);
    srs.grade(card.id, 0);

    const lines = srs.troubleLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.furigana.length).toBeGreaterThan(0);
      expect(line.furigana.map((s) => s.text).join('')).toBe(line.text);
      expect(line.romaji.length).toBeGreaterThan(0);
      expect(hasKanji(line.romaji)).toBe(false);
    }
  });
});

describe('prose annotation', () => {
  test('kanji quoted inside an English sentence gets ruby', async () => {
    const text = 'The 已然形 (realis form) of 見回す, used with the classical particle ど.';
    const segments = await annotateText(text);

    // Nothing is lost or reordered: the segments are the sentence.
    expect(segments.map((s) => s.text).join('')).toBe(text);

    const annotated = segments.filter((s) => s.ruby);
    expect(annotated.length).toBeGreaterThan(0);
    // Every kanji in the sentence sits under a reading.
    for (const seg of segments) {
      if (hasKanji(seg.text)) expect(seg.ruby.length).toBeGreaterThan(0);
    }
    // And no reading is itself kanji.
    for (const seg of annotated) expect(hasKanji(seg.ruby)).toBe(false);
  });

  test('text without kanji comes back as one plain segment', async () => {
    expect(await annotateText('look around')).toEqual([{ text: 'look around', ruby: '' }]);
    expect(await annotateText('Contraction of 〜ている.')).toEqual([
      { text: 'Contraction of 〜ている.', ruby: '' },
    ]);
    expect(await annotateText('')).toEqual([]);
  });

  test('compounds keep the reading of the whole word', async () => {
    const segments = await annotateText('大人 means adult.');
    expect(segments[0]).toEqual({ text: '大人', ruby: 'おとな' });
  });
});

describe('mistake report', () => {
  test('word examples come with romaji', async () => {
    await importFixture();
    const vocab = srs
      .queue({ limit: 50, includeAhead: true })
      .filter((c) => c.kind === 'vocab')
      .slice(0, 4);
    // Enough failures on one part of speech to trip the report's threshold.
    for (const card of vocab) {
      srs.grade(card.id, 0);
      srs.grade(card.id, 1);
    }

    const patterns = srs.mistakePatterns();
    expect(patterns.length).toBeGreaterThan(0);
    for (const pattern of patterns) {
      for (const example of pattern.examples) {
        expect(example.text.length).toBeGreaterThan(0);
        if (hasKanji(example.text)) {
          expect(example.romaji.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test('confusion entries keep the two words separate, each with romaji', async () => {
    await importFixture();
    const cloze = srs.queue({ limit: 50, includeAhead: true }).find((c) => c.kind === 'cloze')!;
    srs.grade(cloze.id, 1, 500, '音');
    srs.grade(cloze.id, 1, 500, '音');

    const confusion = srs.mistakePatterns().find((p) => p.kind === 'confusion');
    expect(confusion).toBeTruthy();
    // The Japanese lives in examples, not embedded in the English sentence.
    expect(hasKanji(confusion!.detail)).toBe(false);
    expect(confusion!.examples).toHaveLength(2);
    expect(confusion!.examples[0].text).toBe('音');
  });
});
