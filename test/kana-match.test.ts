import { describe, expect, test } from 'bun:test';
import { checkReading, normalizeReading, typedToKana } from '../shared/kana';

/**
 * The typed-answer comparison: forgiving exactly the keyboard conventions and
 * nothing that is actually knowledge.
 */

describe('turning what was typed into kana', () => {
  test('romaji becomes kana', () => {
    expect(typedToKana('sagasu')).toBe('さがす');
    expect(typedToKana('ryoko')).toBe('りょこ');
  });

  test('kana passes through untouched', () => {
    expect(typedToKana('さがす')).toBe('さがす');
  });

  test('a lone trailing n still becomes ん', () => {
    expect(typedToKana('hon')).toBe('ほん');
    expect(typedToKana('shin')).toBe('しん');
  });

  test('mixed input keeps its kana and converts its romaji', () => {
    expect(typedToKana('さgaす')).toBe('さがす');
  });
});

describe('normalizing a reading for comparison', () => {
  test('small kana fold to their full forms', () => {
    expect(normalizeReading('しや')).toBe(normalizeReading('しゃ'));
  });

  test('the long-vowel mark expands to the written long vowel', () => {
    expect(normalizeReading('おかーさん')).toBe(normalizeReading('おかあさん'));
    expect(normalizeReading('とーきょー')).toBe(normalizeReading('とうきょう'));
    expect(normalizeReading('ビール')).toBe(normalizeReading('ビイル'));
  });

  test('spacing and punctuation drop out', () => {
    expect(normalizeReading('とうきょう ')).toBe(normalizeReading('とう きょう。'));
  });

  test('は and わ stay distinct — the particle reading is knowledge', () => {
    expect(normalizeReading('こんにちわ')).not.toBe(normalizeReading('こんにちは'));
  });

  test('っ folds like the other small kana', () => {
    expect(normalizeReading('がつこう')).toBe(normalizeReading('がっこう'));
  });
});

describe('checking an answer', () => {
  test('an exact romaji rendering of the reading passes', () => {
    const c = checkReading('さがす', 'sagasu');
    expect(c.correct).toBe(true);
  });

  test('kana typed directly passes', () => {
    expect(checkReading('ほし', 'ほし').correct).toBe(true);
  });

  test('a wrong reading fails and the diff marks the middle', () => {
    const c = checkReading('ほし', 'hune'); // ふね — right shape, wrong word
    expect(c.correct).toBe(false);
    const typedWrong = c.typed.filter((p) => p.wrong).map((p) => p.text).join('');
    expect(typedWrong).toBe('ふね');
    const expectedWrong = c.expected.filter((p) => p.wrong).map((p) => p.text).join('');
    expect(expectedWrong).toBe('ほし');
  });

  test('one character off marks exactly that character', () => {
    const c = checkReading('やさしい', 'yasashin'); // やさしん
    expect(c.correct).toBe(false);
    const expectedWrong = c.expected.filter((p) => p.wrong).map((p) => p.text).join('');
    expect(expectedWrong).toBe('い');
    const typedWrong = c.typed.filter((p) => p.wrong).map((p) => p.text).join('');
    expect(typedWrong).toBe('ん');
    // The shared prefix stays plain — it is not part of the miss.
    expect(c.expected[0]).toEqual({ text: 'やさし', wrong: false });
  });

  test('a first-character miss keeps the shared tail plain', () => {
    const c = checkReading('あさひ', 'yasahi'); // やさひ
    expect(c.correct).toBe(false);
    const expectedWrong = c.expected.filter((p) => p.wrong).map((p) => p.text).join('');
    expect(expectedWrong).toBe('あ');
    const typedWrong = c.typed.filter((p) => p.wrong).map((p) => p.text).join('');
    expect(typedWrong).toBe('や');
    const tail = c.expected[c.expected.length - 1];
    expect(tail.wrong).toBe(false);
    expect(tail.text).toBe('さひ');
  });

  test('long-vowel conventions pass in every direction', () => {
    // ー, the written long vowel, and romaji "oo" are one convention.
    expect(checkReading('しゃー', 'syaa').correct).toBe(true);
    expect(checkReading('とーきょー', 'tookyoo').correct).toBe(true);
    expect(checkReading('とうきょう', 'tookyoo').correct).toBe(true);
    expect(checkReading('ビール', 'biiru').correct).toBe(true);
  });

  test('a genuinely short reading does not pass for a long one', () => {
    expect(checkReading('しゃー', 'sha').correct).toBe(false);
  });
});
