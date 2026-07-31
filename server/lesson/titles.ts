import type { FuriganaSegment } from '../../shared/types';
import { getDb } from '../db';
import { lineRomaji, tokenizeLine } from '../nlp/tokenize';
import { alignFurigana, segmentsToReading } from '../nlp/furigana';
import { readingToKana, toRomaji } from '../nlp/kana';

/**
 * Furigana and romaji for song and artist names.
 *
 * A library listing full of bare kanji titles is unreadable for someone who
 * doesn't read kanji — they can't tell which row is which song. Titles get the
 * same treatment as lyrics: ruby above, romaji below.
 */

export interface Annotated {
  furigana: FuriganaSegment[];
  romaji: string;
}

const JAPANESE_RE = /[぀-ゟ゠-ヿ一-鿿]/;

export async function annotate(text: string): Promise<Annotated | null> {
  const trimmed = text.trim();
  // Latin-only names (LiSA, YOASOBI) need nothing.
  if (!trimmed || !JAPANESE_RE.test(trimmed)) return null;

  const tokens = await tokenizeLine(trimmed);
  const furigana: FuriganaSegment[] = [];
  for (const token of tokens) {
    for (const seg of token.furigana) {
      const last = furigana[furigana.length - 1];
      if (last && !last.ruby && !seg.ruby) last.text += seg.text;
      else furigana.push({ ...seg });
    }
  }
  return { furigana, romaji: lineRomaji(tokens) };
}

/**
 * Applies a reading the user typed in, replacing the automatic guess.
 *
 * Song titles are coined proper nouns with readings no parser can derive —
 * 紅蓮華 is "Gurenge", not the 紅蓮 + 華 the tokenizer sees. Accepts kana or
 * romaji and converts to kana before aligning.
 */
export function annotateWithReading(text: string, reading: string): Annotated | null {
  const kana = readingToKana(reading);
  if (!kana) return null;
  return { furigana: alignFurigana(text.trim(), kana), romaji: toRomaji(kana) };
}

/** The reading currently displayed for a title, for pre-filling the edit box. */
export function currentReading(furigana: FuriganaSegment[] | null): string {
  if (!furigana) return '';
  return segmentsToReading(furigana);
}

/**
 * Fills in annotations for songs imported before this existed, or whose title
 * annotation failed. Cheap: one tokenizer pass per song name.
 */
export async function backfillTitles(): Promise<number> {
  const db = getDb();
  const rows = db
    .query<{ id: number; title: string; artist: string }, []>(
      `SELECT id, title, artist FROM songs
       WHERE title_romaji IS NULL OR artist_romaji IS NULL`,
    )
    .all();
  if (rows.length === 0) return 0;

  const update = db.prepare(
    `UPDATE songs SET title_furigana = ?, title_romaji = ?, artist_furigana = ?, artist_romaji = ?
     WHERE id = ?`,
  );

  let done = 0;
  for (const row of rows) {
    const title = await annotate(row.title);
    const artist = await annotate(row.artist);
    update.run(
      title ? JSON.stringify(title.furigana) : null,
      // Empty string marks "checked, nothing needed" so we don't retry latin
      // names on every boot.
      title ? title.romaji : '',
      artist ? JSON.stringify(artist.furigana) : null,
      artist ? artist.romaji : '',
      row.id,
    );
    done++;
  }
  return done;
}
