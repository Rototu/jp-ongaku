import { toKana } from 'wanakana';

/**
 * Typed reading answers: what the user typed, made comparable to what the
 * dictionary says.
 *
 * The learner types romaji or kana — both are legitimate ways to produce
 * Japanese on a keyboard — and WanaKana turns the romaji into kana. The
 * comparison then forgives exactly the things that are conventions rather than
 * knowledge, and nothing else:
 *
 * - long vowels canonicalize to one spelling: とー, とう and romaji "too" all
 *   become とお; けー, けい and "kee" become けえ. Only the vowel length is
 *   knowledge — which spelling convention produced it is not.
 * - small kana fold to their full forms (ゃ→や), so しや passes for しゃ;
 * - katakana folds to hiragana, so a loanword typed back in romaji matches;
 * - whitespace and Japanese punctuation are dropped.
 *
 * Deliberately NOT folded: は/わ (the particle reading of は is knowledge, not a
 * convention — typing こんにちわ for こんにちは is a miss worth seeing), and
 * historical ゐ/ゑ (if a song wants those, they get typed).
 */

/**
 * Which kana a ー after this character becomes — the *canonical* vowel, so the
 * expansion lands in the same form the written long vowels fold to.
 */
const LONG_VOWEL_AFTER: Record<string, string> = {
  // hiragana, by vowel column
  'あ': 'あ', 'か': 'あ', 'さ': 'あ', 'た': 'あ', 'な': 'あ', 'は': 'あ', 'ま': 'あ', 'や': 'あ',
  'ら': 'あ', 'わ': 'あ', 'が': 'あ', 'ざ': 'あ', 'だ': 'あ', 'ば': 'あ', 'ぱ': 'あ',
  'ぁ': 'あ', 'ゃ': 'あ',
  'い': 'い', 'き': 'い', 'し': 'い', 'ち': 'い', 'に': 'い', 'ひ': 'い', 'み': 'い', 'り': 'い',
  'ぎ': 'い', 'じ': 'い', 'ぢ': 'い', 'び': 'い', 'ぴ': 'い', 'ぃ': 'い',
  'う': 'う', 'く': 'う', 'す': 'う', 'つ': 'う', 'ぬ': 'う', 'ふ': 'う', 'む': 'う', 'ゆ': 'う',
  'る': 'う', 'ぐ': 'う', 'ず': 'う', 'づ': 'う', 'ぶ': 'う', 'ぷ': 'う', 'ぅ': 'う',
  'ゅ': 'う', 'っ': 'う', 'ゔ': 'う',
  'え': 'え', 'け': 'え', 'せ': 'え', 'て': 'え', 'ね': 'え', 'へ': 'え', 'め': 'え', 'れ': 'え',
  'げ': 'え', 'ぜ': 'え', 'で': 'え', 'べ': 'え', 'ぺ': 'え', 'ぇ': 'え',
  'お': 'お', 'こ': 'お', 'そ': 'お', 'と': 'お', 'の': 'お', 'ほ': 'お', 'も': 'お', 'よ': 'お',
  'ろ': 'お', 'を': 'お', 'ご': 'お', 'ぞ': 'お', 'ど': 'お', 'ぼ': 'お', 'ぽ': 'お',
  'ぉ': 'お', 'ょ': 'お',
  'ん': 'ん',
  // katakana mirrors
  'ア': 'ア', 'カ': 'ア', 'サ': 'ア', 'タ': 'ア', 'ナ': 'ア', 'ハ': 'ア', 'マ': 'ア', 'ヤ': 'ア',
  'ラ': 'ア', 'ワ': 'ア', 'ガ': 'ア', 'ザ': 'ア', 'ダ': 'ア', 'バ': 'ア', 'パ': 'ア',
  'ァ': 'ア', 'ャ': 'ア',
  'イ': 'イ', 'キ': 'イ', 'シ': 'イ', 'チ': 'イ', 'ニ': 'イ', 'ヒ': 'イ', 'ミ': 'イ', 'リ': 'イ',
  'ギ': 'イ', 'ジ': 'イ', 'ヂ': 'イ', 'ビ': 'イ', 'ピ': 'イ', 'ィ': 'イ',
  'ウ': 'ウ', 'ク': 'ウ', 'ス': 'ウ', 'ツ': 'ウ', 'ヌ': 'ウ', 'フ': 'ウ', 'ム': 'ウ', 'ユ': 'ウ',
  'ル': 'ウ', 'グ': 'ウ', 'ズ': 'ウ', 'ヅ': 'ウ', 'ブ': 'ウ', 'プ': 'ウ', 'ゥ': 'ウ',
  'ュ': 'ウ', 'ッ': 'ウ', 'ヴ': 'ウ',
  'エ': 'エ', 'ケ': 'エ', 'セ': 'エ', 'テ': 'エ', 'ネ': 'エ', 'ヘ': 'エ', 'メ': 'エ', 'レ': 'エ',
  'ゲ': 'エ', 'ゼ': 'エ', 'デ': 'エ', 'ベ': 'エ', 'ペ': 'エ', 'ェ': 'エ',
  'オ': 'オ', 'コ': 'オ', 'ソ': 'オ', 'ト': 'オ', 'ノ': 'オ', 'ホ': 'オ', 'モ': 'オ', 'ヨ': 'オ',
  'ロ': 'オ', 'ヲ': 'オ', 'ゴ': 'オ', 'ゾ': 'オ', 'ド': 'オ', 'ボ': 'オ', 'ポ': 'オ',
  'ォ': 'オ', 'ョ': 'オ',
  'ン': 'ン',
};

