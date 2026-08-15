import { copyFileSync, renameSync, unlinkSync } from 'node:fs';
import { Database } from 'bun:sqlite';

/**
 * Backup and restore of the user's database.
 *
 * The user db is deliberately small — songs, cards, history, settings — so a
 * backup is the file itself, checkpointed out of WAL so the copy is complete
 * without stopping the server. Restore validates before it mutates anything:
 * the upload must be an ongaku database carrying a schema version this app
 * understands. Older versions restore fine, because migrations are idempotent
 * and run on every open; a newer one is refused, because this app cannot know
 * what those rows mean.
 *
 * The swap is close → rename → reopen in one synchronous block. A request
 * racing through the middle of it would at worst write to an unlinked file;
 * this is a local, single-user server, and the alternative — locking every
 * endpoint — buys nothing here.
 */

export type ValidateResult = { ok: true; version: number } | { ok: false; error: string };

/**
 * Checks that a file is an ongaku database this app can open.
 *
 * Reading the schema version requires the file to be a working SQLite database
 * at all, so a text file or a truncated download fails here rather than at
 * reopen.
 */
export function validateDatabase(path: string, appVersion: number): ValidateResult {
  let d: Database;
  try {
    d = new Database(path, { readonly: true });
  } catch {
    return { ok: false, error: 'That file is not a database at all.' };
  }
  try {
    let version: number;
    try {
      const row = d
        .query<{ v: string }, []>("SELECT v FROM schema_meta WHERE k = 'version'")
        .get();
      if (!row) {
        return { ok: false, error: 'That database has no schema version — it is not an ongaku backup.' };
      }
      version = Number(row.v);
    } catch {
      return { ok: false, error: 'That database has no schema version — it is not an ongaku backup.' };
    }
    if (!Number.isFinite(version) || version < 1) {
      return { ok: false, error: 'That database carries an unreadable schema version.' };
    }
    if (version > appVersion) {
      return {
        ok: false,
        error: `That backup is from a newer version of the app (schema ${version}; this app understands ${appVersion}). Update the app first, then restore.`,
      };
    }
    // A final shape check: the one table every version has had.
    const songs = d
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'songs'",
      )
      .get();
    if (!songs) {
      return { ok: false, error: 'That database is missing its songs table — not an ongaku backup.' };
    }
    return { ok: true, version };
  } finally {
    d.close();
  }
}

/** Checkpoints WAL back into the main file, then copies it. */
export function snapshotDatabase(db: Database, path: string, dest: string): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  copyFileSync(path, dest);
}

/** SQLite sidecar files a swap leaves behind if it doesn't clean up. */
function sidecars(path: string): string[] {
  return [`${path}-wal`, `${path}-shm`];
}

/**
 * Replaces the database at `path` with the already-validated file at `src`.
 *
 * `reset` and `reopen` are injected because the live handle lives in a module
 * cache: it has to be closed and forgotten before the rename, and re-acquired
 * afterwards so any migration the backup needs runs immediately.
 */
export function swapDatabase(opts: {
  src: string;
  path: string;
  reset: () => void;
  reopen: () => unknown;
}): void {
  // A leftover WAL from the old file would be applied to the new one — the
  // fastest way to corrupt a restore — so the sidecars go first.
  for (const f of sidecars(opts.path)) {
    try {
      unlinkSync(f);
    } catch {
      /* nothing to remove */
    }
  }
  opts.reset();
  renameSync(opts.src, opts.path);
  // A request racing through the window between reset and rename re-creates and
  // caches a fresh, empty database at `path` (getDb is create-if-missing). That
  // cached handle is stale the moment the rename lands, so forget it again —
  // reopen must see the restored file, not the racing request's empty one.
  opts.reset();
  opts.reopen();
}
