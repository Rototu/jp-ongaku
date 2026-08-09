import type { AnalyzedToken } from './tokenize';

/**
 * Negation, carried from the Japanese into the English gloss.
 *
 * A card whose answer is the inflected surface — the cloze cards, whose answer is
 * 見えない rather than the lemma 見える — used to show the dictionary meaning
 * unchanged, so the reveal for 見えない read "to be seen; to be visible". The
 * ない is the whole point of the line, and dropping it teaches the opposite of
 * what is sung.
 *
 * Only negation is handled. Tense and politeness do not change what a word means,
 * so the dictionary gloss is still true for 見えた; ない makes it false.
 */

/** Does this chunk carry a negative auxiliary? */
export function isNegated(token: Pick<AnalyzedToken, 'grammar'>): boolean {
  return token.grammar.some((note) => note.key === 'negative');
}

/**
 * Negates one English gloss.
 *
 * JMdict writes verbs as infinitives and adjectives bare, and "not" in front of
 * either reads correctly: "not to be seen", "not warm".
 */
export function negateGloss(gloss: string): string {
  const text = gloss.trim();
  return text ? `not ${text}` : text;
}

/** Glosses for a surface form, with its polarity applied. */
export function glossesFor(
  token: Pick<AnalyzedToken, 'grammar' | 'entry'>,
  limit = 3,
): string[] | undefined {
  const glosses = token.entry?.senses.flatMap((s) => s.glosses).slice(0, limit);
  if (!glosses || glosses.length === 0) return undefined;
  return isNegated(token) ? glosses.map(negateGloss) : glosses;
}
