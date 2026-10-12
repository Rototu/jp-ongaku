/**
 * Copies the local database (data/ongaku.db, or a file given as the first
 * argument) into the online one.
 *
 *   bun run db:push                 # data/ongaku.db → Turso
 *   bun run db:push backup.db       # a downloaded backup → Turso
 *   bun run db:push --force         # replace what is online already
 *
 * Run once when moving online, or to restore a backup while online. The
 * online database is migrated to the current schema first; the source must be
 * at that schema too, which opening it in the app once guarantees.
 *
 * Tables are copied in the order they were created, which is parent before
 * child, so foreign keys hold row by row. Everything happens in one
 * transaction: a failure part-way leaves the online database as it was.
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { getDb, SCHEMA_VERSION } from '../server/db';
import { validateDatabase } from '../server/backup';
import { USER_DB, remoteDbConfig } from '../server/paths';

const args = process.argv.slice(2);
const force = args.includes('--force');
const source = args.find((a) => !a.startsWith('--')) ?? USER_DB;

if (!remoteDbConfig()) {
  console.error('No online database configured: set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.');
  process.exit(1);
}
if (!existsSync(source)) {
  console.error(`No database at ${source}.`);
  process.exit(1);
}
const verdict = validateDatabase(source, SCHEMA_VERSION);
if (!verdict.ok) {
  console.error(verdict.error);
  process.exit(1);
}
if (verdict.version !== SCHEMA_VERSION) {
  console.error(
    `${source} is at schema ${verdict.version}; this app writes ${SCHEMA_VERSION}. Open it in the app locally once to migrate it, then push.`,
  );
  process.exit(1);
}

const src = new Database(source, { readonly: true });
const dest = getDb();

const tables = src
  .query<{ name: string }, []>(
    `SELECT name FROM sqlite_master
     WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
     ORDER BY rowid`,
  )
  .all()
  .map((t) => t.name);

const existing = dest.query<{ n: number }>('SELECT COUNT(*) AS n FROM songs').get()?.n ?? 0;
if (existing > 0 && !force) {
  console.error(
    `The online database already has ${existing} song${existing === 1 ? '' : 's'}. Re-run with --force to replace everything in it.`,
  );
  process.exit(1);
}

const started = Date.now();
let rows = 0;
dest.transaction(() => {
  // Children first, so deleting a parent never trips a foreign key.
  for (const table of [...tables].reverse()) dest.exec(`DELETE FROM "${table}"`);
  for (const table of tables) {
    const cols = src
      .query<{ name: string }, [string]>('SELECT name FROM pragma_table_info(?)')
      .all(table)
      .map((c) => c.name);
    const list = cols.map((c) => `"${c}"`).join(', ');
    const insert = dest.prepare(
      `INSERT INTO "${table}" (${list}) VALUES (${cols.map(() => '?').join(', ')})`,
    );
    const data = src.query<Record<string, unknown>, []>(`SELECT ${list} FROM "${table}"`).all();
    for (const row of data) insert.run(...(cols.map((c) => row[c]) as never[]));
    rows += data.length;
    console.log(`  ${table.padEnd(18)} ${data.length}`);
  }
})();
dest.sync();

console.log(`Pushed ${rows} rows from ${source} in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
