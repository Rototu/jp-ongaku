import { getDb, nowIso } from '../db';
import type { AnalyzedToken } from '../nlp/tokenize';
import { lineRomaji } from '../nlp/tokenize';
import { lineFurigana } from './build';
import { freshState } from '../srs/sm2';
import type { CardBack, CardFront } from '../../shared/types';

/**
 * Makes grammar cards belong to the song they show a line from.
 *
 * Grammar cards used to be keyed by pattern alone (`grammar:negative`), on the
 * theory that one pattern deserves one card. But the front of a grammar card is
 * a lyric from a specific song, and re-import only updates front/back — so the
 * second song to use 〜ない overwrote the example while `song_id`/`line_id`
 * stayed on the first song. Studying "this song" then served a line from a
 * different one, and the later song got no card at all.
 *
 * This rekeys existing cards to `grammar:<song_id>:<key>`, rebuilds their
 * example from the line they actually point at, and creates the per-song cards
 * that the shared key had swallowed. Card ids are preserved, so review history
 * survives.
 */
export function rescopeGrammarCards(): { rekeyed: number; repaired: number; created: number } {
  const db = getDb();
  const now = nowIso();

  const rows = db
    .query<
      {
        id: number;
        dedupe_key: string;
        song_id: number | null;
        line_id: number | null;
        front: string;
        key: string | null;
        line_text: string | null;
        tokens: string | null;
      },
      []
    >(
      `SELECT c.id, c.dedupe_key, c.song_id, c.line_id, c.front,
              g.key, l.text AS line_text, l.tokens
       FROM cards c
       LEFT JOIN grammar_items g ON g.id = c.grammar_id
       LEFT JOIN lines l ON l.id = c.line_id
       WHERE c.kind = 'grammar'`,
    )
    .all();

  const rekey = db.prepare('UPDATE cards SET dedupe_key = ? WHERE id = ?');
  const updateFront = db.prepare('UPDATE cards SET front = ? WHERE id = ?');
  let rekeyed = 0;
  let repaired = 0;

  db.transaction(() => {
    for (const row of rows) {
      // A card with no key or no song cannot be scoped; leave it for the prune
      // pass to judge.
      if (!row.key || row.song_id === null) continue;

      const scoped = `grammar:${row.song_id}:${row.key}`;
      if (row.dedupe_key !== scoped) {
        rekey.run(scoped, row.id);
        rekeyed++;
      }

      // The example still holds whichever song imported last. Rebuild it from
      // this card's own line.
      if (!row.line_text || !row.tokens) continue;
      const front = JSON.parse(row.front) as CardFront;
      if (front.jp === row.line_text) continue;

      const tokens = parseTokens(row.tokens);
      if (!tokens) continue;
      front.jp = row.line_text;
      front.furigana = lineFurigana(tokens);
      front.romaji = lineRomaji(tokens);
      updateFront.run(JSON.stringify(front), row.id);
      repaired++;
    }
  })();

  return { rekeyed, repaired, created: createMissingGrammarCards(now) };
}

/**
 * Adds the grammar cards the shared key had suppressed.
 *
 * Every line stores its parsed tokens, and those tokens carry the grammar notes
 * detected at import — so the cards a song should have can be recovered without
 * re-importing it. The first line in the song that shows a pattern becomes its
 * example, matching what a fresh import would produce.
 */
function createMissingGrammarCards(now: string): number {
  const db = getDb();

  const lines = db
    .query<{ id: number; song_id: number; text: string; tokens: string }, []>(
      'SELECT id, song_id, text, tokens FROM lines ORDER BY song_id, idx',
    )
    .all();

  const existing = new Set(
    db
      .query<{ dedupe_key: string }, []>(
        "SELECT dedupe_key FROM cards WHERE kind = 'grammar'",
      )
      .all()
      .map((r) => r.dedupe_key),
  );

  const upsertGrammar = db.prepare(
    `INSERT INTO grammar_items (key, pattern, explanation, jlpt, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET explanation = excluded.explanation
     RETURNING id`,
  );
  const insCard = db.prepare(
    `INSERT INTO cards (kind, song_id, line_id, grammar_id, dedupe_key, front, back, created_at)
     VALUES ('grammar', ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  );
  const insSrs = db.prepare(
    `INSERT INTO srs (card_id, ease, interval_days, reps, lapses, due_at, leech, suspended)
     VALUES (?, 2.5, 0, 0, 0, ?, 0, 0)
     ON CONFLICT (card_id) DO NOTHING`,
  );
  let created = 0;

  db.transaction(() => {
    for (const line of lines) {
      const tokens = parseTokens(line.tokens);
      if (!tokens) continue;

      const notes = tokens.flatMap((t) => t.grammar ?? []);
      if (notes.length === 0) continue;

      for (const note of notes) {
        const key = `grammar:${line.song_id}:${note.key}`;
        if (existing.has(key)) continue;
        existing.add(key);

        const g = upsertGrammar.get(
          note.key,
          note.pattern,
          note.explanation,
          note.jlpt,
          now,
        ) as { id: number };
        const front: CardFront = {
          prompt: `What does ${note.pattern} do?`,
          jp: line.text,
          furigana: lineFurigana(tokens),
          romaji: lineRomaji(tokens),
        };
        const back: CardBack = { answer: note.pattern, note: note.explanation };
        const card = insCard.get(
          line.song_id,
          line.id,
          g.id,
          key,
          JSON.stringify(front),
          JSON.stringify(back),
          now,
        ) as { id: number };
        insSrs.run(card.id, freshState().dueAt);
        created++;
      }
    }
  })();

  return created;
}

function parseTokens(json: string): AnalyzedToken[] | null {
  try {
    const parsed = JSON.parse(json) as AnalyzedToken[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
