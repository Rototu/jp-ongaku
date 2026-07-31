import { toHiragana, toRomaji as wkToRomaji, isKana, isKatakana } from 'wanakana';

const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々]/;

export function isKanjiChar(ch: string): boolean {
  return KANJI_RE.test(ch);
}

export function hasKanji(s: string): boolean {
  return [...s].some(isKanjiChar);
}

/**
 * Kana form of tokenizer output. Latin text is passed through untouched, since
 * a surface like "TV" is not a mis-typed reading.
 */
export function hiragana(s: string): string {
  return toHiragana(s, { passRomaji: true });
}

/**
 * Kana from user input, which may be typed as romaji.
 * Unlike `hiragana`, this converts "gurenge" into ぐれんげ — the point is to
 * accept whichever form the user finds easier to type.
 */
export function readingToKana(s: string): string {
  return toHiragana(s.trim());
}

/**
 * Learner-facing romaji. Wanakana produces Hepburn-ish output; we keep long
 * vowels written out (ou, uu) rather than macrons because that matches the
 * kana the user is reading, which is the point of the romaji here.
 */
export function toRomaji(s: string): string {
  if (!s) return '';
  return wkToRomaji(hiragana(s)).replace(/\s+/g, ' ').trim();
}

export { isKana, isKatakana };

/** Katakana-only words are usually loanwords — worth flagging for drills. */
export function isLoanword(surface: string): boolean {
  const chars = [...surface].filter((c) => c !== 'ー' && c.trim() !== '');
  return chars.length > 1 && chars.every((c) => isKatakana(c));
}
