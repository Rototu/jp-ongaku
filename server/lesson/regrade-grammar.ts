import { getDb } from '../db';
import type { AnalyzedToken } from '../nlp/tokenize';
import { PATTERNS, markerPresent } from '../nlp/grammar';
import type { CardFront } from '../../shared/types';

/**
 * Removes grammar cards whose example line does not actually contain the form
 * they ask about.
 *
 * Detection used to match on inflected stems named after the particle that
 * attaches to them, so a line with 〜たら could produce a card asking "what does
 * 〜ば do?". Those cards are unanswerable, and re-importing a song will not clear
 * them because cards are keyed by pattern and kept across imports. This deletes
 * exactly the mismatched ones, leaving correct cards and their review history
 * untouched.
 */
export function pruneMismatchedGrammarCards(): { removed: number; checked: number } {
  const db = getDb();
  const byKey = new Map(PATTERNS.map((p) => [p.key, p]));

  const rows = db
    .query<
      { id: number; front: string; key: string | null; tokens: string | null },
      []
    >(
      `SELECT c.id, c.front, g.key, l.tokens
       FROM cards c
       LEFT JOIN grammar_items g ON g.id = c.grammar_id
       LEFT JOIN lines l ON l.id = c.line_id
       WHERE c.kind = 'grammar'`,
    )
    .all();

  const doomed: number[] = [];

  for (const row of rows) {
    // LLM-sourced notes have no entry in the local pattern table; they are the
    // model's own wording and are not checked here.
    if (!row.key) continue;
    const pattern = byKey.get(row.key);
    if (!pattern) continue;

    const front = JSON.parse(row.front) as CardFront;
    const exampleText =
      front.jp ??
      (row.tokens
        ? (JSON.parse(row.tokens) as AnalyzedToken[]).map((t) => t.surface).join('')
        : '');
    if (!exampleText) continue;

    if (!markerPresent(pattern, exampleText)) doomed.push(row.id);
  }

  if (doomed.length > 0) {
    const placeholders = doomed.map(() => '?').join(',');
    db.transaction(() => {
      db.prepare(`DELETE FROM cards WHERE id IN (${placeholders})`).run(...doomed);
    })();
  }

  return { removed: doomed.length, checked: rows.length };
}
