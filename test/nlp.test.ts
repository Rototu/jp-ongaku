import { describe, expect, test } from 'bun:test';
import { tokenizeLine, lineRomaji, lineKana } from '../server/nlp/tokenize';
import { alignFurigana, segmentsToReading } from '../server/nlp/furigana';
import { toRomaji, isLoanword } from '../server/nlp/kana';
import { priorityFor, shouldEnroll } from '../server/nlp/priority';

// All Japanese in these tests is written by hand for testing, not taken from
// any song.

describe('romaji', () => {
  test('handles gemination and long vowels', () => {
    expect(toRomaji('だった')).toBe('datta');
    expect(toRomaji('きょう')).toBe('kyou');
    expect(toRomaji('コンピューター')).toBe('konpyuutaa');
  });

  test('converts katakana as well as hiragana', () => {
    expect(toRomaji('ホシ')).toBe('hoshi');
  });
});

describe('furigana alignment', () => {
  test('annotates a kanji run with its reading', () => {
    const segs = alignFurigana('夜', 'よる');
    expect(segs).toEqual([{ text: '夜', ruby: 'よる' }]);
  });

  test('leaves kana unannotated and splits around it', () => {
    const segs = alignFurigana('探し', 'さがし');
    expect(segs.map((s) => s.text).join('')).toBe('探し');
    expect(segs.find((s) => s.text === '探')?.ruby).toBe('さが');
    expect(segs.find((s) => s.text === 'し')?.ruby).toBe('');
  });

  test('handles multiple kanji runs separated by kana', () => {
    const segs = alignFurigana('走り続ける', 'はしりつづける');
    expect(segs.map((s) => s.text).join('')).toBe('走り続ける');
    expect(segs.find((s) => s.text === '走')?.ruby).toBe('はし');
    expect(segs.find((s) => s.text === '続')?.ruby).toBe('つづ');
  });

  test('uses curated readings for irregular compounds', () => {
    // 大人 is おとな, which no per-kanji rule produces.
    const segs = alignFurigana('大人', 'おとな');
    expect(segmentsToReading(segs)).toBe('おとな');
  });

  test('kana-only input needs no ruby', () => {
    expect(alignFurigana('いつか', 'いつか')).toEqual([{ text: 'いつか', ruby: '' }]);
  });

  test('round-trips back to the original reading', () => {
    for (const [surface, reading] of [
      ['昨日', 'きのう'],
      ['忘れない', 'わすれない'],
      ['夜空', 'よぞら'],
    ] as const) {
      expect(segmentsToReading(alignFurigana(surface, reading))).toBe(reading);
    }
  });
});

