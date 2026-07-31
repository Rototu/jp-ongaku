import type { DictEntryLite } from '../../shared/types';
import type { KuromojiToken } from './tokenize';

/** Above this, a word is auto-enrolled into the SRS deck. */
export const ENROLL_THRESHOLD = 40;

/** JMdict sense tags that mark a word as not worth drilling. */
const DEAD_TAGS = new Set(['arch', 'obs', 'obsc', 'rare', 'dated', 'ok', 'oK', 'iK']);

/** POS values that are structural rather than vocabulary. */
const LOW_VALUE_POS = new Set(['助詞', '助動詞', '記号', 'フィラー', '接頭詞']);

/**
 * Frequency contribution, bucketed rather than logarithmic.
 *
 * JMdict's ranks are already coarse buckets, so a smooth curve implies
 * precision that isn't there — and a log curve pushed everyday nouns like 星
 * and 声 below the enrollment line, which is exactly backwards for a learner.
 */
function freqBonus(rank: number | null): number {
  if (rank === null) return 0;
  if (rank <= 1000) return 40;
  if (rank <= 3000) return 32;
  if (rank <= 6000) return 24;
  if (rank <= 10000) return 16;
  if (rank <= 20000) return 8;
  return 2;
}

interface Args {
  token: KuromojiToken;
  entry?: DictEntryLite;
  loanword: boolean;
}

/**
 * 0..100 score for "how much should this word be in your deck".
 *
 * Frequency dominates because it is real data; JLPT level and part of speech
 * nudge. Proper nouns and archaic/rare senses are pushed below the enrollment
 * threshold so song-only poetry stays browsable but doesn't bloat the deck.
 */
export function priorityFor({ token, entry, loanword }: Args): number {
  if (LOW_VALUE_POS.has(token.pos)) return 0;

  let score = 20;

  if (entry) {
    score += freqBonus(entry.freqRank);
    // JMdict's `common` flag already means "appears in a priority list"
    // (ichi/news/spec). It carries more signal than the coarse rank bucket, so
    // it gets the heavier weight — otherwise core one-kanji nouns like 星 and 声
    // score below poetic rarities that happen to have a rank.
    if (entry.common) score += 22;
    if (entry.jlpt !== null) score += (entry.jlpt - 2) * 5; // N5 -> +15, N3 -> +5

    // Only penalise when the word is archaic *as a whole*. 君 carries an
    // archaic "monarch" sense alongside the everyday "you", and judging by any
    // sense would drop it out of the deck entirely.
    const deadSenses = entry.senses.filter((s) =>
      [...s.misc, ...s.info].some((t) => DEAD_TAGS.has(t)),
    ).length;
    if (deadSenses === entry.senses.length) score -= 45;
    else if (deadSenses > 0 && !entry.common) score -= 12;

    if (entry.senses.every((s) => s.pos.includes('unc'))) score -= 20;
  } else {
    // Not in the dictionary at all: usually a name, novel coinage, or the
    // tokenizer mis-split. Not deck material.
    score -= 25;
  }

  if (token.pos === '名詞' && token.pos_detail_1 === '固有名詞') score -= 40;
  if (token.pos === '感動詞') score -= 15;
  if (token.pos === '接続詞') score -= 5;
  if (loanword) score += 6; // katakana loanwords are high-yield for this user

  return Math.max(0, Math.min(100, Math.round(score)));
}

export function shouldEnroll(priority: number): boolean {
  return priority >= ENROLL_THRESHOLD;
}