const SMALL_TO_FULL: Record<string, string> = {
  'ぁ': 'あ', 'ぃ': 'い', 'ぅ': 'う', 'ぇ': 'え', 'ぉ': 'お',
  'ゃ': 'や', 'ゅ': 'ゆ', 'ょ': 'よ', 'っ': 'つ', 'ゎ': 'わ',
  'ァ': 'ア', 'ィ': 'イ', 'ゥ': 'ウ', 'ェ': 'エ', 'ォ': 'オ',
  'ャ': 'ヤ', 'ュ': 'ユ', 'ョ': 'ヨ', 'ッ': 'ツ', 'ヮ': 'ワ',
};

/** Expands ー, then folds the written long vowels おう→おお and えい→ええ. */
function canonicalizeLongVowels(reading: string): string {
  let out = '';
  for (const ch of reading) {
    if (ch === 'ー') {
      out += LONG_VOWEL_AFTER[out.slice(-1)] ?? '';
      continue;
    }
    const prev = out.slice(-1);
    // Written long vowels are one more spelling of the same length: とう and
    // とお both fold to とお, けい and けえ both fold to けえ. Only う after an
    // お-row kana and い after an え-row kana carry the convention.
    if (ch === 'う' && prev && LONG_VOWEL_AFTER[prev] === 'お') {
      out += 'お';
      continue;
    }
    if (ch === 'い' && prev && LONG_VOWEL_AFTER[prev] === 'え') {
      out += 'え';
      continue;
    }
    out += ch;
  }
  return out;
}

/** Katakana → hiragana, so a loanword typed back in romaji still matches. */
function foldKatakana(reading: string): string {
  let out = '';
  for (const ch of reading) {
    const code = ch.codePointAt(0)!;
    out += code >= 0x30a1 && code <= 0x30f6 ? String.fromCodePoint(code - 0x60) : ch;
  }
  return out;
}

/** A reading with the conventions stripped, ready to compare. */
export function normalizeReading(reading: string): string {
  return [...foldKatakana(canonicalizeLongVowels(reading))]
    .map((ch) => SMALL_TO_FULL[ch] ?? ch)
    .join('')
    .replace(/[\s\u3000・。、，,.!?！？'’"「」『』（）()]/g, '');
}

/** Whatever the user typed, as kana. Romaji in, kana out; kana passes through. */
export function typedToKana(raw: string): string {
  return toKana(raw.trim());
}

/** One piece of a diff strip: shared text, or text that differs. */
export interface ReadingDiffPart {
  text: string;
  wrong: boolean;
}

export interface ReadingCheck {
  correct: boolean;
  /** The expected reading, normalized, split for display. */
  expected: ReadingDiffPart[];
  /** What was typed, normalized, split for display. */
  typed: ReadingDiffPart[];
}

/**
 * Compares a typed answer against the expected reading.
 *
 * The diff is prefix/suffix trimmed, which for words — readings are short —
 * marks exactly the wrong middle: the shared head and tail come back as plain
 * parts, the differing middles as wrong, so the learner sees which characters
 * they missed rather than a red blob over the whole word.
 */
export function checkReading(expectedReading: string, rawTyped: string): ReadingCheck {
  const expected = normalizeReading(expectedReading);
  const typed = normalizeReading(typedToKana(rawTyped));

  let start = 0;
  while (start < expected.length && start < typed.length && expected[start] === typed[start]) {
    start++;
  }
  let endE = expected.length;
  let endT = typed.length;
  while (endE > start && endT > start && expected[endE - 1] === typed[endT - 1]) {
    endE--;
    endT--;
  }

  const parts = (s: string, from: number, to: number): ReadingDiffPart[] => {
    const out: ReadingDiffPart[] = [];
    if (from > 0) out.push({ text: s.slice(0, from), wrong: false });
    if (to > from) out.push({ text: s.slice(from, to), wrong: true });
    if (s.length > to) out.push({ text: s.slice(to), wrong: false });
    return out;
  };

  return {
    correct: expected === typed,
    expected: parts(expected, start, endE),
    typed: parts(typed, start, endT),
  };
}
