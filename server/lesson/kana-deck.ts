import { getDb, nowIso } from '../db';
import { freshState } from '../srs/sm2';
import { toRomaji } from '../nlp/kana';
import type { CardBack, CardFront } from '../../shared/types';

/**
 * Katakana recognition deck.
 *
 * Anime songs are stuffed with katakana loanwords, and katakana is this user's
 * shaky half of the syllabary, so it gets its own deck seeded on demand.
 * Hiragana is included as an optional set for completeness but is not seeded by
 * default.
 */

const KATAKANA_BASIC = [
  'ア', 'イ', 'ウ', 'エ', 'オ',
  'カ', 'キ', 'ク', 'ケ', 'コ',
  'サ', 'シ', 'ス', 'セ', 'ソ',
  'タ', 'チ', 'ツ', 'テ', 'ト',
  'ナ', 'ニ', 'ヌ', 'ネ', 'ノ',
  'ハ', 'ヒ', 'フ', 'ヘ', 'ホ',
  'マ', 'ミ', 'ム', 'メ', 'モ',
  'ヤ', 'ユ', 'ヨ',
  'ラ', 'リ', 'ル', 'レ', 'ロ',
  'ワ', 'ヲ', 'ン',
];

const KATAKANA_DAKUTEN = [
  'ガ', 'ギ', 'グ', 'ゲ', 'ゴ',
  'ザ', 'ジ', 'ズ', 'ゼ', 'ゾ',
  'ダ', 'ヂ', 'ヅ', 'デ', 'ド',
  'バ', 'ビ', 'ブ', 'ベ', 'ボ',
  'パ', 'ピ', 'プ', 'ペ', 'ポ',
];

/** Digraphs that are the usual sticking point in loanwords. */
const KATAKANA_COMBOS = [
  'キャ', 'キュ', 'キョ', 'シャ', 'シュ', 'ショ', 'チャ', 'チュ', 'チョ',
  'ニャ', 'ニュ', 'ニョ', 'ヒャ', 'ヒュ', 'ヒョ', 'ミャ', 'ミュ', 'ミョ',
  'リャ', 'リュ', 'リョ', 'ギャ', 'ギュ', 'ギョ', 'ジャ', 'ジュ', 'ジョ',
  'ビャ', 'ビュ', 'ビョ', 'ピャ', 'ピュ', 'ピョ',
  'ファ', 'フィ', 'フェ', 'フォ', 'ヴァ', 'ティ', 'ディ', 'ウィ', 'ウェ',
];

/** Look-alike pairs worth calling out explicitly — the classic mix-ups. */
const CONFUSABLES: Record<string, string> = {
  シ: 'Often confused with ツ — シ\'s strokes sweep left to right, low and flat.',
  ツ: 'Often confused with シ — ツ\'s strokes come down from the top.',
  ソ: 'Often confused with ン — ソ opens downward from the top.',
  ン: 'Often confused with ソ — ン starts low and hooks upward.',
  ク: 'Often confused with ワ and タ.',
  ワ: 'Often confused with ク and ウ.',
  ウ: 'Often confused with ワ — ウ has the little tick on top.',
  ス: 'Often confused with ヌ.',
  ヌ: 'Often confused with ス and メ.',
  メ: 'Often confused with ヌ.',
  ナ: 'Often confused with メ and ケ.',
  ホ: 'Often confused with 木 (the kanji for tree).',
  ロ: 'Often confused with 口 (the kanji for mouth).',
};

export interface SeedResult {
  created: number;
  total: number;
}

export function seedKatakanaDeck(includeCombos = true): SeedResult {
  const db = getDb();
  const now = nowIso();
  const chars = [
    ...KATAKANA_BASIC,
    ...KATAKANA_DAKUTEN,
    ...(includeCombos ? KATAKANA_COMBOS : []),
  ];

  let created = 0;

  db.transaction(() => {
    for (const char of chars) {
      const romaji = toRomaji(char);
      if (!romaji) continue;

      const front: CardFront = { prompt: 'Read this katakana', jp: char };
      const back: CardBack = {
        answer: romaji,
        reading: char,
        romaji,
        note: CONFUSABLES[char],
      };
      const dedupe = `kana:katakana:${char}`;

      const existing = db
        .query<{ id: number }, [string]>('SELECT id FROM cards WHERE dedupe_key = ?')
        .get(dedupe);
      if (existing) continue;

      const row = db
        .prepare(
          `INSERT INTO cards (kind, song_id, line_id, word_id, grammar_id, dedupe_key, front, back, created_at)
           VALUES ('kana', NULL, NULL, NULL, NULL, ?, ?, ?, ?)
           RETURNING id`,
        )
        .get(dedupe, JSON.stringify(front), JSON.stringify(back), now) as { id: number };

      db.prepare('INSERT INTO srs (card_id, due_at) VALUES (?, ?)').run(
        row.id,
        freshState().dueAt,
      );
      created++;
    }
  })();

  const total =
    db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cards WHERE kind = 'kana'").get()?.n ?? 0;

  return { created, total };
}

export function katakanaDeckSize(): number {
  return (
    getDb()
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM cards WHERE kind = 'kana'")
      .get()?.n ?? 0
  );
}
