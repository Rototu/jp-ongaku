import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { _setDbForTests, getDb } from '../server/db';
import { buildChunks, analyzeSong } from '../server/llm/analyze';
import { buildLesson } from '../server/lesson/build';
import { parsePlain } from '../server/lyrics/lrc';
import { segmentsToReading } from '../server/nlp/furigana';
import { OTHER_COLOR_IDX, roleColorIdx } from '../shared/roles';

/**
 * All Japanese here is written by hand for testing.
 *
 * The point of these tests is the safety net: a model that drops, adds or
 * "corrects" a character must not be able to put wrong material in front of the
 * learner.
 */

const LINE = '夜空に星が光っている';

const goodSegments = [
  { text: '夜空', reading: 'よぞら', role: 'noun', meaning: 'night sky', explanation: 'Compound of 夜 and 空.' },
  { text: 'に', reading: 'に', role: 'particle', meaning: 'in / at', explanation: 'Marks location.' },
  { text: '星', reading: 'ほし', role: 'noun', meaning: 'star', explanation: 'Subject here.' },
  { text: 'が', reading: 'が', role: 'particle', meaning: 'subject marker', explanation: 'Marks 星.' },
  { text: '光っている', reading: 'ひかっている', role: 'verb, progressive', meaning: 'is shining', explanation: '光る in the 〜ている form.' },
];

describe('segmentation validation', () => {
  test('accepts segments that reconstruct the line exactly', () => {
    const chunks = buildChunks(LINE, goodSegments);
    expect(chunks).not.toBeNull();
    expect(chunks!.map((c) => c.text).join('')).toBe(LINE);
    expect(chunks).toHaveLength(5);
  });

  test('rejects a segmentation that drops a character', () => {
    const dropped = goodSegments.map((s) =>
      s.text === '光っている' ? { ...s, text: '光ってる' } : s,
    );
    expect(buildChunks(LINE, dropped)).toBeNull();
  });

  test('rejects a segmentation that invents a word', () => {
    const invented = [...goodSegments, { text: 'よ', reading: 'よ', meaning: 'emphasis' }];
    expect(buildChunks(LINE, invented)).toBeNull();
  });

  test('rejects reordered segments', () => {
    const reordered = [goodSegments[2], goodSegments[3], goodSegments[0], goodSegments[1], goodSegments[4]];
    expect(buildChunks(LINE, reordered)).toBeNull();
  });

  test('rejects a substituted kanji', () => {
    const substituted = goodSegments.map((s) => (s.text === '星' ? { ...s, text: '生' } : s));
    expect(buildChunks(LINE, substituted)).toBeNull();
  });

  test('rejects an empty segmentation', () => {
    expect(buildChunks(LINE, [])).toBeNull();
    expect(buildChunks(LINE, [{ reading: 'よぞら' }])).toBeNull();
  });

  test('tolerates whitespace differences only', () => {
    const spaced = [
      { text: '夜空 ', reading: 'よぞら' },
      { text: 'に', reading: 'に' },
      { text: '星が光っている', reading: 'ほしがひかっている' },
    ];
    expect(buildChunks(LINE, spaced)).not.toBeNull();
  });
});

describe('chunk construction', () => {
  test('derives furigana locally from the reading', () => {
    const chunks = buildChunks(LINE, goodSegments)!;
    const yozora = chunks[0];
    expect(segmentsToReading(yozora.furigana)).toBe('よぞら');
    expect(yozora.furigana.map((s) => s.text).join('')).toBe('夜空');
    expect(yozora.romaji).toBe('yozora');
  });

  test('normalises katakana readings to hiragana', () => {
    const chunks = buildChunks('ホシ', [{ text: 'ホシ', reading: 'ホシ' }])!;
    expect(chunks[0].reading).toBe('ほし');
    expect(chunks[0].romaji).toBe('hoshi');
  });

  test('takes the palette slot from the grammar role, not from position', () => {
    const chunks = buildChunks(LINE, goodSegments)!;
    const colors = chunks.map((c) => c.colorIdx);
    // noun, particle, noun, particle, verb — so the two nouns match, and so do
    // the two particles, however far apart they sit.
    expect(colors).toEqual([
      roleColorIdx('noun'),
      roleColorIdx('particle'),
      roleColorIdx('noun'),
      roleColorIdx('particle'),
      roleColorIdx('verb'),
    ]);
    expect(colors[0]).toBe(colors[2]);
    expect(colors[0]).not.toBe(colors[1]);
  });

  test('leaves punctuation uncoloured and unread', () => {
    const chunks = buildChunks('星、光る', [
      { text: '星', reading: 'ほし', role: 'noun' },
      { text: '、', reading: '' },
      { text: '光る', reading: 'ひかる', role: 'verb' },
    ])!;
    const comma = chunks[1];
    expect(comma.colorIdx).toBe(-1);
    expect(comma.reading).toBe('');
    expect(chunks[0].colorIdx).not.toBe(chunks[2].colorIdx);
  });

  test('falls back to the other slot when the model gives no role', () => {
    const chunks = buildChunks('星', [{ text: '星', reading: 'ほし' }])!;
    expect(chunks[0].colorIdx).toBe(OTHER_COLOR_IDX);
  });

  test('romanises particles by pronunciation, not spelling', () => {
    const chunks = buildChunks('声を聞く', [
      { text: '声', reading: 'こえ', role: 'noun' },
      { text: 'を', reading: 'を', role: 'object particle' },
      { text: '聞く', reading: 'きく', role: 'verb' },
    ])!;
    expect(chunks[1].romaji).toBe('o');

    const topic = buildChunks('夜は', [
      { text: '夜', reading: 'よる', role: 'noun' },
      { text: 'は', reading: 'は', role: 'topic particle' },
    ])!;
    expect(topic[1].romaji).toBe('wa');
  });

  test('does not mangle a real word that looks like a particle', () => {
    // 葉 is "ha" (leaf), not the topic marker.
    const chunks = buildChunks('葉', [{ text: '葉', reading: 'は', role: 'noun' }])!;
    expect(chunks[0].romaji).toBe('ha');
  });

  test('keeps meaning, role and explanation per chunk', () => {
    const chunks = buildChunks(LINE, goodSegments)!;
    const verb = chunks[4];
    expect(verb.meaning).toBe('is shining');
    expect(verb.role).toContain('verb');
    expect(verb.explanation).toContain('ている');
  });
});

