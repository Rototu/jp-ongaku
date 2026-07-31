import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _setDbForTests, getDb } from '../server/db';
import {
  _setMnemonicSourceForTests,
  compile,
  mnemonicStats,
  shippedMnemonics,
} from '../server/mnemonics';
import {
  cachedKanjiMnemonics,
  kanjiMnemonicPrompt,
  parseKanjiMnemonics,
  type KanjiFacts,
} from '../server/llm/analyze';
import { readingHookLooksSound } from '../scripts/build-mnemonics';

/**
 * The shipped artifact, and the guards around what may go into it.
 *
 * Every test here points the reader at a temporary pair of files: compiling over
 * the real artifact would throw away half an hour of model requests.
 */

let dir: string;
let jsonl: string;

const facts = (char: string, on: string[] = [], kun: string[] = []): KanjiFacts => ({
  char,
  meanings: ['stand-in meaning'],
  on,
  kun,
});

function writeArtifact(lines: unknown[]): void {
  writeFileSync(jsonl, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n'));
  // A fresh temp file can share the previous one's size and mtime-in-ms; the
  // reader keys off both, so make sure a rewrite is always seen as a change.
  _setMnemonicSourceForTests(jsonl, join(dir, 'mnemonics.db'));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ongaku-mnemonics-'));
  jsonl = join(dir, 'kanji-mnemonics.jsonl');
  _setMnemonicSourceForTests(jsonl, join(dir, 'mnemonics.db'));
  _setDbForTests(new Database(':memory:'));
});

