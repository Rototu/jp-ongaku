import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _setDbForTests, getDb } from '../server/db';
import { _setMnemonicSourceForTests } from '../server/mnemonics';
import { buildLesson } from '../server/lesson/build';
import { parsePlain } from '../server/lyrics/lrc';
import {
  analyzeSong,
  askAboutWord,
  cachedExamples,
  cachedKanjiMnemonics,
  generateExamples,
  generateKanjiMnemonics,
  generateSongKanjiMnemonics,
  questionHistory,
} from '../server/llm/analyze';

/**
 * The on-demand explanation layer: user-supplied song context reaching the
 * model, and the caches that mean examples and questions are paid for once.
 */

const FIXTURE = ['夜空に星が光っている', '君の声を探している'].join('\n');

/**
 * Hooks come from the shipped artifact as well as from the user's database, and
 * the real artifact covers every kanji in these fixtures. Pointing the reader at
 * an empty directory is what makes "was this character asked about" mean anything
 * here — without it these tests pass or fail depending on how much of the
 * artifact happens to be built.
 */
let artifactDir: string;

beforeEach(() => {
  _setDbForTests(new Database(':memory:'));
  artifactDir = mkdtempSync(join(tmpdir(), 'ongaku-no-artifact-'));
  _setMnemonicSourceForTests(
    join(artifactDir, 'absent.jsonl'),
    join(artifactDir, 'absent.db'),
  );
});

afterEach(() => {
  _setDbForTests(null);
  _setMnemonicSourceForTests();
  rmSync(artifactDir, { recursive: true, force: true });
});

async function importFixture(context?: string) {
  return buildLesson({
    title: 'Test Song',
    artist: 'Test Artist',
    source: 'paste',
    context: context ?? null,
    lines: parsePlain(FIXTURE),
    raw: FIXTURE,
  });
}

describe('song context', () => {
  test('is stored on import and handed to the analyzer', async () => {
    const { songId } = await importFixture('Sung by the younger sister; 「あの人」 is her brother.');

    const prompts: string[] = [];
    await analyzeSong(songId, {
      completer: async (prompt) => {
        prompts.push(prompt);
        return '[]';
      },
    });

    expect(prompts.length).toBeGreaterThan(0);
    expect(prompts[0]).toContain('younger sister');
    expect(prompts[0]).toContain('あの人');
  });

  test('is left out of the prompt when the user gave none', async () => {
    const { songId } = await importFixture();
    const prompts: string[] = [];
    await analyzeSong(songId, {
      completer: async (prompt) => {
        prompts.push(prompt);
        return '[]';
      },
    });
    expect(prompts[0]).not.toContain('Background the learner supplied');
  });

  test('survives a re-import that carries no context', async () => {
    const { songId } = await importFixture('keep me');
    await importFixture();
    const row = getDb()
      .query<{ context: string | null }, [number]>('SELECT context FROM songs WHERE id = ?')
      .get(songId);
    expect(row?.context).toBe('keep me');
  });
});

describe('usage examples', () => {
  const reply = JSON.stringify({
    examples: [
      { jp: '星が光っている', english: 'The stars are shining.', note: 'plain, progressive' },
      { jp: '空を見ました', english: 'I looked at the sky.' },
    ],
  });

  test('are generated once and then served from the cache', async () => {
    let calls = 0;
    const completer = async () => {
      calls++;
      return reply;
    };

    const first = await generateExamples({ term: '光る', reading: 'ひかる' }, { completer });
    expect(first.cached).toBe(false);
    expect(first.examples).toHaveLength(2);
    // Ruby and romaji are built locally, never taken from the model.
    expect(first.examples[0].furigana.length).toBeGreaterThan(0);
    expect(first.examples[0].romaji.length).toBeGreaterThan(0);
    expect(first.examples[1].note).toBeNull();

    const second = await generateExamples({ term: '光る', reading: 'ひかる' }, { completer });
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
    expect(second.examples).toEqual(first.examples);
  });

  test('force regenerates and overwrites the cached set', async () => {
    let calls = 0;
    const completer = async () => {
      calls++;
      return calls === 1
        ? reply
        : JSON.stringify({ examples: [{ jp: '光った', english: 'It shone.' }] });
    };

    await generateExamples({ term: '光る' }, { completer });
    const again = await generateExamples({ term: '光る' }, { completer, force: true });

    expect(calls).toBe(2);
    expect(again.cached).toBe(false);
    expect(again.examples).toHaveLength(1);
    expect(cachedExamples('光る')).toHaveLength(1);
  });

  test('a reply with no usable sentence fails instead of caching nothing', async () => {
    const completer = async () => JSON.stringify({ examples: [{ jp: '', english: '' }] });
    await expect(generateExamples({ term: '光る' }, { completer })).rejects.toThrow();
    expect(cachedExamples('光る')).toBeNull();
  });

  test('the same term with a different reading is a separate entry', async () => {
    const completer = async () => reply;
    await generateExamples({ term: '今日', reading: 'きょう' }, { completer });
    expect(cachedExamples('今日', 'きょう')).not.toBeNull();
    expect(cachedExamples('今日', 'こんにち')).toBeNull();
  });
});

