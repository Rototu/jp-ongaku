import type { GrammarNote } from '../../shared/types';
import type { KuromojiToken } from './tokenize';

/**
 * Grammar patterns detected from a merged chunk's token sequence.
 *
 * Each entry is checked against the chunk's suffix tokens (everything after the
 * head word). `match` receives the suffix surfaces plus the raw tokens so it
 * can look at part-of-speech when surface alone is ambiguous.
 */
export interface Pattern {
  key: string;
  pattern: string;
  explanation: string;
  jlpt: number | null;
  match: (ctx: MatchCtx) => boolean;
  /**
   * Literal forms that must appear in the text for this pattern to be claimed.
   * Any one of them is enough.
   *
   * This is a guard rail, not the matcher. Inflected stems are named after the
   * particle that attaches to them — kuromoji calls 走れ 仮定形, the form ば
   * follows — so matching on the form alone claimed 〜ば for 走れたら, which
   * contains no ば at all. A card that asks about a form the line does not
   * contain is worse than no card, so the marker is checked independently of
   * whatever `match` decided.
   *
   * Omitted for patterns carried purely by inflection (imperative), which have
   * no literal marker to look for.
   */
  requires?: string[];
}

export interface SuffixToken {
  surface: string;
  pos: string;
  posDetail: string;
  form: string;
}

export interface MatchCtx {
  /** Surfaces of the suffix tokens, in order. */
  suffix: string[];
  /** Suffix tokens with their part of speech, for pos-aware checks. */
  suffixTokens: SuffixToken[];
  /** The whole chunk's raw tokens (head first). */
  tokens: KuromojiToken[];
  /** Concatenated chunk surface. */
  text: string;
}

const has = (ctx: MatchCtx, ...seq: string[]): boolean => {
  const s = ctx.suffix;
  for (let i = 0; i + seq.length <= s.length; i++) {
    if (seq.every((x, j) => s[i + j] === x)) return true;
  }
  return false;
};

const suffixHas = (ctx: MatchCtx, x: string) => ctx.suffix.includes(x);

/**
 * A suffix token with this surface that is genuinely a grammatical ending —
 * an auxiliary, a particle, or a dependent verb/adjective.
 *
 * Bare-surface matching is too loose for short forms: た, ん and う also occur
 * as parts of ordinary words, and claiming "past tense" because some token
 * happens to read た is how nonsense cards get made.
 */
const hasEnding = (ctx: MatchCtx, surface: string): boolean =>
  ctx.suffixTokens.some(
    (t) =>
      t.surface === surface &&
      (t.pos === '助動詞' ||
        t.pos === '助詞' ||
        t.posDetail.includes('非自立') ||
        t.posDetail.includes('接尾')),
  );

const conjForm = (ctx: MatchCtx, form: string) =>
  ctx.tokens.some((t) => t.conjugated_form === form);

