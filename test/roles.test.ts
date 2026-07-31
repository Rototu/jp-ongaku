import { describe, expect, test } from 'bun:test';
import { OTHER_COLOR_IDX, ROLE_CATEGORIES, roleCategory } from '../shared/roles';

/**
 * Hue is the grammar channel, so a role landing in the wrong category is a
 * wrong lesson, not a cosmetic slip. Most of these cases exist because the
 * category words contain each other as substrings.
 */

const key = (role: string) => roleCategory(role).key;

describe('role classification', () => {
  test('reads the model\'s English roles', () => {
    expect(key('noun (subject)')).toBe('noun');
    expect(key('verb, progressive')).toBe('verb');
    expect(key('particle (topic)')).toBe('particle');
    expect(key('topic particle')).toBe('particle');
    expect(key('い-adjective')).toBe('adjective');
    expect(key('na-adjective, attributive')).toBe('adjective');
    expect(key('pronoun (second person)')).toBe('pronoun');
    expect(key('set expression')).toBe('expression');
    expect(key('determiner (attributive)')).toBe('adjective');
    expect(key('adverbial phrase')).toBe('other');
    expect(key('sentence-ending particle')).toBe('particle');
  });

  test('reads the offline parse\'s IPADIC tags', () => {
    expect(key('名詞 一般')).toBe('noun');
    expect(key('動詞 自立')).toBe('verb');
    expect(key('助詞 格助詞')).toBe('particle');
    expect(key('形容詞 自立')).toBe('adjective');
    expect(key('名詞 代名詞')).toBe('pronoun');
    expect(key('感動詞')).toBe('expression');
  });

  test('does not let one category word swallow another', () => {
    // "pronoun" contains "noun".
    expect(key('pronoun')).toBe('pronoun');
    // "adverb" and "auxiliary verb" both contain "verb".
    expect(key('adverb')).toBe('other');
    expect(key('副詞')).toBe('other');
    expect(key('auxiliary verb')).toBe('particle');
    expect(key('助動詞')).toBe('particle');
    // 形容動詞 and 感動詞 both contain 動詞.
    expect(key('形容動詞 語幹')).toBe('adjective');
    expect(key('感動詞')).toBe('expression');
    // ...and "verb phrase" must not be dragged off by "phrase".
    expect(key('verb phrase')).toBe('verb');
  });

  test('classifies a word-plus-particle chunk by the word', () => {
    expect(key('noun + subject particle')).toBe('noun');
    expect(key('pronoun + subject particle')).toBe('pronoun');
    // Nothing but glue in this one, so glue is what it is.
    expect(key('nominalizer + topic particle')).toBe('particle');
  });

  test('an unknown or missing role is other, never a real category', () => {
    expect(key('')).toBe('other');
    expect(key('   ')).toBe('other');
    expect(key('emphatic sentence-ender')).toBe('other');
    expect(roleCategory('').colorIdx).toBe(OTHER_COLOR_IDX);
  });

  test('every category has its own slot', () => {
    const slots = ROLE_CATEGORIES.map((c) => c.colorIdx);
    expect(new Set(slots).size).toBe(ROLE_CATEGORIES.length);
    // Contiguous from 0, because the slots are `c0`..`cN` in the stylesheet.
    expect(slots.slice().sort((a, b) => a - b)).toEqual(
      ROLE_CATEGORIES.map((_, i) => i),
    );
  });
});
