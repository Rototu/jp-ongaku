import { getDb, nowIso } from '../db';
import { freshState } from './sm2';
import { normalizeReading, typedToKana } from '../../shared/kana';
import type { CardBack, CardFront, FuriganaSegment } from '../../shared/types';

/**
 * Recall cards: the meaning in English, the word typed back in Japanese.
 *
 * Every other card in the deck is recognition — Japanese in, something out —
 * and being able to read a word is not being able to say it. A recall card
 * turns the vocabulary card around, so the word has to be produced from
 * nothing but its meaning.
 *
 * They are not made with the lesson. Producing a word is much harder than
 * reading it, and a recall card for a word never seen before is a guessing
 * game, so one unlocks only once its vocabulary card has held for
 * RECALL_UNLOCK_DAYS — the word is familiar by then, and the user has earned
 * the harder question. Retired vocabulary cards stay retired: the user took the
 * word out of rotation, and a new card for it would put it straight back.
 */

/** Interval the vocabulary card must reach before its recall card exists. */
export const RECALL_UNLOCK_DAYS = 3;

const PROMPT = 'How do you say this in Japanese?';

function parse<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Creates the recall cards whose vocabulary card has earned one.
 *
 * Idempotent: a word with a recall card already is skipped, so this runs safely
 * after every grade and once at startup to cover decks that were past the bar
 * before recall cards existed. Pass `wordId` to check just one word.
 *
 * Returns how many cards were created.
 */
export function unlockRecallCards(wordId?: number): number {
  const db = getDb();
  const rows = db
    .query<
      {
        word_id: number;
        song_id: number | null;
        line_id: number | null;
        lemma: string;
        reading: string;
        romaji: string;
        furigana: string;
        glosses: string;
      },
      { $days: number; $word: number | null }
    >(
      `SELECT c.word_id, c.song_id, c.line_id,
              w.lemma, w.reading, w.romaji, w.furigana, w.glosses
       FROM cards c
       JOIN srs r ON r.card_id = c.id
       JOIN words w ON w.id = c.word_id
       WHERE c.kind = 'vocab'
         AND r.suspended = 0
         AND r.interval_days >= $days
         AND ($word IS NULL OR c.word_id = $word)
         AND NOT EXISTS (
           SELECT 1 FROM cards x WHERE x.dedupe_key = 'recall:' || c.word_id
         )`,
    )
    .all({ $days: RECALL_UNLOCK_DAYS, $word: wordId ?? null });

  const insCard = db.prepare(
    `INSERT INTO cards (kind, song_id, line_id, word_id, grammar_id, dedupe_key, front, back, created_at)
     VALUES ('recall', ?, ?, ?, NULL, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING id`,
  );
  const insSrs = db.prepare(
    `INSERT INTO srs (card_id, due_at) VALUES (?, ?) ON CONFLICT (card_id) DO NOTHING`,
  );

  let created = 0;
  const now = nowIso();
  db.transaction(() => {
    for (const row of rows) {
      const glosses = parse<string[]>(row.glosses, []);
      // A gloss that is the word in romaji — "sushi" for 寿司, "karaoke" for
      // カラオケ — is the answer printed on the question. Those go, and a word
      // with nothing else to say for itself gets no recall card.
      const reading = normalizeReading(row.reading);
      const clues = glosses.filter(
        (g) => normalizeReading(typedToKana(g.toLowerCase())) !== reading,
      );
      if (clues.length === 0) continue;
      // The front carries the meaning and nothing else: no headword, no ruby,
      // no romaji. Any of those is the answer.
      const front: CardFront = {
        prompt: PROMPT,
        meaning: clues.slice(0, 3).join('; '),
      };
      const back: CardBack = {
        answer: row.lemma,
        reading: row.reading,
        romaji: row.romaji,
        furigana: parse<FuriganaSegment[]>(row.furigana, []),
        glosses,
      };
      const card = insCard.get(
        row.song_id,
        row.line_id,
        row.word_id,
        `recall:${row.word_id}`,
        JSON.stringify(front),
        JSON.stringify(back),
        now,
      ) as { id: number } | null;
      if (!card) continue;
      insSrs.run(card.id, freshState().dueAt);
      created++;
    }
  })();
  return created;
}
