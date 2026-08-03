import { getDb } from '../db';
import type { AnalyzedToken } from '../nlp/tokenize';
import { lineKana, lineRomaji } from '../nlp/tokenize';
import { CLOZE_BLANK, lineFurigana } from './build';
import { alignFurigana } from '../nlp/furigana';
import { toRomaji } from '../nlp/kana';
import type { CardBack, CardFront } from '../../shared/types';

/**
 * Adds missing furigana and romaji to cards created before those fields existed.
 *
 * Grammar and cloze fronts used to render the example line as bare kanji, and
 * cloze/listening answers had no ruby — unusable for a learner who reads little
 * kanji. Rebuilding from the line's stored tokens avoids re-importing songs and
 * keeps every card id, so review history is untouched.
 */
export function backfillCardReadings(): number {
  const db = getDb();

  const rows = db
    .query<
      { id: number; kind: string; front: string; back: string; tokens: string | null },
      []
    >(
      `SELECT c.id, c.kind, c.front, c.back, l.tokens
       FROM cards c
       LEFT JOIN lines l ON l.id = c.line_id
       WHERE c.kind IN ('grammar', 'cloze', 'listening')`,
    )
    .all();

  const update = db.prepare('UPDATE cards SET front = ?, back = ? WHERE id = ?');
  let fixed = 0;

  db.transaction(() => {
    for (const row of rows) {
      if (!row.tokens) continue;

      const front = JSON.parse(row.front) as CardFront;
      const back = JSON.parse(row.back) as CardBack;
      const tokens = JSON.parse(row.tokens) as AnalyzedToken[];
      let changed = false;

      if (row.kind === 'grammar' && !front.furigana?.length) {
        front.furigana = lineFurigana(tokens);
        if (!front.romaji) front.romaji = lineRomaji(tokens);
        changed = true;
      }

      if (row.kind === 'cloze') {
        const blankIdx = front.blankIdx;
        if (!front.furigana?.length && typeof blankIdx === 'number') {
          front.furigana = lineFurigana(tokens, blankIdx);
          changed = true;
        }
        if (!back.furigana?.length && typeof blankIdx === 'number') {
          const target = tokens[blankIdx];
          if (target) {
            back.furigana = target.furigana;
            if (!back.reading) back.reading = target.reading;
            if (!back.romaji) back.romaji = target.romaji;
            changed = true;
          }
        }
      }

      if (row.kind === 'listening') {
        if (!back.furigana?.length) {
          back.furigana = lineFurigana(tokens);
          changed = true;
        }
        if (!back.reading) {
          back.reading = lineKana(tokens);
          changed = true;
        }
        if (!back.romaji) {
          back.romaji = lineRomaji(tokens);
          changed = true;
        }
      }

      if (changed) {
        update.run(JSON.stringify(front), JSON.stringify(back), row.id);
        fixed++;
      }
    }
  })();

  return fixed;
}

/**
 * Realigns stored vocabulary readings onto the dictionary form.
 *
 * `words.furigana`/`words.romaji` used to be copied from the token that
 * introduced the word, which describes the inflected surface (探している) rather
 * than the lemma the row stores (探す). Anywhere the lemma was shown — vocab card
 * fronts, the song vocabulary table, cloze distractors — the ruby belonged to a
 * different word. Recomputed from lemma + reading, which is deterministic.
 */
export function realignWordReadings(): number {
  const db = getDb();
  const rows = db
    .query<
      { id: number; lemma: string; reading: string; furigana: string; romaji: string },
      []
    >('SELECT id, lemma, reading, furigana, romaji FROM words')
    .all();

  const updateWord = db.prepare('UPDATE words SET furigana = ?, romaji = ? WHERE id = ?');
  const updateCard = db.prepare('UPDATE cards SET front = ?, back = ? WHERE id = ?');
  let fixed = 0;

  db.transaction(() => {
    for (const row of rows) {
      const expected = alignFurigana(row.lemma, row.reading);
      const expectedRomaji = toRomaji(row.reading);
      const stored = safeSegments(row.furigana);

      // The word row and its card are checked independently. A row that is
      // already correct can still have a card carrying the old surface reading,
      // so skipping the card when the row looks fine leaves the visible bug in
      // place — which is exactly what happened the first time round.
      const rowOk =
        stored.map((s) => s.text).join('') === row.lemma && row.romaji === expectedRomaji;
      if (!rowOk) {
        updateWord.run(JSON.stringify(expected), expectedRomaji, row.id);
        fixed++;
      }

      const card = db
        .query<{ id: number; front: string; back: string }, [number]>(
          "SELECT id, front, back FROM cards WHERE word_id = ? AND kind = 'vocab'",
        )
        .get(row.id);
      if (!card) continue;

      const front = JSON.parse(card.front) as CardFront;
      const back = JSON.parse(card.back) as CardBack;
      const frontOk =
        (front.furigana ?? []).map((s) => s.text).join('') === (front.jp ?? '') &&
        front.romaji === expectedRomaji;
      if (rowOk && frontOk) continue;

      front.jp = row.lemma;
      front.furigana = expected;
      front.romaji = expectedRomaji;
      back.reading = row.reading;
      back.romaji = expectedRomaji;
      updateCard.run(JSON.stringify(front), JSON.stringify(back), card.id);
      if (rowOk) fixed++;
    }
  })();

  return fixed;
}

/**
 * Fills in `word_songs.seen_as` for links made before the column existed.
 *
 * The surface is recoverable without re-importing: every line stores its parsed
 * tokens, and the token that introduced a word is the one whose dictionary entry
 * matches the word's lemma and reading. Until this runs, a word whose headword is
 * not what the lyrics show — の filed under 乃 — has no bar under it, because
 * nothing on the page can be matched to its SRS state.
 */
export function backfillWordSurfaces(): number {
  const db = getDb();
  const rows = db
    .query<
      { word_id: number; line_id: number; lemma: string; reading: string; tokens: string | null },
      []
    >(
      `SELECT ws.word_id, ws.line_id, w.lemma, w.reading, l.tokens
       FROM word_songs ws
       JOIN words w ON w.id = ws.word_id
       LEFT JOIN lines l ON l.id = ws.line_id
       WHERE ws.seen_as IS NULL`,
    )
    .all();

  const update = db.prepare(
    'UPDATE word_songs SET seen_as = ? WHERE word_id = ? AND line_id = ?',
  );
  let filled = 0;

  db.transaction(() => {
    for (const row of rows) {
      if (!row.tokens) continue;
      let tokens: AnalyzedToken[];
      try {
        tokens = JSON.parse(row.tokens) as AnalyzedToken[];
      } catch {
        continue;
      }
      const match = tokens.find(
        (t) => t.entry?.headword === row.lemma && t.entry?.reading === row.reading,
      );
      if (!match) continue;
      update.run(match.surface, row.word_id, row.line_id);
      filled++;
    }
  })();

  return filled;
}

function safeSegments(json: string): { text: string; ruby: string }[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Sanity check used by the UI/tests: cards that still show unreadable kanji. */
export function cardsMissingReadings(): number {
  const db = getDb();
  return (
    db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM cards
         WHERE kind IN ('grammar', 'cloze')
           AND json_extract(front, '$.furigana') IS NULL`,
      )
      .get()?.n ?? 0
  );
}

export { CLOZE_BLANK };