describe('tokenization', () => {
  test('merges inflectional tails into one study chunk', async () => {
    const toks = await tokenizeLine('君の声を今日も探している');
    const surfaces = toks.map((t) => t.surface);
    expect(surfaces).toContain('探している');
    expect(surfaces).not.toContain('探し');
  });

  test('keeps case particles as separate chunks', async () => {
    const toks = await tokenizeLine('君の声を探す');
    expect(toks.map((t) => t.surface)).toEqual(['君', 'の', '声', 'を', '探す']);
  });

  test('resolves the dictionary form of a conjugated verb', async () => {
    const toks = await tokenizeLine('走り続ければ届く');
    const run = toks.find((t) => t.surface.startsWith('走り'));
    expect(run?.baseForm).toBe('走る');
    expect(run?.entry?.senses[0].glosses.join(' ')).toContain('to run');
  });

  test('particles get grammar glosses, not homograph dictionary entries', async () => {
    const toks = await tokenizeLine('夜は星が綺麗');
    const wa = toks.find((t) => t.surface === 'は');
    const ga = toks.find((t) => t.surface === 'が');
    expect(wa?.functionGloss).toContain('topic marker');
    expect(wa?.entry).toBeUndefined();
    expect(ga?.functionGloss).toContain('subject');
  });

  test('particles は/を romanize by pronunciation', async () => {
    const toks = await tokenizeLine('声を聞く');
    expect(toks.find((t) => t.surface === 'を')?.romaji).toBe('o');
    const toks2 = await tokenizeLine('夜は長い');
    expect(toks2.find((t) => t.surface === 'は')?.romaji).toBe('wa');
  });

  test('prefers current usage over archaic homographs', async () => {
    const toks = await tokenizeLine('大人になっても');
    const natte = toks.find((t) => t.surface === 'なって');
    expect(natte?.entry?.senses[0].glosses.join(' ')).toContain('to become');
  });

  test('prefers kana-usual entries for kana spellings', async () => {
    const toks = await tokenizeLine('いつか届く');
    const itsuka = toks.find((t) => t.surface === 'いつか');
    expect(itsuka?.entry?.senses[0].glosses.join(' ')).toMatch(/someday|sometime/);
  });

  test('detects grammar patterns on merged chunks', async () => {
    const toks = await tokenizeLine('忘れないでいてほしい');
    const keys = toks.flatMap((t) => t.grammar.map((g) => g.key));
    expect(keys).toContain('negative');
  });

  test('detects progressive on 〜ている', async () => {
    const toks = await tokenizeLine('探している');
    expect(toks[0].grammar.map((g) => g.key)).toContain('te-iru');
  });

  test('detects conditional on 〜ば', async () => {
    const toks = await tokenizeLine('続ければ');
    expect(toks[0].grammar.map((g) => g.key)).toContain('conditional-ba');
  });

  test('line-level romaji and kana are consistent', async () => {
    const toks = await tokenizeLine('昨日の夜は綺麗だった');
    expect(lineRomaji(toks)).toContain('kinou');
    expect(lineRomaji(toks)).toContain('datta');
    expect(lineKana(toks)).toBe('きのうのよるはきれいだった');
  });

  test('every non-filler chunk carries furigana covering its surface', async () => {
    const toks = await tokenizeLine('夜空に光る星を見上げていた');
    for (const t of toks) {
      expect(t.furigana.map((f) => f.text).join('')).toBe(t.surface);
    }
  });
});

describe('priority', () => {
  const noun = (surface: string) => ({
    surface_form: surface,
    pos: '名詞',
    pos_detail_1: '一般',
    pos_detail_2: '*',
    pos_detail_3: '*',
    conjugated_type: '*',
    conjugated_form: '*',
    basic_form: surface,
  });

  test('common everyday nouns clear the enrollment bar', async () => {
    const toks = await tokenizeLine('夜の星と声');
    for (const s of ['夜', '星', '声']) {
      const t = toks.find((x) => x.surface === s);
      expect(shouldEnroll(t!.priority)).toBe(true);
    }
  });

  test('particles never enroll', async () => {
    const toks = await tokenizeLine('夜の星が');
    for (const t of toks.filter((x) => x.pos === '助詞')) {
      expect(t.priority).toBe(0);
    }
  });

  test('proper nouns are pushed below the bar', () => {
    const score = priorityFor({
      token: { ...noun('田中'), pos_detail_1: '固有名詞' },
      entry: {
        id: '1',
        headword: '田中',
        reading: 'たなか',
        common: true,
        freqRank: 5000,
        jlpt: null,
        senses: [{ pos: ['n'], glosses: ['Tanaka'], misc: [], info: [] }],
      },
      loanword: false,
    });
    expect(shouldEnroll(score)).toBe(false);
  });

  test('words absent from the dictionary do not enroll', () => {
    const score = priorityFor({ token: noun('ヌルポ'), entry: undefined, loanword: true });
    expect(shouldEnroll(score)).toBe(false);
  });
});

describe('loanword detection', () => {
  test('flags katakana words', () => {
    expect(isLoanword('コンピューター')).toBe(true);
    expect(isLoanword('ホシ')).toBe(true);
  });

  test('does not flag kanji or hiragana', () => {
    expect(isLoanword('星')).toBe(false);
    expect(isLoanword('ほし')).toBe(false);
  });
});
