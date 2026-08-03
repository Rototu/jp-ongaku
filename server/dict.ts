import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { DICT_DB } from './paths';
import type { DictEntryLite, DictSense, FuriganaSegment } from '../shared/types';

const KANJI_RE = /[㐀-䶿一-鿿豈-﫿々]/;
const hasKanjiChar = (s: string) => KANJI_RE.test(s);

/** JMdict tags marking a sense as not current usage. */
const DEAD_TAGS = new Set(['arch', 'obs', 'obsc', 'rare', 'dated']);

/**
 * Ranks competing entries for the same term.
 *
 * The two cases this exists for: なる matching the archaic classical copula
 * instead of 成る "to become", and kana-written いつか matching 五日 "the 5th"
 * instead of 何時か "someday". Archaic entries are pushed down hard, and for
 * kana input the 'uk' tag ("usually written in kana alone") is a strong signal
 * that this is the spelling the writer meant.
 */
function rank(entry: DictEntryLite, term: string, wantKana: boolean): number {
  let score = 0;

  const allArchaic = entry.senses.every((s) =>
    [...s.misc, ...s.info].some((t) => DEAD_TAGS.has(t)),
  );
  if (allArchaic) score -= 100;

  if (wantKana) {
    if (entry.senses.some((s) => s.misc.includes('uk'))) score += 30;
    if (entry.headword === term) score += 20;
  }

  if (entry.common) score += 10;
  if (entry.freqRank !== null) score += Math.max(0, 12 - Math.log10(Math.max(entry.freqRank, 10)));

  return score;
}

interface EntryRow {
  id: string;
  headword: string;
  reading: string;
  common: number;
  freq_rank: number | null;
  jlpt: number | null;
  senses: string;
}

interface KanjiInfo {
  char: string;
  meanings: string[];
  on: string[];
  kun: string[];
  grade: number | null;
  freq: number | null;
  strokes: number | null;
}

/**
 * Read-only access to data/dict.db. Missing database is not fatal: every
 * lookup returns empty, so the app still tokenises and shows readings while
 * telling the user to run `bun run dict`.
 */
class Dict {
  private db: Database | null = null;
  readonly available: boolean;

  constructor() {
    this.available = existsSync(DICT_DB);
    if (this.available) {
      this.db = new Database(DICT_DB, { readonly: true });
      this.db.exec('PRAGMA query_only = ON');
    }
  }

  private toEntry(row: EntryRow): DictEntryLite {
    return {
      id: row.id,
      headword: row.headword,
      reading: row.reading,
      common: row.common === 1,
      freqRank: row.freq_rank,
      jlpt: row.jlpt,
      senses: JSON.parse(row.senses) as DictSense[],
    };
  }

  /** All entries whose kanji or kana form exactly equals `term`. */
  entriesFor(term: string): DictEntryLite[] {
    if (!this.db) return [];
    const rows = this.db
      .query<EntryRow, [string]>(
        `SELECT e.* FROM terms t JOIN entries e ON e.id = t.entry_id
         WHERE t.term = ?
         ORDER BY e.common DESC, COALESCE(e.freq_rank, 999999) ASC
         LIMIT 12`,
      )
      .all(term);
    return rows.map((r) => this.toEntry(r));
  }

  /**
   * Every reading the dictionary lists for a term, most standard first.
   *
   * `entriesFor` carries one reading per entry — the first kana form — because an
   * entry needs a single lemma reading to display. But JMdict lists all of them
   * against the same entry, and the alternates are exactly the interesting ones:
   * 今日 is きょう / こんにち / こんじつ, 明日 is あした / あす / みょうにち. They
   * survive in the terms index, so reading a word's possibilities costs one query
   * and no rebuild. Ordering is entry commonness, then JMdict's own order within
   * an entry, which puts the standard reading first.
   */
  readingsFor(term: string): string[] {
    if (!this.db) return [];
    // A term already written in kana reads as itself. Looking it up would drag in
    // the other kana forms of whatever entries happen to share it — は would offer
    // はね (from 羽), が would offer ヶ and け — which are alternative spellings of
    // other words, not ways to pronounce this one.
    if (!hasKanjiChar(term)) return [term];

    const rows = this.db
      .query<{ term: string }, [string]>(
        // Only where the term is the *kanji* form: then every kana form of the
        // entry is a way to read it.
        `SELECT k.term FROM terms t
           JOIN entries e ON e.id = t.entry_id
           JOIN terms k ON k.entry_id = e.id AND k.kind = 'kana'
         WHERE t.term = ? AND t.kind = 'kanji'
         ORDER BY e.common DESC, COALESCE(e.freq_rank, 999999) ASC, k.rowid ASC
         LIMIT 24`,
      )
      .all(term);

    const readings: string[] = [];
    for (const row of rows) if (!readings.includes(row.term)) readings.push(row.term);
    return readings;
  }