describe('questions about a word', () => {
  test('an identical question is answered from the cache', async () => {
    let calls = 0;
    const completer = async () => {
      calls++;
      return JSON.stringify({ answer: 'It marks the topic, not the subject.' });
    };

    const first = await askAboutWord({ term: 'は' }, 'why は and not が?', { completer });
    expect(first.cached).toBe(false);
    const second = await askAboutWord({ term: 'は' }, '  why は and not が?  ', { completer });
    expect(second.cached).toBe(true);
    expect(calls).toBe(1);
    expect(second.answer).toBe(first.answer);
  });

  test('history keeps every distinct question in order', async () => {
    const completer = async () => JSON.stringify({ answer: 'ok' });
    await askAboutWord({ term: '探している' }, 'first?', { completer });
    await askAboutWord({ term: '探している' }, 'second?', { completer });

    const history = questionHistory('探している');
    expect(history.map((h) => h.question)).toEqual(['first?', 'second?']);
    expect(questionHistory('探している', 'さがしている')).toHaveLength(0);
  });

  test('earlier answers and the song context are given to the model', async () => {
    const { songId } = await importFixture('A lullaby for a lost cat.');
    const prompts: string[] = [];
    const completer = async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify({ answer: 'answered' });
    };

    await askAboutWord({ term: '星' }, 'what does it evoke?', { completer });
    await askAboutWord({ term: '星', songId, lineText: '夜空に星が光っている' }, 'and here?', {
      completer,
    });

    expect(prompts[1]).toContain('lost cat');
    expect(prompts[1]).toContain('夜空に星が光っている');
    // The previous exchange is included, so a follow-up reads as a follow-up.
    expect(prompts[1]).toContain('what does it evoke?');
  });

  test('an empty question is rejected before any request', async () => {
    let calls = 0;
    const completer = async () => {
      calls++;
      return '{}';
    };
    await expect(askAboutWord({ term: '星' }, '   ', { completer })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});

describe('kanji mnemonics', () => {
  const FACTS = [
    { char: '言', meanings: ['say', 'word'], on: ['ゲン', 'ゴン'], kun: ['い.う', 'こと'] },
    { char: '葉', meanings: ['leaf'], on: ['ヨウ'], kun: ['は'] },
  ];

  const reply = (chars: string[]) =>
    JSON.stringify({
      kanji: chars.map((char) => ({
        char,
        meaning: `${char} looks like a thing`,
        reading: `${char} sounds like a word`,
        readingKey: 'ヨウ',
      })),
    });

  test('are generated once per character, then served from the cache', async () => {
    let calls = 0;
    const completer = async () => {
      calls++;
      return reply(['言', '葉']);
    };

    const first = await generateKanjiMnemonics(FACTS, { completer });
    expect(new Set(Object.keys(first))).toEqual(new Set(['言', '葉']));
    expect(first['言'].meaning).toContain('言');
    expect(calls).toBe(1);

    const second = await generateKanjiMnemonics(FACTS, { completer });
    expect(second).toEqual(first);
    // Same characters again: nothing was asked of the model.
    expect(calls).toBe(1);
  });

  test('a character met in another word is not paid for twice', async () => {
    const asked: string[][] = [];
    const completer = async (prompt: string) => {
      const chars = FACTS.map((f) => f.char).filter((ch) => prompt.includes(`${ch} — meanings`));
      asked.push(chars);
      return reply(chars);
    };

    await generateKanjiMnemonics([FACTS[0]], { completer });
    // 言葉 after 言: only 葉 is still missing, so only 葉 is asked about.
    await generateKanjiMnemonics(FACTS, { completer });
    expect(asked).toEqual([['言'], ['葉']]);
  });

  test('hooks for a character that was not asked about are discarded', async () => {
    const completer = async () =>
      JSON.stringify({
        kanji: [
          { char: '言', meaning: 'ok', reading: 'ok', readingKey: 'ゲン' },
          { char: '星', meaning: 'wrong kanji', reading: 'wrong kanji', readingKey: 'セイ' },
        ],
      });

    const out = await generateKanjiMnemonics([FACTS[0]], { completer });
    expect(Object.keys(out)).toEqual(['言']);
    expect(cachedKanjiMnemonics(['星'])).toEqual({});
  });

  test('the model is told the real readings, so it cannot invent one', async () => {
    let prompt = '';
    const completer = async (text: string) => {
      prompt = text;
      return reply(['言']);
    };
    await generateKanjiMnemonics([FACTS[0]], { completer });
    expect(prompt).toContain('ゲン');
    expect(prompt).toContain('い.う');
    expect(prompt).toContain('say, word');
  });

  test('a whole song is covered up front, each character once', async () => {
    const { songId } = await importFixture();
    const asked: string[] = [];
    const completer = async (prompt: string) => {
      const chars = [...prompt].filter((ch) => prompt.includes(`${ch} — meanings`));
      asked.push(...chars);
      return JSON.stringify({
        kanji: chars.map((char) => ({
          char,
          meaning: `${char} hook`,
          reading: `${char} sounds`,
          readingKey: '',
        })),
      });
    };

    const run = await generateSongKanjiMnemonics(songId, { completer });
    // 夜空に星が光っている / 君の声を探している — every kanji in the lyrics, and
    // each one asked about exactly once however often it appears.
    expect(new Set(asked)).toEqual(new Set(['夜', '空', '星', '光', '君', '声', '探']));
    expect(asked).toHaveLength(new Set(asked).size);
    expect(run.generated).toBe(7);
    expect(run.errors).toEqual([]);
    expect(cachedKanjiMnemonics(['声'])['声'].meaning).toBe('声 hook');
  });

  test('a re-run costs nothing, and a second song only pays for what is new', async () => {
    const { songId } = await importFixture();
    let calls = 0;
    const completer = async (prompt: string) => {
      calls++;
      const chars = [...prompt].filter((ch) => prompt.includes(`${ch} — meanings`));
      return JSON.stringify({
        kanji: chars.map((char) => ({ char, meaning: 'm', reading: 'r', readingKey: '' })),
      });
    };

    await generateSongKanjiMnemonics(songId, { completer });
    const callsAfterFirst = calls;

    const again = await generateSongKanjiMnemonics(songId, { completer });
    expect(again.generated).toBe(0);
    expect(again.skipped).toBe(7);
    expect(calls).toBe(callsAfterFirst);

    // A song sharing every character with one already done asks for nothing.
    const second = await buildLesson({
      title: 'Another Song',
      artist: 'Test Artist',
      source: 'paste',
      context: null,
      lines: parsePlain('星が光っている'),
      raw: '星が光っている',
    });
    const shared = await generateSongKanjiMnemonics(second.songId, { completer });
    expect(shared.generated).toBe(0);
    expect(calls).toBe(callsAfterFirst);
  });

  test('a failed batch costs only its own characters', async () => {
    const { songId } = await importFixture();
    let calls = 0;
    const completer = async (prompt: string) => {
      calls++;
      if (calls === 1) throw new Error('gateway said no');
      const chars = [...prompt].filter((ch) => prompt.includes(`${ch} — meanings`));
      return JSON.stringify({
        kanji: chars.map((char) => ({ char, meaning: 'm', reading: 'r', readingKey: '' })),
      });
    };

    const run = await generateSongKanjiMnemonics(songId, { completer });
    expect(run.errors).toHaveLength(1);
    // Seven characters in two batches of six: one batch died, the other landed,
    // and the survivors are cached rather than the whole run being lost.
    expect(run.generated).toBeGreaterThan(0);
    expect(run.generated).toBeLessThan(7);
  });

  test('an entry missing either hook is not stored', async () => {
    const completer = async () =>
      JSON.stringify({ kanji: [{ char: '言', meaning: 'only the meaning' }] });
    const out = await generateKanjiMnemonics([FACTS[0]], { completer });
    expect(out).toEqual({});
    expect(cachedKanjiMnemonics(['言'])).toEqual({});
  });
});
