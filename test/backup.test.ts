import { afterAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { _setDbForTests, SCHEMA_VERSION } from '../server/db';
import {
  snapshotDatabase,
  swapDatabase,
  validateDatabase,
} from '../server/backup';

/**
 * Backup and restore of the user database, on scratch files only.
 *
 * The validation matrix is the risk surface: a text file, a foreign SQLite
 * database, a schema from the future — each must be refused before anything on
 * disk is touched, while an older schema is welcomed (migrations are idempotent
 * and run at reopen).
 */

const dir = mkdtempSync(join(tmpdir(), 'ongaku-backup-'));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A database carrying this app's schema, built the way the app builds one. */
function seedDb(path: string): Database {
  const d = new Database(path, { create: true });
  _setDbForTests(d); // migrate() runs here
  _setDbForTests(null);
  return d;
}

describe('validating an uploaded backup', () => {
  test('a database with this schema is accepted', () => {
    const path = join(dir, 'good.db');
    seedDb(path);
    const verdict = validateDatabase(path, SCHEMA_VERSION);
    expect(verdict).toEqual({ ok: true, version: SCHEMA_VERSION });
  });

  test('a text file is refused', () => {
    const path = join(dir, 'text.db');
    writeFileSync(path, 'definitely not a database');
    expect(validateDatabase(path, SCHEMA_VERSION).ok).toBe(false);
  });

  test('a foreign sqlite database is refused', () => {
    const path = join(dir, 'foreign.db');
    const d = new Database(path, { create: true });
    d.exec('CREATE TABLE unrelated (x INTEGER)');
    d.close();
    expect(validateDatabase(path, SCHEMA_VERSION).ok).toBe(false);
  });

  test('a schema from a newer app is refused, with the version said out loud', () => {
    const path = join(dir, 'future.db');
    const d = seedDb(path);
    d.exec('PRAGMA foreign_keys = OFF');
    d.prepare("UPDATE schema_meta SET v = '99' WHERE k = 'version'").run();
    d.close();
    const verdict = validateDatabase(path, SCHEMA_VERSION);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain('newer');
  });

  test('an older schema restores fine', () => {
    const path = join(dir, 'older.db');
    const d = seedDb(path);
    d.exec('PRAGMA foreign_keys = OFF');
    d.prepare("UPDATE schema_meta SET v = '3' WHERE k = 'version'").run();
    d.close();
    expect(validateDatabase(path, SCHEMA_VERSION)).toEqual({ ok: true, version: 3 });
  });
});

describe('taking a snapshot', () => {
  test('the copy is byte-identical once WAL is checkpointed in', () => {
    const path = join(dir, 'live.db');
    const d = seedDb(path);
    d.exec('PRAGMA journal_mode = WAL');
    d
      .prepare("INSERT INTO songs (title, artist, source, created_at) VALUES (?, ?, 'test', ?)")
      .run('たましい', 'test', new Date().toISOString());
    // The row is in WAL until a checkpoint — the snapshot's whole job.
    const dest = join(dir, 'snapshot.db');
    snapshotDatabase(d, path, dest);
    expect(readFileSync(dest).equals(readFileSync(path))).toBe(true);
    const verdict = validateDatabase(dest, SCHEMA_VERSION);
    expect(verdict.ok).toBe(true);
    d.close();
  });
});

describe('swapping a restore in', () => {
  test('the staged file replaces the live one and sidecars are cleared', () => {
    const liveDir = join(dir, 'swap');
    mkdirSync(liveDir);
    const livePath = join(liveDir, 'ongaku.db');
    seedDb(livePath).close();
    // A stale sidecar from the old file must not survive to touch the new one.
    writeFileSync(`${livePath}-wal`, 'stale wal');

    const src = join(dir, 'incoming.db');
    const d = seedDb(src);
    d
      .prepare("INSERT INTO songs (title, artist, source, created_at) VALUES (?, ?, 'test', ?)")
      .run('よあけ', 'incoming', new Date().toISOString());
    d.close();

    let resets = 0;
    let reopens = 0;
    swapDatabase({
      src,
      path: livePath,
      reset: () => {
        resets++;
      },
      reopen: () => {
        reopens++;
      },
    });

    // Twice: once before the rename, and once after — a request racing through
    // the window between them re-creates a fresh empty database and caches its
    // handle, which the second reset forgets so reopen sees the restored file.
    expect(resets).toBe(2);
    expect(reopens).toBe(1);
    expect(existsSync(`${livePath}-wal`)).toBe(false);
    expect(existsSync(src)).toBe(false); // renamed, not copied

    const check = new Database(livePath, { readonly: true });
    const row = check.query<{ title: string }, []>('SELECT title FROM songs').get();
    check.close();
    expect(row?.title).toBe('よあけ');
  });

  test('a racing empty handle is forgotten before reopen', () => {
    const liveDir = join(dir, 'swap-race');
    mkdirSync(liveDir);
    const livePath = join(liveDir, 'ongaku.db');
    seedDb(livePath).close();

    const src = join(dir, 'incoming-race.db');
    const d = seedDb(src);
    d
      .prepare("INSERT INTO songs (title, artist, source, created_at) VALUES (?, ?, 'test', ?)")
      .run('restored', 'incoming', new Date().toISOString());
    d.close();

    // The race: the first reset closes the real handle; a request sneaks in and
    // getDb() re-creates a fresh empty db (the handle swapDatabase must forget).
    const racers: Database[] = [];
    let raced = false;
    swapDatabase({
      src,
      path: livePath,
      reset: () => {
        if (!raced) {
          raced = true;
          racers.push(new Database(livePath, { create: true }));
        }
      },
      reopen: () => {
        // The stale handle is dropped; a fresh open reads the restored file.
        for (const r of racers) r.close();
        const fresh = new Database(livePath, { readonly: true });
        const row = fresh.query<{ title: string }, []>('SELECT title FROM songs').get();
        fresh.close();
        if (row?.title !== 'restored') throw new Error('reopen saw a stale database');
      },
    });
  });
});
