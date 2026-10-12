import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const ROOT = dirname(import.meta.dir);
export const DATA_DIR = join(ROOT, 'data');
export const RAW_DIR = join(DATA_DIR, 'raw');
export const DICT_DB = join(DATA_DIR, 'dict.db');
export const USER_DB = join(DATA_DIR, 'ongaku.db');
/**
 * The local replica of the online database. A separate file on purpose: a
 * replica carries sync metadata a plain SQLite file does not, and ongaku.db
 * stays untouched as the offline copy it was before the move.
 */
export const REPLICA_DB = join(DATA_DIR, 'ongaku-online.db');
/**
 * The kanji mnemonic artifact: a hook for the meaning and one for the sound, for
 * every character in the dictionary.
 *
 * Two files on purpose. The JSONL is the canonical one — text, one object per
 * line, sorted, so git diffs are readable and the whole thing can be lifted out
 * and published on its own. The database is derived from it and exists only to
 * be read quickly; it is rebuilt whenever the JSONL is newer, so a fresh clone
 * needs no model and no build step.
 */
export const MNEMONIC_DIR = join(DATA_DIR, 'mnemonics');
export const MNEMONIC_JSONL = join(MNEMONIC_DIR, 'kanji-mnemonics.jsonl');
export const MNEMONIC_META = join(MNEMONIC_DIR, 'meta.json');
export const MNEMONIC_DB = join(DATA_DIR, 'mnemonics.db');
export const DIST_DIR = join(ROOT, 'dist');
export const CONFIG_FILE = join(ROOT, 'config.local.json');

/**
 * Where the user database lives online, when it does.
 *
 * Read from the environment first, then from config.local.json — never from
 * the database itself, which is the thing it points at. Both fields must be
 * set; with neither, data/ongaku.db is a plain local file as it always was.
 */
export function remoteDbConfig(): { syncUrl: string; authToken: string } | null {
  let file: { tursoUrl?: string; tursoToken?: string } = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    /* no config file, or not JSON: local mode */
  }
  const syncUrl = process.env.TURSO_DATABASE_URL ?? file.tursoUrl;
  const authToken = process.env.TURSO_AUTH_TOKEN ?? file.tursoToken;
  return syncUrl && authToken ? { syncUrl, authToken } : null;
}

export function ensureDirs() {
  mkdirSync(DATA_DIR, { recursive: true });
  mkdirSync(RAW_DIR, { recursive: true });
  mkdirSync(MNEMONIC_DIR, { recursive: true });
}