export const PATTERNS: Pattern[] = [
  {
    key: 'te-iru',
    pattern: '〜ている / 〜てる',
    explanation:
      'Progressive or resulting state — "is ~ing" or "has become ~". 〜てる is the contracted spoken form, extremely common in songs.',
    jlpt: 5,
    match: (c) =>
      has(c, 'て', 'いる') || has(c, 'て', 'い') || has(c, 'で', 'いる') ||
      suffixHas(c, 'てる') || suffixHas(c, 'でる') || has(c, 'て', 'る'),
    requires: ['てい', 'でい', 'てる', 'でる'],
  },
  {
    key: 'te-shimau',
    pattern: '〜てしまう / 〜ちゃう',
    explanation:
      'Ends up doing / does completely — often with regret. 〜ちゃう is the casual contraction.',
    jlpt: 4,
    // Conjugated tails are their own tokens, so the stems have to be listed:
    // 〜てしまった arrives as しまっ, not しまう.
    match: (c) =>
      ['しまう', 'しまっ', 'しまい', 'しま'].some((x) => has(c, 'て', x) || has(c, 'で', x)) ||
      ['ちゃう', 'ちゃっ', 'ちゃい', 'じゃう', 'じゃっ'].some((x) => suffixHas(c, x)),
    requires: ['てしま', 'でしま', 'ちゃう', 'ちゃっ', 'ちゃい', 'じゃう', 'じゃっ'],
  },
  {
    key: 'te-iku',
    pattern: '〜ていく',
    explanation: 'Action moving away or continuing onward from now — "go on ~ing".',
    jlpt: 4,
    match: (c) =>
      ['いく', 'いっ', 'いこ', 'いき', 'ゆく', 'ゆっ', 'ゆこ'].some(
        (x) => has(c, 'て', x) || has(c, 'で', x),
      ),
    requires: ['ていく', 'ていっ', 'ていこ', 'ていき', 'てゆく', 'てゆっ', 'てゆこ', 'でいく', 'でいこ'],
  },
  {
    key: 'te-kuru',
    pattern: '〜てくる',
    explanation: 'Action moving toward the speaker, or building up until now — "come to ~".',
    jlpt: 4,
    match: (c) =>
      ['くる', 'き', 'きた', 'こ', 'こい'].some((x) => has(c, 'て', x) || has(c, 'で', x)),
    requires: ['てくる', 'てき', 'てこ', 'でくる', 'でき', 'でこ'],
  },
  {
    key: 'te-kureru',
    pattern: '〜てくれる / 〜てもらう / 〜てあげる',
    explanation:
      'Doing something for someone. くれる = they do it for me, もらう = I receive it, あげる = I do it for them.',
    jlpt: 4,
    match: (c) =>
      has(c, 'て', 'くれる') || has(c, 'て', 'もらう') || has(c, 'て', 'あげる') ||
      has(c, 'て', 'くれ'),
    requires: ['てくれ', 'てもら', 'てあげ'],
  },
  {
    key: 'te-miru',
    pattern: '〜てみる',
    explanation: 'Try doing something to see how it goes.',
    jlpt: 4,
    match: (c) => has(c, 'て', 'みる') || has(c, 'て', 'み'),
    requires: ['てみ'],
  },
  {
    key: 'te-oku',
    pattern: '〜ておく',
    explanation: 'Do something in advance and leave it that way.',
    jlpt: 4,
    match: (c) => has(c, 'て', 'おく') || has(c, 'て', 'おこ'),
    requires: ['ておく', 'ておこ'],
  },
  {
    key: 'te-aru',
    pattern: '〜てある',
    explanation: 'Something has been done and remains in that state.',
    jlpt: 3,
    match: (c) => has(c, 'て', 'ある'),
    requires: ['てある'],
  },
  {
    key: 'tai',
    pattern: '〜たい',
    explanation: 'Want to do something (speaker\'s own desire).',
    jlpt: 5,
    match: (c) => suffixHas(c, 'たい') || suffixHas(c, 'たく') || suffixHas(c, 'たかっ'),
    requires: ['たい', 'たく', 'たかっ'],
  },
  {
    key: 'negative',
    pattern: '〜ない / 〜ぬ',
    explanation: 'Plain negative. 〜ぬ and 〜ず are literary negatives common in lyrics.',
    jlpt: 5,
    // The one-kana negatives must be real auxiliaries, not any token that
    // happens to read ん, ぬ or ず.
    match: (c) =>
      suffixHas(c, 'ない') || suffixHas(c, 'なく') || suffixHas(c, 'なかっ') ||
      hasEnding(c, 'ぬ') || hasEnding(c, 'ず') || hasEnding(c, 'ん'),
    requires: ['ない', 'なく', 'なかっ', 'ぬ', 'ず', 'ん'],
  },
  {
    key: 'past',
    pattern: '〜た',
    explanation: 'Past tense (plain).',
    jlpt: 5,
    match: (c) => hasEnding(c, 'た') || (hasEnding(c, 'だ') && conjForm(c, '連用タ接続')),
    requires: ['た', 'だ'],
  },
  {
    key: 'volitional',
    pattern: '〜う / 〜よう',
    explanation: 'Volitional — "let\'s ~" or "I think I\'ll ~". Also used for intent in lyrics.',
    jlpt: 4,
    // 未然ウ接続 names the stem う attaches to, so it cannot stand alone as
    // evidence: the う itself has to be there.
    match: (c) => hasEnding(c, 'う') || hasEnding(c, 'よう'),
    requires: ['う', 'よう'],
  },
  {
    key: 'passive-potential',
    pattern: '〜れる / 〜られる',
    explanation:
      'Passive ("is done to") or potential ("can do"). Context decides which; with を it is usually potential.',
    jlpt: 4,
    match: (c) => suffixHas(c, 'れる') || suffixHas(c, 'られる') || suffixHas(c, 'れ') && suffixHas(c, 'ない'),
    requires: ['れる', 'られ', 'れな'],
  },
  {
    key: 'causative',
    pattern: '〜せる / 〜させる',
    explanation: 'Causative — make or let someone do something.',
    jlpt: 4,
    match: (c) => suffixHas(c, 'せる') || suffixHas(c, 'させる') || suffixHas(c, 'させ'),
    requires: ['せる', 'させ'],
  },
  {
    key: 'imperative',
    pattern: '〜ろ / 〜え (command)',
    explanation: 'Blunt command form. Frequent in anime openings for dramatic effect.',
    jlpt: 4,
    match: (c) => conjForm(c, '命令ｅ') || conjForm(c, '命令ｒｏ') || conjForm(c, '命令ｉ'),
  },
  {
    key: 'conditional-ba',
    pattern: '〜ば',
    explanation: 'Conditional — "if ~ then". Emphasises the condition being met.',
    jlpt: 4,
    // 仮定形 is the *stem* ば attaches to, and kuromoji tags it on any え-stem —
    // including the potential 走れ in 走れたら, which has no ば. Requiring the
    // particle itself is the whole fix.
    match: (c) => hasEnding(c, 'ば'),
    requires: ['ば'],
  },
  {
    key: 'conditional-tara',
    pattern: '〜たら',
    explanation: 'Conditional — "if / when ~ happens". More conversational than 〜ば.',
    jlpt: 5,
    match: (c) => suffixHas(c, 'たら') || has(c, 'た', 'ら'),
    requires: ['たら', 'だら'],
  },
  {
    key: 'nagara',
    pattern: '〜ながら',
    explanation: 'While doing two things at once.',
    jlpt: 4,
    match: (c) => suffixHas(c, 'ながら'),
    requires: ['ながら'],
  },
  {
    key: 'temo',
    pattern: '〜ても',
    explanation: 'Even if / no matter how.',
    jlpt: 4,
    match: (c) => has(c, 'て', 'も') || has(c, 'で', 'も'),
    requires: ['ても', 'でも'],
  },
  {
    key: 'sou-da',
    pattern: '〜そう',
    explanation: 'Looks like / seems (based on appearance).',
    jlpt: 4,
    match: (c) => suffixHas(c, 'そう'),
    requires: ['そう'],
  },
  {
    key: 'rashii',
    pattern: '〜らしい',
    explanation: 'Apparently / seems (based on hearsay or evidence).',
    jlpt: 3,
    match: (c) => suffixHas(c, 'らしい'),
    requires: ['らしい'],
  },
  {
    key: 'mitai',
    pattern: '〜みたい',
    explanation: 'Like / resembling / seems like.',
    jlpt: 4,
    match: (c) => suffixHas(c, 'みたい'),
    requires: ['みたい'],
  },
  {
    key: 'sugiru',
    pattern: '〜すぎる',
    explanation: 'Too much / excessively ~.',
    jlpt: 4,
    match: (c) => suffixHas(c, 'すぎる') || suffixHas(c, 'すぎ'),
    requires: ['すぎ'],
  },
  {
    key: 'yasui-nikui',
    pattern: '〜やすい / 〜にくい',
    explanation: 'Easy to ~ / hard to ~.',
    jlpt: 3,
    match: (c) => suffixHas(c, 'やすい') || suffixHas(c, 'にくい'),
    requires: ['やすい', 'にくい'],
  },
  {
    key: 'hajimeru-tsuzukeru',
    pattern: '〜始める / 〜続ける / 〜終わる',
    explanation: 'Start / keep on / finish doing something.',
    jlpt: 4,
    match: (c) =>
      suffixHas(c, '始める') || suffixHas(c, '続ける') || suffixHas(c, '終わる') ||
      suffixHas(c, '始め') || suffixHas(c, '続け'),
    requires: ['始め', '続け', '終わ'],
  },
  {
    key: 'polite-masu',
    pattern: '〜ます / 〜ました',
    explanation: 'Polite verb ending.',
    jlpt: 5,
    match: (c) => suffixHas(c, 'ます') || suffixHas(c, 'まし') || suffixHas(c, 'ませ'),
    requires: ['ます', 'まし', 'ませ'],
  },
  {
    key: 'copula',
    pattern: '〜だ / 〜です',
    explanation: 'Copula — "is / am / are". だった is its past form.',
    jlpt: 5,
    match: (c) => suffixHas(c, 'だ') || suffixHas(c, 'です') || suffixHas(c, 'だっ') || suffixHas(c, 'でし'),
    requires: ['だ', 'です', 'だっ', 'でし'],
  },
];

