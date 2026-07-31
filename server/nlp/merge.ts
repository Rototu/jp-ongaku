import type { KuromojiToken } from './tokenize';

/**
 * Groups raw tokenizer output into learner-sized chunks.
 *
 * IPADIC splits 探している into 探し + て + いる, which is correct morphology and
 * useless pedagogy — the learner needs to see one unit whose dictionary form is
 * 探す and whose grammar is "progressive". This merges inflectional tails onto
 * their head word while leaving case particles (は/が/を/の…) standing alone,
 * because those are the words that show sentence structure.
 */

/** Conjunctive particles that belong to the verb they follow. */
const CONJ_PARTICLES = new Set(['て', 'で', 'ば', 'たり', 'ながら', 'つつ', 'ちゃ', 'じゃ', 'たら']);

/** Heads that can accept an inflectional tail. */
const ATTACHABLE_HEAD_POS = new Set(['動詞', '形容詞', '助動詞', '名詞', '副詞', '連体詞']);

function isAttachable(t: KuromojiToken, head: KuromojiToken, chunk: KuromojiToken[]): boolean {
  // Auxiliaries always attach: た, ない, ます, だ, う, よう, れる…
  if (t.pos === '助動詞') return true;

  // Dependent verbs: いる, ある, くる, いく, しまう, おく, みる, くれる…
  if (t.pos === '動詞' && t.pos_detail_1 === '非自立') return true;

  // Dependent adjectives: ない (as adjective), ほしい, づらい…
  if (t.pos === '形容詞' && t.pos_detail_1 === '非自立') return true;

  // Verb/adjective suffixes: 〜すぎる, 〜始める, 〜がち
  if (t.pos_detail_1 === '接尾' && (t.pos === '動詞' || t.pos === '形容詞')) return true;

  // Conjunctive particles glue clauses to their verb, but only right after a
  // verb/adjective — 「で」 after a noun is a case particle and must stay free.
  if (t.pos === '助詞' && t.pos_detail_1 === '接続助詞' && CONJ_PARTICLES.has(t.surface_form)) {
    const prev = chunk[chunk.length - 1];
    return (
      prev.pos === '動詞' || prev.pos === '形容詞' || prev.pos === '助動詞' ||
      (prev.pos === '助詞' && prev.pos_detail_1 === '接続助詞')
    );
  }

  // する/した directly after a サ変 noun: 勉強 + する -> 勉強する
  if (t.pos === '動詞' && head.pos === '名詞' && head.pos_detail_1 === 'サ変接続' && chunk.length === 1) {
    return true;
  }

  // Nominal suffixes that change meaning: 私たち, 彼ら, 高さ
  if (t.pos === '名詞' && t.pos_detail_1 === '接尾' && head.pos !== '助詞') return true;

  return false;
}

export interface Chunk {
  tokens: KuromojiToken[];
  head: KuromojiToken;
}

export function chunkTokens(tokens: KuromojiToken[]): Chunk[] {
  const chunks: Chunk[] = [];
  let current: KuromojiToken[] = [];

  const flush = () => {
    if (current.length) {
      chunks.push({ tokens: current, head: current[0] });
      current = [];
    }
  };

  for (const t of tokens) {
    if (t.pos === '記号' || t.surface_form.trim() === '') {
      flush();
      chunks.push({ tokens: [t], head: t });
      continue;
    }

    if (current.length === 0) {
      current = [t];
      continue;
    }

    const head = current[0];
    if (ATTACHABLE_HEAD_POS.has(head.pos) && isAttachable(t, head, current)) {
      current.push(t);
      continue;
    }

    flush();
    current = [t];
  }
  flush();

  return chunks;
}