  /**
   * Best entry for a word.
   *
   * Tries the dictionary form first (走る beats the noun 走り for a conjugated
   * verb), then the surface form. Within a term, an entry whose reading matches
   * what the tokenizer heard wins, which separates homographs like
   * 今日 きょう from こんにち.
   *
   * When the word is written in kana, a kana-headword entry is preferred over a
   * kanji one — otherwise いつか ("someday") resolves to 五日 ("the 5th").
   */
  lookup(args: {
    surface: string;
    reading?: string;
    baseForm?: string;
    baseReading?: string;
  }): DictEntryLite | undefined {
    const { surface, reading, baseForm, baseReading } = args;
    const terms = [baseForm, surface].filter(
      (x): x is string => typeof x === 'string' && x.length > 0,
    );
    const wantKana = !hasKanjiChar(surface);

    for (const term of terms) {
      const entries = this.entriesFor(term);
      if (entries.length === 0) continue;

      // Reading match narrows the field first; when several entries share the
      // reading (五日 and 何時か are both いつか) ranking decides.
      let pool = entries;
      for (const want of [baseReading, reading]) {
        if (!want) continue;
        const matches = entries.filter((e) => e.reading === want);
        if (matches.length > 0) {
          pool = matches;
          break;
        }
      }

      const ranked = [...pool].sort((a, b) => rank(b, term, wantKana) - rank(a, term, wantKana));
      return ranked[0];
    }
    return undefined;
  }

  /** Authoritative kanji->reading alignment from JmdictFurigana, when present. */
  furigana(headword: string, reading: string): FuriganaSegment[] | undefined {
    if (!this.db) return undefined;
    const row = this.db
      .query<{ segments: string }, [string, string]>(
        'SELECT segments FROM furigana WHERE headword = ? AND reading = ?',
      )
      .get(headword, reading);
    return row ? (JSON.parse(row.segments) as FuriganaSegment[]) : undefined;
  }

  kanji(char: string): KanjiInfo | undefined {
    if (!this.db) return undefined;
    const row = this.db
      .query<
        {
          char: string;
          meanings: string;
          on_yomi: string;
          kun_yomi: string;
          grade: number | null;
          freq: number | null;
          strokes: number | null;
        },
        [string]
      >('SELECT * FROM kanji WHERE char = ?')
      .get(char);
    if (!row) return undefined;
    return {
      char: row.char,
      meanings: JSON.parse(row.meanings) as string[],
      on: JSON.parse(row.on_yomi) as string[],
      kun: JSON.parse(row.kun_yomi) as string[],
      grade: row.grade,
      freq: row.freq,
      strokes: row.strokes,
    };
  }

  stats(): { entries: number; kanji: number; builtAt: string | null } {
    if (!this.db) return { entries: 0, kanji: 0, builtAt: null };
    const e = this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM entries').get();
    const k = this.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM kanji').get();
    const m = this.db
      .query<{ v: string }, []>("SELECT v FROM meta WHERE k = 'built_at'")
      .get();
    return { entries: e?.n ?? 0, kanji: k?.n ?? 0, builtAt: m?.v ?? null };
  }
}

let instance: Dict | null = null;

export function dict(): Dict {
  if (!instance) instance = new Dict();
  return instance;
}

export type { KanjiInfo };
