import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { _setDbForTests, getDb } from '../server/db';
import { annotate, annotateWithReading, backfillTitles } from '../server/lesson/titles';
import { segmentsToReading } from '../server/nlp/furigana';

beforeEach(() => {
  _setDbForTests(new Database(':memory:'));
});

afterEach(() => {
  _setDbForTests(null);
});

describe('title annotation', () => {
  test('annotates a kanji title with furigana and romaji', async () => {
    const result = await annotate('夜空');
    expect(result).not.toBeNull();
    expect(segmentsToReading(result!.furigana)).toBe('よぞら');
    expect(result!.romaji).toBe('yozora');
  });

  test('returns null for latin-script names', async () => {
    expect(await annotate('LiSA')).toBeNull();
    expect(await annotate('YOASOBI')).toBeNull();
    expect(await annotate('')).toBeNull();
  });

  test('handles kana-only titles without adding ruby', async () => {
    const result = await annotate('ひかり');
    expect(result).not.toBeNull();
    expect(result!.romaji).toBe('hikari');
    expect(result!.furigana.every((s) => s.ruby === '')).toBe(true);
  });
});

describe('manual reading override', () => {
  test('accepts kana and realigns the furigana', () => {
    // A coined title the tokenizer cannot get right on its own.
    const result = annotateWithReading('紅蓮華', 'ぐれんげ');
    expect(result).not.toBeNull();
    expect(result!.romaji).toBe('gurenge');
    expect(segmentsToReading(result!.furigana)).toBe('ぐれんげ');
    expect(result!.furigana.map((s) => s.text).join('')).toBe('紅蓮華');
  });

  test('accepts romaji input too', () => {
    const result = annotateWithReading('紅蓮華', 'gurenge');
    expect(result).not.toBeNull();
    expect(result!.romaji).toBe('gurenge');
    expect(segmentsToReading(result!.furigana)).toBe('ぐれんげ');
  });

  test('rejects an empty reading', () => {
    expect(annotateWithReading('紅蓮華', '   ')).toBeNull();
  });

  test('keeps the surface intact even when alignment cannot be derived', () => {
    const result = annotateWithReading('夜空', 'まったくちがう');
    expect(result).not.toBeNull();
    expect(result!.furigana.map((s) => s.text).join('')).toBe('夜空');
  });
});

describe('backfill', () => {
  const insertSong = (title: string, artist: string) =>
    getDb()
      .prepare(
        `INSERT INTO songs (title, artist, source, synced, analyzed, created_at)
         VALUES (?, ?, 'paste', 0, 0, datetime('now')) RETURNING id`,
      )
      .get(title, artist) as { id: number };

  test('annotates songs missing annotations', async () => {
    const song = insertSong('夜空', 'LiSA');
    const done = await backfillTitles();
    expect(done).toBe(1);

    const row = getDb()
      .query<{ title_romaji: string; title_furigana: string }, [number]>(
        'SELECT title_romaji, title_furigana FROM songs WHERE id = ?',
      )
      .get(song.id);
    expect(row?.title_romaji).toBe('yozora');
    // 夜空 aligns per kanji: 夜/よ + 空/ぞら.
    expect(JSON.parse(row!.title_furigana)).toEqual([
      { text: '夜', ruby: 'よ' },
      { text: '空', ruby: 'ぞら' },
    ]);
  });

  test('does not re-process songs it has already seen', async () => {
    insertSong('夜空', 'LiSA');
    expect(await backfillTitles()).toBe(1);
    // Latin artist names store an empty marker rather than NULL, so the second
    // pass must find nothing to do.
    expect(await backfillTitles()).toBe(0);
  });

  test('leaves latin titles without furigana', async () => {
    const song = insertSong('Sunny Day', 'LiSA');
    await backfillTitles();
    const row = getDb()
      .query<{ title_romaji: string | null; title_furigana: string | null }, [number]>(
        'SELECT title_romaji, title_furigana FROM songs WHERE id = ?',
      )
      .get(song.id);
    expect(row?.title_furigana).toBeNull();
    expect(row?.title_romaji).toBe('');
  });
});
