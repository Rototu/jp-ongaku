import { describe, expect, test } from 'bun:test';
import { annotateText, KNOWN_SCOPE } from '../server/nlp/annotate';
import { segmentsToReading } from '../server/nlp/furigana';

/**
 * A song decides its own readings. Once the model has read a word one way in the
 * lyrics, anything quoting that word — a grammar note, an explanation, an example —
 * has to agree with it: the dictionary's reading in the sentence explaining the
 * word is the worst possible place for a contradiction.
 *
 * Fixtures use a real ambiguity (葬 is まいそう as a compound) with an invented
 * stylised reading, in the shape songs actually do it.
 */
describe('annotating prose against a song’s own readings', () => {
  const known = (pairs: [string, string][], scope = '1') => {
    const map = new Map(pairs);
    map.set(KNOWN_SCOPE, scope);
    return map;
  };

  test('a known reading wins over the dictionary', async () => {
    const dictionaryFirst = await annotateText('The verb 埋葬 is used here.');
    const songFirst = await annotateText(
      'The verb 埋葬 is used here.',
      known([['埋葬', 'うめ']]),
    );
    expect(segmentsToReading(dictionaryFirst)).not.toBe(segmentsToReading(songFirst));
    const ruby = songFirst.find((s) => s.text === '埋葬')?.ruby;
    expect(ruby).toBe('うめ');
  });

  test('the longest known surface wins, so a compound is not read in halves', async () => {
    const segments = await annotateText(
      '完全犯罪 appears in the chorus.',
      known([
        ['完全犯罪', 'ひみつ'],
        ['完全', 'かんぜん'],
      ]),
    );
    expect(segments.find((s) => s.text === '完全犯罪')?.ruby).toBe('ひみつ');
  });

  test('words the song says nothing about still get dictionary ruby', async () => {
    const segments = await annotateText('星 and 埋葬', known([['埋葬', 'うめ']]));
    expect(segments.find((s) => s.text === '星')?.ruby).toBe('ほし');
    expect(segments.find((s) => s.text === '埋葬')?.ruby).toBe('うめ');
  });

  test('a known word later in a run does not block the rest', async () => {
    const segments = await annotateText('夜空の埋葬', known([['埋葬', 'うめ']]));
    expect(segmentsToReading(segments)).toContain('よぞら');
    expect(segmentsToReading(segments)).toContain('うめ');
  });

  test('one song’s readings never leak into another’s cache', async () => {
    const first = await annotateText('埋葬', known([['埋葬', 'うめ']], '1'));
    const second = await annotateText('埋葬', known([['埋葬', 'ほうむ']], '2'));
    const plain = await annotateText('埋葬');
    expect(first[0].ruby).toBe('うめ');
    expect(second[0].ruby).toBe('ほうむ');
    expect(plain[0].ruby).not.toBe('うめ');
  });

  test('an empty map behaves exactly like no map', async () => {
    const withEmpty = await annotateText('埋葬', new Map());
    const without = await annotateText('埋葬');
    expect(segmentsToReading(withEmpty)).toBe(segmentsToReading(without));
  });
});