const BY_KEY = new Map(PATTERNS.map((p) => [p.key, p]));

export function patternByKey(key: string): Pattern | undefined {
  return BY_KEY.get(key);
}

/**
 * True when the pattern's literal marker is actually present in the text.
 * Patterns carried purely by inflection declare no marker and always pass.
 */
export function markerPresent(pattern: Pattern, text: string): boolean {
  if (!pattern.requires || pattern.requires.length === 0) return true;
  return pattern.requires.some((marker) => text.includes(marker));
}

/** Detects every pattern present in a merged chunk. */
export function detectPatterns(tokens: KuromojiToken[]): GrammarNote[] {
  if (tokens.length < 2) return [];
  const suffixTokens: SuffixToken[] = tokens.slice(1).map((t) => ({
    surface: t.surface_form,
    pos: t.pos,
    posDetail: [t.pos_detail_1, t.pos_detail_2, t.pos_detail_3].filter((x) => x && x !== '*').join('/'),
    form: t.conjugated_form,
  }));
  const text = tokens.map((t) => t.surface_form).join('');
  const ctx: MatchCtx = {
    suffix: suffixTokens.map((t) => t.surface),
    suffixTokens,
    tokens,
    text,
  };
  const notes: GrammarNote[] = [];
  for (const p of PATTERNS) {
    let ok = false;
    try {
      ok = p.match(ctx);
    } catch {
      ok = false;
    }
    // Independent check: never claim a form the text does not contain.
    if (ok && !markerPresent(p, text)) ok = false;
    if (ok) {
      notes.push({ key: p.key, pattern: p.pattern, explanation: p.explanation, jlpt: p.jlpt });
    }
  }
  // 〜ている already implies 〜て; drop the bare copula note when a richer
  // pattern covers the same suffix, so a chunk doesn't produce six notes.
  const keys = new Set(notes.map((n) => n.key));
  return notes.filter((n) => {
    if (n.key === 'past' && keys.has('conditional-tara')) return false;
    if (n.key === 'copula' && (keys.has('past') || keys.has('te-iru'))) return false;
    return true;
  });
}
