import { Database } from "bun:sqlite";
import { USER_DB, ensureDirs } from "./paths";

/**
 * The user's own database: songs, lessons, cards, review history, progress.
 * Deliberately separate from data/dict.db so it stays small enough to copy or
 * back up by hand.
 */

const SCHEMA_VERSION = 7;

export { SCHEMA_VERSION };

let db: Database | null = null;

export function getDb(): Database {
  if (db) return db;
  ensureDirs();
  db = new Database(USER_DB, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/**
 * Closes and forgets the cached handle; the next getDb() reopens from disk.
 * Exists for restore: the file is replaced underneath the app, so every cached
 * handle is stale the moment the rename lands.
 */
export function closeDb(): void {
  if (!db) return;
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  } catch {
    /* closing a handle that is somehow already gone is fine */
  }
  db = null;
}

/**
 * Brings a database up to the current schema.
 *
 * Every step here is idempotent — `CREATE TABLE IF NOT EXISTS`, and a
 * `PRAGMA table_info` check before each `ALTER` — so they all run on every boot
 * rather than behind the recorded version. That version used to gate the work,
 * which made a single bad state permanent: bump SCHEMA_VERSION, have any process
 * open the database before its step is written, and the version says "done" while
 * the column is missing. The recorded version is now a record, not a gate; only
 * genuinely destructive steps should ever be gated on it.
 */
function migrate(d: Database) {
  d.exec(
    `CREATE TABLE IF NOT EXISTS schema_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`,
  );

  createBaseSchema(d);
  addTitleAnnotationColumns(d); // v2
  addChunkColumn(d); // v3
  addSongContextColumn(d); // v4
  addFavouriteColumn(d); // v5
  // v6 adds the kanji_mnemonics table, which createBaseSchema above already
  // covers — a new table needs no step of its own.
  addSeenAsColumn(d); // v7

  d.prepare("INSERT OR REPLACE INTO schema_meta (k, v) VALUES (?, ?)").run(
    "version",
    String(SCHEMA_VERSION),
  );
}

/**
 * Every column a migration has ever added, as a complete literal statement.
 *
 * ALTER TABLE and PRAGMA take identifiers, which SQLite cannot parameterize —
 * so the SQL is written out in full here and looked up by key. Nothing is ever
 * interpolated into DDL, and an unknown column is a hard error instead of a
 * silently wrong ALTER.
 */
const MIGRATION_COLUMNS: Record<string, Record<string, string>> = {
  songs: {
    title_furigana: "ALTER TABLE songs ADD COLUMN title_furigana TEXT",
    title_romaji: "ALTER TABLE songs ADD COLUMN title_romaji TEXT",
    artist_furigana: "ALTER TABLE songs ADD COLUMN artist_furigana TEXT",
    artist_romaji: "ALTER TABLE songs ADD COLUMN artist_romaji TEXT",
    context: "ALTER TABLE songs ADD COLUMN context TEXT",
    favourite:
      "ALTER TABLE songs ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0",
  },
  line_analysis: {
    chunks:
      "ALTER TABLE line_analysis ADD COLUMN chunks TEXT NOT NULL DEFAULT '[]'",
  },
  word_songs: {
    seen_as: "ALTER TABLE word_songs ADD COLUMN seen_as TEXT",
  },
};

/** Adds a column only when it isn't there yet, so migrations stay re-runnable. */
function addColumn(d: Database, table: string, column: string) {
  const alter = MIGRATION_COLUMNS[table]?.[column];
  if (!alter) throw new Error(`unknown migration column: ${table}.${column}`);
  const cols = d
    .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
    .all(table);
  if (cols.some((c) => c.name === column)) return;
  d.exec(alter);
}

/**
 * v2: song and artist names get their own furigana/romaji, so a kanji title
 * like a song name is readable in the library without opening it.
 */
function addTitleAnnotationColumns(d: Database) {
  addColumn(d, "songs", "title_furigana");
  addColumn(d, "songs", "title_romaji");
  addColumn(d, "songs", "artist_furigana");
  addColumn(d, "songs", "artist_romaji");
}

/**
 * v3: AI segmentation of each line — coloured chunks with their own reading,
 * meaning and explanation — cached alongside the line's translation.
 */
function addChunkColumn(d: Database) {
  addColumn(d, "line_analysis", "chunks");
}

/**
 * v4: free-text notes the user pastes with a song — an interview, a fan
 * reading, the story behind it — handed to the model so its explanations know
 * what the song is about. The generated-example and question caches arrive in
 * the same version but live in createBaseSchema, since they are whole tables.
 */
function addSongContextColumn(d: Database) {
  addColumn(d, "songs", "context");
}

/**
 * v5: favourited songs, which lead the setlist on Today and sort first in the
 * library. The `card_reasons` table arrives in the same version but lives in
 * createBaseSchema, since it is a whole table.
 */
function addFavouriteColumn(d: Database) {
  addColumn(d, "songs", "favourite");
}

/**
 * v7: the surface a word was actually seen as on a line.
 *
 * Words are stored under their dictionary headword, which for a kana particle is
 * often a kanji nobody writes — the possessive の is filed under 乃. Nothing
 * connected that row back to the の in the lyrics, so the bar under the word
 * could never find its own SRS state. Recording the surface closes the gap.
 */
function addSeenAsColumn(d: Database) {
  addColumn(d, "word_songs", "seen_as");
}

function createBaseSchema(d: Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      artist      TEXT NOT NULL,
      album       TEXT,
      source      TEXT NOT NULL,
      lrclib_id   INTEGER,
      youtube_id  TEXT,
      duration_ms INTEGER,
      synced      INTEGER NOT NULL DEFAULT 0,
      analyzed    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL,
      UNIQUE (title, artist)
    );

    CREATE TABLE IF NOT EXISTS lines (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id   INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      idx       INTEGER NOT NULL,
      text      TEXT NOT NULL,
      time_ms   INTEGER,
      verse_idx INTEGER NOT NULL DEFAULT 0,
      tokens    TEXT NOT NULL,
      UNIQUE (song_id, idx)
    );

    CREATE TABLE IF NOT EXISTS line_analysis (
      line_id     INTEGER PRIMARY KEY REFERENCES lines(id) ON DELETE CASCADE,
      translation TEXT,
      literal     TEXT,
      notes       TEXT NOT NULL DEFAULT '[]',
      provider    TEXT,
      updated_at  TEXT NOT NULL
    );

    -- Vocabulary deduplicated across every song in the library.
    CREATE TABLE IF NOT EXISTS words (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      lemma      TEXT NOT NULL,
      reading    TEXT NOT NULL,
      romaji     TEXT NOT NULL,
      furigana   TEXT NOT NULL,
      glosses    TEXT NOT NULL,
      pos        TEXT,
      jlpt       INTEGER,
      common     INTEGER NOT NULL DEFAULT 0,
      priority   INTEGER NOT NULL DEFAULT 0,
      loanword   INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE (lemma, reading)
    );

    -- Which songs a word appears in, and where it was first seen.
    CREATE TABLE IF NOT EXISTS word_songs (
      word_id INTEGER NOT NULL REFERENCES words(id) ON DELETE CASCADE,
      song_id INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      line_id INTEGER NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
      -- The inflected or kana form the word wore on this line, which is what the
      -- lyrics show and therefore what the bar under a word matches on.
      seen_as TEXT,
      PRIMARY KEY (word_id, line_id)
    );

    CREATE TABLE IF NOT EXISTS grammar_items (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      key         TEXT NOT NULL UNIQUE,
      pattern     TEXT NOT NULL,
      explanation TEXT NOT NULL,
      jlpt        INTEGER,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      kind        TEXT NOT NULL,
      song_id     INTEGER REFERENCES songs(id) ON DELETE CASCADE,
      line_id     INTEGER REFERENCES lines(id) ON DELETE CASCADE,
      word_id     INTEGER REFERENCES words(id) ON DELETE CASCADE,
      grammar_id  INTEGER REFERENCES grammar_items(id) ON DELETE CASCADE,
      /* Stable identity so re-importing a song never duplicates a card. */
      dedupe_key  TEXT NOT NULL UNIQUE,
      front       TEXT NOT NULL,
      back        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS srs (
      card_id       INTEGER PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
      ease          REAL NOT NULL DEFAULT 2.5,
      interval_days REAL NOT NULL DEFAULT 0,
      reps          INTEGER NOT NULL DEFAULT 0,
      lapses        INTEGER NOT NULL DEFAULT 0,
      due_at        TEXT NOT NULL,
      last_quality  INTEGER,
      leech         INTEGER NOT NULL DEFAULT 0,
      suspended     INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id  INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      ts       TEXT NOT NULL,
      quality  INTEGER NOT NULL,
      ms       INTEGER NOT NULL DEFAULT 0,
      given    TEXT
    );

    CREATE TABLE IF NOT EXISTS verse_progress (
      song_id    INTEGER NOT NULL REFERENCES songs(id) ON DELETE CASCADE,
      verse_idx  INTEGER NOT NULL,
      state      TEXT NOT NULL DEFAULT 'new',
      lines_done INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (song_id, verse_idx)
    );

    CREATE TABLE IF NOT EXISTS mnemonics (
      card_id    INTEGER PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
      text       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      k TEXT PRIMARY KEY,
      v TEXT NOT NULL
    );

    -- Why a card keeps failing, in the user's own words or from a preset. Asked
    -- once a card has lapsed a few times, and used to explain the trouble list
    -- back to them rather than only counting the misses.
    CREATE TABLE IF NOT EXISTS card_reasons (
      card_id    INTEGER PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
      reason     TEXT NOT NULL,
      note       TEXT,
      created_at TEXT NOT NULL
    );

    -- Seconds of song playback, bucketed by local day. Written by the player in
    -- coarse ticks, so "listening this week" costs one row a day.
    CREATE TABLE IF NOT EXISTS listening (
      day     TEXT PRIMARY KEY,
      seconds INTEGER NOT NULL DEFAULT 0
    );

    -- Generated usage examples for a word or phrase, cached so asking twice is
    -- free. Keyed by the text itself rather than a word id: the user taps AI
    -- chunks and set expressions that have no dictionary entry.
    CREATE TABLE IF NOT EXISTS word_examples (
      term       TEXT NOT NULL,
      reading    TEXT NOT NULL DEFAULT '',
      examples   TEXT NOT NULL,
      provider   TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (term, reading)
    );

    -- Memory hooks for a single kanji: one for the meaning, one for the reading,
    -- in the WaniKani mould. Keyed by the character rather than by a card or a
    -- word, because 言 is the same 言 in every word it turns up in — generated
    -- once, then free forever.
    CREATE TABLE IF NOT EXISTS kanji_mnemonics (
      char        TEXT PRIMARY KEY,
      meaning     TEXT NOT NULL,
      reading     TEXT NOT NULL,
      -- The reading the hook was built around, so a hook that leans on ゲン is
      -- not shown as if it explained every reading the character has.
      reading_key TEXT NOT NULL DEFAULT '',
      provider    TEXT,
      created_at  TEXT NOT NULL
    );

    -- Free-form questions the user asked about a word, with the answer kept so
    -- the same question is never paid for twice and the thread stays readable.
    CREATE TABLE IF NOT EXISTS word_questions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      term       TEXT NOT NULL,
      reading    TEXT NOT NULL DEFAULT '',
      question   TEXT NOT NULL,
      answer     TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (term, reading, question)
    );

    CREATE INDEX IF NOT EXISTS idx_lines_song ON lines(song_id, idx);
    CREATE INDEX IF NOT EXISTS idx_cards_song ON cards(song_id);
    CREATE INDEX IF NOT EXISTS idx_cards_word ON cards(word_id);
    CREATE INDEX IF NOT EXISTS idx_srs_due ON srs(due_at) WHERE suspended = 0;
    CREATE INDEX IF NOT EXISTS idx_reviews_card ON reviews(card_id, ts);
    CREATE INDEX IF NOT EXISTS idx_reviews_ts ON reviews(ts);
    CREATE INDEX IF NOT EXISTS idx_word_songs_song ON word_songs(song_id);
    CREATE INDEX IF NOT EXISTS idx_word_questions_term ON word_questions(term, reading, created_at);
  `);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function getSetting(key: string): string | null {
  const row = getDb()
    .query<{ v: string }, [string]>("SELECT v FROM settings WHERE k = ?")
    .get(key);
  return row?.v ?? null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (k, v) VALUES (?, ?)")
    .run(key, value);
}

/** Test hook: point the module at a scratch database. */
export function _setDbForTests(instance: Database | null) {
  db = instance;
  if (instance) {
    instance.exec("PRAGMA foreign_keys = ON");
    migrate(instance);
  }
}
