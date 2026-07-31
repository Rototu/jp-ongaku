/**
 * Curated glosses for particles and auxiliaries.
 *
 * JMdict is a word dictionary, so looking up 「は」 there returns 歯 ("tooth")
 * and 「も」 returns 喪 ("mourning"). Grammar words need grammar explanations,
 * not dictionary homographs, so they come from this table instead.
 */
export interface FunctionWord {
  gloss: string;
  /** Romaji override — particles は/を/へ are pronounced wa/o/e. */
  romaji?: string;
  note?: string;
}

export const PARTICLES: Record<string, FunctionWord> = {
  は: { gloss: 'topic marker — "as for ~"', romaji: 'wa' },
  が: { gloss: 'subject marker (often new or emphasised info)' },
  を: { gloss: 'direct object marker', romaji: 'o' },
  に: { gloss: 'to / at / in — target, time, or destination' },
  へ: { gloss: 'toward — direction', romaji: 'e' },
  で: { gloss: 'at / by / with — location of action or means' },
  と: { gloss: 'and / with / quoting particle' },
  の: { gloss: "possessive or linking — \"'s\" / \"of\"" },
  も: { gloss: 'also / too / even' },
  や: { gloss: 'and (non-exhaustive list)' },
  か: { gloss: 'question marker, or "or"' },
  から: { gloss: 'from / because' },
  まで: { gloss: 'until / as far as' },
  より: { gloss: 'than / from' },
  ほど: { gloss: 'to the extent of' },
  だけ: { gloss: 'only / just' },
  しか: { gloss: 'nothing but (with a negative)' },
  こそ: { gloss: 'emphasis — "precisely this"' },
  でも: { gloss: 'even / but' },
  ね: { gloss: 'seeking agreement — "right?"' },
  よ: { gloss: 'assertive, telling the listener something' },
  な: { gloss: 'soft emphasis, or negative command with a verb' },
  ぞ: { gloss: 'strong masculine emphasis' },
  ぜ: { gloss: 'strong casual emphasis' },
  さ: { gloss: 'casual filler emphasis' },
  わ: { gloss: 'soft emphasis' },
  かな: { gloss: 'I wonder…' },
  って: { gloss: 'casual quoting / topic marker' },
  とか: { gloss: 'things like / or something' },
  ば: { gloss: 'conditional — "if"' },
  し: { gloss: 'listing reasons — "and besides"' },
  て: { gloss: 'connects clauses — "and then" / "-ing"' },
  で_conj: { gloss: 'connects clauses (after な/だ)' },
  のに: { gloss: 'even though' },
  ので: { gloss: 'because' },
  けど: { gloss: 'but / although' },
  けれど: { gloss: 'but / although' },
  が_conj: { gloss: 'but / although' },
  ながら: { gloss: 'while doing' },
  つつ: { gloss: 'while doing (literary)' },
  たり: { gloss: 'doing things like ~' },
  ずつ: { gloss: 'each / apiece' },
  ずに: { gloss: 'without doing' },
  ど: { gloss: 'but (literary)' },
  ものを: { gloss: 'if only (literary regret)' },
};

export const AUXILIARIES: Record<string, FunctionWord> = {
  だ: { gloss: 'plain "is / am / are"' },
  です: { gloss: 'polite "is / am / are"' },
  ます: { gloss: 'polite verb ending' },
  た: { gloss: 'past tense' },
  だっ: { gloss: '"was" (stem of だった)' },
  でし: { gloss: 'polite past stem (でした)' },
  ない: { gloss: 'negative — "not"' },
  ん: { gloss: 'contracted negative or emphasis' },
  ぬ: { gloss: 'negative (literary)' },
  ず: { gloss: 'negative (literary)' },
  う: { gloss: 'volitional — "let\'s" / "I shall"' },
  よう: { gloss: 'volitional — "let\'s" / "I shall"' },
  まい: { gloss: 'negative volitional — "surely not"' },
  たい: { gloss: 'want to' },
  らしい: { gloss: 'seems / apparently' },
  そう: { gloss: 'seems / looks like' },
  みたい: { gloss: 'like / seems like' },
  れる: { gloss: 'passive or potential' },
  られる: { gloss: 'passive or potential' },
  せる: { gloss: 'causative — "make/let do"' },
  させる: { gloss: 'causative — "make/let do"' },
  てる: { gloss: 'contracted ている — ongoing action' },
  でる: { gloss: 'contracted でいる — ongoing action' },
  ちゃう: { gloss: 'contracted てしまう — ends up doing' },
  じゃう: { gloss: 'contracted でしまう — ends up doing' },
  ましょ: { gloss: 'polite "let\'s"' },
  ませ: { gloss: 'polite imperative stem' },
  なかっ: { gloss: 'negative past stem (なかった)' },
};

/** Function-word gloss for a token, if it is one. */
export function functionWordGloss(surface: string, pos: string): FunctionWord | undefined {
  if (pos === '助詞') return PARTICLES[surface];
  if (pos === '助動詞') return AUXILIARIES[surface];
  return undefined;
}