afterEach(() => {
  _setMnemonicSourceForTests();
  _setDbForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('the artifact', () => {
  test('compiles the JSONL and reads hooks back', () => {
    writeArtifact([
      { char: '言', meaning: 'a mouth with lines', reading: 'GEN sounds like Gengar', readingKey: 'ゲン', components: ['口'] },
      { char: '口', meaning: 'an open mouth', reading: 'KOU sounds like a cow', readingKey: 'コウ', components: [] },
    ]);

    const got = shippedMnemonics(['言', '口']);
    expect(Object.keys(got).sort()).toEqual(['口', '言']);
    expect(got['言'].meaning).toBe('a mouth with lines');
    expect(got['言'].components).toEqual(['口']);
    expect(mnemonicStats().rows).toBe(2);
  });

  test('a character with no hook simply is not there', () => {
    writeArtifact([{ char: '言', meaning: 'm', reading: 'r', readingKey: 'ゲン', components: [] }]);
    expect(shippedMnemonics(['未'])).toEqual({});
  });

  test('no artifact at all is not an error', () => {
    _setMnemonicSourceForTests(join(dir, 'absent.jsonl'), join(dir, 'absent.db'));
    expect(shippedMnemonics(['言'])).toEqual({});
    expect(mnemonicStats()).toEqual({ rows: 0, compiledAt: null });
  });

  test('one torn line costs only itself', () => {
    writeArtifact([
      { char: '言', meaning: 'm1', reading: 'r1', readingKey: '', components: [] },
      '{"char":"口","meaning":"half a line',
      { char: '五', meaning: 'm2', reading: 'r2', readingKey: '', components: [] },
    ]);
    // An interrupted append leaves exactly this shape, and the run that follows
    // must still see everything written before it.
    const got = shippedMnemonics(['言', '口', '五']);
    expect(Object.keys(got).sort()).toEqual(['五', '言']);
  });

  test('a rewritten JSONL is picked up without asking', () => {
    writeArtifact([{ char: '言', meaning: 'first', reading: 'r', readingKey: '', components: [] }]);
    expect(shippedMnemonics(['言'])['言'].meaning).toBe('first');

    writeArtifact([
      { char: '言', meaning: 'second, longer so the size differs', reading: 'r', readingKey: '', components: [] },
    ]);
    expect(shippedMnemonics(['言'])['言'].meaning).toBe('second, longer so the size differs');
  });

  test('compile reports how many rows it wrote', () => {
    writeArtifact([
      { char: '言', meaning: 'm', reading: 'r', readingKey: '', components: [] },
      { char: '口', meaning: 'm', reading: 'r', readingKey: '', components: [] },
    ]);
    expect(compile()).toBe(2);
  });
});

describe('artifact and user hooks together', () => {
  test('the artifact answers, and the user\'s own overrides it', () => {
    writeArtifact([
      { char: '言', meaning: 'shipped meaning', reading: 'shipped sound', readingKey: 'ゲン', components: [] },
      { char: '口', meaning: 'shipped mouth', reading: 'shipped sound', readingKey: 'コウ', components: [] },
    ]);
    getDb()
      .prepare(
        `INSERT INTO kanji_mnemonics (char, meaning, reading, reading_key, provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('言', 'my own meaning', 'my own sound', 'ゴン', 'test', new Date().toISOString());

    const got = cachedKanjiMnemonics(['言', '口']);
    // Regenerating a character on purpose is a deliberate act, so it wins.
    expect(got['言'].meaning).toBe('my own meaning');
    expect(got['口'].meaning).toBe('shipped mouth');
  });
});

describe('what is allowed into a hook', () => {
  test('answers for characters that were not asked about are dropped', () => {
    const asked = [facts('言', ['ゲン'])];
    const reply = JSON.stringify({
      kanji: [
        { char: '言', meaning: 'm', reading: 'r', readingKey: 'ゲン' },
        { char: '花', meaning: 'not asked for', reading: 'r', readingKey: 'カ' },
      ],
    });
    const out = parseKanjiMnemonics(reply, asked);
    expect(out.map((h) => h.char)).toEqual(['言']);
  });

  test('half an answer is no answer', () => {
    const asked = [facts('言', ['ゲン']), facts('口', ['コウ']), facts('五', ['ゴ'])];
    const reply = JSON.stringify({
      kanji: [
        { char: '言', meaning: 'm', reading: '' },
        { char: '口', meaning: '', reading: 'r' },
        { char: '五', meaning: 'm', reading: 'r', readingKey: 'ゴ' },
      ],
    });
    expect(parseKanjiMnemonics(reply, asked).map((h) => h.char)).toEqual(['五']);
  });

  test('a reading the character does not have is not recorded as one', () => {
    const asked = [facts('言', ['ゲン', 'ゴン'], ['い.う'])];
    const invented = JSON.stringify({
      kanji: [{ char: '言', meaning: 'm', reading: 'r', readingKey: 'ズバ' }],
    });
    // The hook is kept — it may still be a fine image — but the claim about which
    // reading it teaches is dropped rather than shown as fact.
    expect(parseKanjiMnemonics(invented, asked)[0].readingKey).toBe('');

    const real = JSON.stringify({
      kanji: [{ char: '言', meaning: 'm', reading: 'r', readingKey: 'ゴン' }],
    });
    expect(parseKanjiMnemonics(real, asked)[0].readingKey).toBe('ゴン');
  });

  test('a kun reading with its okurigana dot still counts', () => {
    const asked = [facts('言', ['ゲン'], ['い.う'])];
    const reply = JSON.stringify({
      kanji: [{ char: '言', meaning: 'm', reading: 'r', readingKey: 'いう' }],
    });
    expect(parseKanjiMnemonics(reply, asked)[0].readingKey).toBe('いう');
  });

  test('the same character twice keeps only the first', () => {
    const asked = [facts('言', ['ゲン'])];
    const reply = JSON.stringify({
      kanji: [
        { char: '言', meaning: 'first', reading: 'r', readingKey: 'ゲン' },
        { char: '言', meaning: 'second', reading: 'r', readingKey: 'ゲン' },
      ],
    });
    const out = parseKanjiMnemonics(reply, asked);
    expect(out).toHaveLength(1);
    expect(out[0].meaning).toBe('first');
  });
});

describe('the prompt', () => {
  test('carries the parts and the names already given to them', () => {
    const prompt = kanjiMnemonicPrompt(
      [{ ...facts('語', ['ゴ']), components: ['言', '口', '五'] }],
      [
        ['言', 'say'],
        ['五', 'five'],
      ],
    );
    expect(prompt).toContain('parts: 言 口 五');
    expect(prompt).toContain('言 = say');
    expect(prompt).toContain('五 = five');
    expect(prompt).toContain('Use these exact words');
  });

  test('says nothing about names when there are none to reuse', () => {
    const prompt = kanjiMnemonicPrompt([facts('言', ['ゲン'])]);
    expect(prompt).not.toContain('Names already in use');
    expect(prompt).not.toContain('parts:');
  });
});

describe('checking that a sound hook uses its sound', () => {
  test('accepts a hook built on the reading', () => {
    expect(readingHookLooksSound("Say 'Yah!' as you watch the moon", 'ヤ')).toBe(true);
    expect(readingHookLooksSound('A pigeon coos KUU in the empty sky', 'クウ')).toBe(true);
    expect(readingHookLooksSound('a SHINY mirror', 'シ')).toBe(true);
    expect(readingHookLooksSound('a GENtleman speaks first', 'ゲン')).toBe(true);
  });

  test('a long vowel need not be spelled out in full', () => {
    // クウ is "kuu", but a hook that says "ku" is still built on the sound.
    expect(readingHookLooksSound('a KUngfu kick through empty air', 'クウ')).toBe(true);
    expect(readingHookLooksSound('a COat for the cold', 'コウ')).toBe(false);
  });

  test('rejects a hook that never makes the sound', () => {
    expect(readingHookLooksSound('The moon is very bright tonight', 'ヤ')).toBe(false);
    expect(readingHookLooksSound('An empty field at dawn', 'コウ')).toBe(false);
  });

  test('a single-vowel reading is not checked, since looking for "a" proves nothing', () => {
    expect(readingHookLooksSound('anything at all', 'ア')).toBe(true);
    expect(readingHookLooksSound('nothing of the sort', 'イ')).toBe(true);
  });

  test('a two-kana vowel reading is still checked', () => {
    // オウ is "ou", which is a real string to look for — unlike a bare "o".
    expect(readingHookLooksSound('an OUtstanding roar', 'オウ')).toBe(true);
    expect(readingHookLooksSound('a quiet field at dusk', 'オウ')).toBe(false);
  });

  test('a missing reading key cannot be verified', () => {
    expect(readingHookLooksSound('a fine image', '')).toBe(false);
  });

  test('hiragana keys are checked the same as katakana', () => {
    expect(readingHookLooksSound('a YUle log burning', 'ゆ')).toBe(true);
    expect(readingHookLooksSound('nothing like it', 'ゆ')).toBe(false);
  });

  test('a hook that only sounds nearby is re-asked, not kept quietly', () => {
    // "you" has no "yu" in it. The check is deliberately literal: the cost of a
    // false alarm is one more request, and the second answer is kept regardless.
    expect(readingHookLooksSound("she said 'you' twice", 'ゆ')).toBe(false);
  });
});
