/**
 * Grammar role → colour, the one place that mapping lives.
 *
 * Hue is a *meaning* channel: every noun in the song is the same blue, every
 * particle the same teal, so a line can be taken apart by shape before any of
 * it is understood. Mastery is the separate bar underneath, which is why a word
 * met for the first time still gets its real colour instead of a "new" grey.
 *
 * Roles arrive as free English text from the model ("noun (subject)", "verb,
 * progressive") and as kuromoji IPADIC tags from the offline parse (名詞, 助詞),
 * so both vocabularies are matched here.
 */

export type RoleKey =
  | 'noun'
  | 'pronoun'
  | 'verb'
  | 'adjective'
  | 'particle'
  | 'expression'
  | 'other';

export interface RoleCategory {
  key: RoleKey;
  /** Legend label, and the word the model is asked to lead its role with. */
  label: string;
  /** Palette slot; drives the `c{n}` class in the stylesheet. */
  colorIdx: number;
}

export const ROLE_CATEGORIES: RoleCategory[] = [
  { key: 'noun', label: 'noun', colorIdx: 0 },
  { key: 'verb', label: 'verb', colorIdx: 1 },
  { key: 'particle', label: 'particle', colorIdx: 2 },
  { key: 'adjective', label: 'adjective', colorIdx: 3 },
  { key: 'pronoun', label: 'pronoun', colorIdx: 4 },
  { key: 'expression', label: 'expression', colorIdx: 5 },
  { key: 'other', label: 'other', colorIdx: 6 },
];

/** Slot used when a role matches nothing, and for an empty role. */
export const OTHER_COLOR_IDX = 6;

/**
 * Ordered because these patterns overlap as substrings: "pronoun" contains
 * "noun", "adverb" and "auxiliary verb" contain "verb", 形容動詞 and 助動詞 both
 * contain 動詞. First match wins, so the narrower rule comes first.
 */
const RULES: [RegExp, RoleKey][] = [
  [/pronoun|代名詞/i, 'pronoun'],
  // Grammar glue rather than vocabulary: case particles, の as a nominaliser,
  // だ/です, ～ます, ～ない.
  [/particle|marker|copula|auxiliary|nominali[sz]er|助詞|助動詞/i, 'particle'],
  // Before the verb rule, which "adverb" would otherwise satisfy.
  [/adverb|副詞/i, 'other'],
  // Determiners (この, あの) are 連体詞: attributive, so they read as adjectives.
  [/adjectiv|i-adj|na-adj|determiner|形容詞|形容動詞|連体詞/i, 'adjective'],
  // Also before the verb rule: 感動詞 contains 動詞. "phrase" is deliberately not
  // matched on its own, or "verb phrase" would land here.
  [/expression|idiom|set phrase|interjection|conjunction|感動詞|接続詞/i, 'expression'],
  [/verb|動詞/i, 'verb'],
  [/noun|name|counter|number|suffix|prefix|名詞|数詞|接頭詞|接尾/i, 'noun'],
];

/** The category a role text falls into. Unrecognised and empty roles are 'other'. */
export function roleCategory(role: string): RoleCategory {
  // A chunk holding a word and its particle is described as "noun + subject
  // particle"; it is the word that should pick the colour, so only the head of
  // such a role is classified.
  const text = (role ?? '').split('+')[0].trim();
  if (text) {
    for (const [pattern, key] of RULES) {
      if (pattern.test(text)) return byKey(key);
    }
  }
  return byKey('other');
}

/** Palette slot for a role text. */
export function roleColorIdx(role: string): number {
  return roleCategory(role).colorIdx;
}

function byKey(key: RoleKey): RoleCategory {
  return ROLE_CATEGORIES.find((c) => c.key === key) as RoleCategory;
}