describe('reading cross-check against the dictionary', () => {
  test('marks a correct dictionary reading as verified', () => {
    const chunks = buildChunks('星', [{ text: '星', reading: 'ほし' }])!;
    expect(chunks[0].readingCheck).toBe('verified');
  });

  test('flags a reading the dictionary does not have for that word', () => {
    // 星 is ほし/せい, never そら.
    const chunks = buildChunks('星', [{ text: '星', reading: 'そら' }])!;
    expect(chunks[0].readingCheck).toBe('unverified');
  });

  test('does not flag inflected forms that are not headwords', () => {
    const chunks = buildChunks('光っている', [{ text: '光っている', reading: 'ひかっている' }])!;
    expect(chunks[0].readingCheck).not.toBe('unverified');
  });

  test('reports unknown for text with no reading to check', () => {
    const chunks = buildChunks('!', [{ text: '!', reading: '' }])!;
    expect(chunks[0].readingCheck).toBe('unknown');
  });
});

describe('analyzeSong with a stubbed model', () => {
  beforeEach(() => {
    _setDbForTests(new Database(':memory:'));
  });

  afterEach(() => {
    _setDbForTests(null);
  });

  const importSong = () =>
    buildLesson({
      title: 'Chunk Test',
      artist: 'selftest',
      source: 'paste',
      lines: parsePlain(LINE),
      raw: LINE,
    });

  test('stores validated chunks and the translation', async () => {
    const song = await importSong();
    const result = await analyzeSong(song.songId, {
      completer: async () =>
        JSON.stringify([
          {
            idx: 0,
            translation: 'Stars are shining in the night sky.',
            segments: goodSegments,
            notes: [{ pattern: '〜ている', explanation: 'Ongoing action.' }],
          },
        ]),
    });

    expect(result.linesAnalyzed).toBe(1);
    expect(result.rejected).toBe(0);

    const row = getDb()
      .query<{ translation: string; chunks: string; notes: string }, []>(
        'SELECT translation, chunks, notes FROM line_analysis LIMIT 1',
      )
      .get();
    expect(row?.translation).toContain('night sky');
    const chunks = JSON.parse(row!.chunks);
    expect(chunks).toHaveLength(5);
    expect(chunks[0].meaning).toBe('night sky');
    expect(JSON.parse(row!.notes)[0].pattern).toBe('〜ている');
  });

  test('retries once, then keeps the translation but rejects bad segmentation', async () => {
    const song = await importSong();
    let calls = 0;
    const result = await analyzeSong(song.songId, {
      completer: async () => {
        calls++;
        return JSON.stringify([
          {
            idx: 0,
            translation: 'Stars are shining.',
            // Always invalid: a word the line does not contain.
            segments: [{ text: '全然ちがう', reading: 'ぜんぜんちがう' }],
          },
        ]);
      },
    });

    expect(calls).toBe(1); // parses fine, so no retry; validation happens after
    expect(result.rejected).toBe(1);

    const row = getDb()
      .query<{ translation: string; chunks: string }, []>(
        'SELECT translation, chunks FROM line_analysis LIMIT 1',
      )
      .get();
    // Translation is kept, segmentation is not.
    expect(row?.translation).toBe('Stars are shining.');
    expect(JSON.parse(row!.chunks)).toEqual([]);
  });

  test('retries when the model returns unparseable output', async () => {
    const song = await importSong();
    let calls = 0;
    const result = await analyzeSong(song.songId, {
      completer: async () => {
        calls++;
        if (calls === 1) return 'sorry, I cannot do that';
        return JSON.stringify([{ idx: 0, translation: 'ok', segments: goodSegments }]);
      },
    });

    expect(calls).toBe(2);
    expect(result.linesAnalyzed).toBe(1);
  });

  test('a failing model leaves the lesson intact and reports why', async () => {
    const song = await importSong();
    const result = await analyzeSong(song.songId, {
      completer: async () => {
        throw new Error('AI Gateway 401: invalid api key');
      },
    });

    expect(result.linesAnalyzed).toBe(0);
    expect(result.errors[0]).toContain('rejected the API key');
    // The line and its local parse are untouched.
    const line = getDb().query<{ tokens: string }, []>('SELECT tokens FROM lines LIMIT 1').get();
    expect(JSON.parse(line!.tokens).length).toBeGreaterThan(0);
  });

  test('skips lines that already have chunks unless forced', async () => {
    const song = await importSong();
    const completer = async () =>
      JSON.stringify([{ idx: 0, translation: 'ok', segments: goodSegments }]);

    await analyzeSong(song.songId, { completer });
    const second = await analyzeSong(song.songId, { completer });
    expect(second.linesAnalyzed).toBe(0);
    expect(second.skipped).toBe(1);

    const forced = await analyzeSong(song.songId, { completer, force: true });
    expect(forced.linesAnalyzed).toBe(1);
  });
});
