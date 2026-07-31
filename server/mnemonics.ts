import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { MNEMONIC_DB, MNEMONIC_JSONL, ensureDirs } from './paths';
import type { KanjiMnemonic } from '../shared/types';

/**
 * Read-only access to the shipped kanji mnemonic artifact.
 *
 * The canonical file is the JSONL, because that is the thing worth publishing:
 * text, one character per line, sorted by codepoint, so a diff shows exactly
 * which hooks changed and the set can be lifted out of this project entirely.
 * Reading 10,000 lines of JSON on every word tap would be silly, though, so the
 * JSONL is compiled into a small database the first time it is needed and after
 * every change to it.
 *
 * Everything here degrades to empty. A checkout with no artifact still runs: the
 * hooks are then written on demand, one word at a time, exactly as before.
 */

export interface MnemonicRow extends KanjiMnemonic {
  /** Components the hook was built from, for provenance. */
  components: string[];
}

let db: Database | null = null;
/** Signature of the JSONL the open database was compiled from. */
let compiledFrom = '';
/** Overridden by tests, so a test run never touches the real artifact. */
let jsonlPath = MNEMONIC_JSONL;
let dbPath = MNEMONIC_DB;

/** Cheap identity for the source file: size and mtime, no hashing of 2 MB. */
function signature(): string {
  if (!existsSync(jsonlPath)) return '';
  const s = statSync(jsonlPath);
  return `${s.size}:${Math.round(s.mtimeMs)}`;
}

function open(): Database | null {
  const sig = signature();
  if (sig === '') return null;
  if (db && compiledFrom === sig) return db;

  db?.close();
  db = null;

  ensureDirs();
  const stale =
    !existsSync(dbPath) ||
    (() => {
      try {
        const probe = new Database(dbPath, { readonly: true });
        const row = probe
          .query<{ v: string }, []>("SELECT v FROM meta WHERE k = 'source'")
          .get();
        probe.close();
        return row?.v !== sig;
      } catch {
        return true;
      }
    })();

  if (stale) {
    try {
      compile(sig);
    } catch {
      // The build script may be writing this very file, or the directory may be
      // read-only. Either way an out-of-date cache still answers most characters,
      // and a hook that is missing is written on demand as it always was.
    }
  }

  try {
    db = new Database(dbPath, { readonly: true });
    compiledFrom = sig;
    return db;
  } catch {
    return null;
  }
}

/**
 * Builds the database from the JSONL.
 *
 * Rebuilt wholesale rather than updated: it is a derived file, ten thousand rows
 * is under a second, and a half-applied update would be worse than either state.
 */
export function compile(sig = signature()): number {
  ensureDirs();
  const fresh = new Database(dbPath, { create: true });
  fresh.exec('PRAGMA journal_mode = DELETE');
  fresh.exec(`
    CREATE TABLE IF NOT EXISTS mnemonics (
      char        TEXT PRIMARY KEY,
      meaning     TEXT NOT NULL,
      reading     TEXT NOT NULL,
      reading_key TEXT NOT NULL DEFAULT '',
      components  TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  fresh.exec('DELETE FROM mnemonics');

  const insert = fresh.prepare(
    `INSERT INTO mnemonics (char, meaning, reading, reading_key, components)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (char) DO UPDATE SET
       meaning = excluded.meaning, reading = excluded.reading,
       reading_key = excluded.reading_key, components = excluded.components`,
  );

  let count = 0;
  if (existsSync(jsonlPath)) {
    // Read synchronously: this runs inside a lazy getter that callers do not
    // await, and two megabytes once per change is not worth making async.
    const body = readFileSync(jsonlPath, 'utf8');
    fresh.transaction(() => {
      for (const line of body.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const row = JSON.parse(trimmed) as Partial<MnemonicRow>;
          if (!row.char || !row.meaning || !row.reading) continue;
          insert.run(
            row.char,
            row.meaning,
            row.reading,
            row.readingKey ?? '',
            JSON.stringify(row.components ?? []),
          );
          count++;
        } catch {
          // One malformed line must not cost the other ten thousand.
        }
      }
    })();
  }

  fresh.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('source', sig);
  fresh.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run(
    'compiled_at',
    new Date().toISOString(),
  );
  fresh.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('rows', String(count));
  fresh.close();
  return count;
}

/** Hooks from the artifact for these characters. Empty when there is no artifact. */
export function shippedMnemonics(chars: string[]): Record<string, MnemonicRow> {
  const wanted = [...new Set(chars.filter((c) => c.length > 0))];
  if (wanted.length === 0) return {};
  const handle = open();
  if (!handle) return {};

  const rows = handle
    .query<
      { char: string; meaning: string; reading: string; reading_key: string; components: string },
      string[]
    >(
      `SELECT char, meaning, reading, reading_key, components FROM mnemonics
       WHERE char IN (${wanted.map(() => '?').join(',')})`,
    )
    .all(...wanted);

  const out: Record<string, MnemonicRow> = {};
  for (const row of rows) {
    let components: string[] = [];
    try {
      components = JSON.parse(row.components) as string[];
    } catch {
      components = [];
    }
    out[row.char] = {
      char: row.char,
      meaning: row.meaning,
      reading: row.reading,
      readingKey: row.reading_key,
      components,
    };
  }
  return out;
}

/** How much the artifact covers, for the settings page and for the build script. */
export function mnemonicStats(): { rows: number; compiledAt: string | null } {
  const handle = open();
  if (!handle) return { rows: 0, compiledAt: null };
  const rows = handle.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM mnemonics').get();
  const at = handle.query<{ v: string }, []>("SELECT v FROM meta WHERE k = 'compiled_at'").get();
  return { rows: rows?.n ?? 0, compiledAt: at?.v ?? null };
}

/**
 * Points the reader at a different pair of files, for tests.
 *
 * Called with no arguments it goes back to the shipped artifact. Tests must use
 * this: compiling over the real files would destroy an artifact that takes half
 * an hour and a few thousand model requests to rebuild.
 */
export function _setMnemonicSourceForTests(jsonl?: string, database?: string): void {
  db?.close();
  db = null;
  compiledFrom = '';
  jsonlPath = jsonl ?? MNEMONIC_JSONL;
  dbPath = database ?? MNEMONIC_DB;
}
