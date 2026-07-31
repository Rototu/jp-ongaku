import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { api } from './routes/api';
import { getDb } from './db';
import { backfillTitles } from './lesson/titles';
import { backfillCardReadings, realignWordReadings } from './lesson/backfill-cards';
import { pruneMismatchedGrammarCards } from './lesson/regrade-grammar';
import { dict } from './dict';
import { status as llmStatus } from './llm/provider';
import { DATA_DIR, DIST_DIR, ensureDirs } from './paths';

const PORT = Number(process.env.PORT ?? 5272);

ensureDirs();
getDb(); // run migrations at boot so the first request is fast

// Songs imported before title annotations existed get them now. Runs in the
// background: the server is useful before it finishes.
void backfillTitles()
  .then((n) => {
    if (n > 0) console.log(`  annotated ${n} song title${n === 1 ? '' : 's'} with furigana`);
  })
  .catch((err) => console.error('[titles] backfill failed:', err));

// Cards made before grammar/cloze/listening carried ruby get it added, so old
// decks stop showing bare kanji.
try {
  const fixed = backfillCardReadings();
  if (fixed > 0) console.log(`  added readings to ${fixed} existing card${fixed === 1 ? '' : 's'}`);

  // Vocabulary rows whose ruby described the inflected form rather than the
  // dictionary form they store.
  const realigned = realignWordReadings();
  if (realigned > 0) {
    console.log(`  realigned readings on ${realigned} vocabulary entr${realigned === 1 ? 'y' : 'ies'}`);
  }
} catch (err) {
  console.error('[cards] reading backfill failed:', err);
}

// Grammar cards that ask about a form their example line does not contain are
// unanswerable; drop them rather than leave them in the rotation.
try {
  const pruned = pruneMismatchedGrammarCards();
  if (pruned.removed > 0) {
    console.log(
      `  removed ${pruned.removed} grammar card${pruned.removed === 1 ? '' : 's'} whose example did not contain the pattern`,
    );
  }
} catch (err) {
  console.error('[cards] grammar prune failed:', err);
}

const app = new Hono();

app.route('/api', api);

// The built frontend. In dev, Vite serves the UI on its own port and proxies
// /api here, so a missing dist/ is not an error.
const hasBuild = existsSync(join(DIST_DIR, 'index.html'));
if (hasBuild) {
  app.use('/assets/*', serveStatic({ root: './dist' }));
  app.get('/favicon.svg', serveStatic({ path: './dist/favicon.svg' }));
  // Single-page app: every unmatched route returns index.html.
  app.get('*', serveStatic({ path: './dist/index.html' }));
} else {
  app.get('/', (c) =>
    c.text(
      'jp-ongaku API is running, but the UI has not been built.\n\nRun:  bun run build\nOr for development:  bun run dev\n',
      200,
    ),
  );
}

const d = dict();
const dstats = d.stats();
const llm = llmStatus();

console.log('');
console.log('  jp-ongaku  ♪  Japanese through song');
console.log('  ─────────────────────────────────────────────');
console.log(`  UI          http://localhost:${PORT}`);
console.log(
  `  dictionary  ${d.available ? `${dstats.entries.toLocaleString()} entries, ${dstats.kanji.toLocaleString()} kanji` : 'MISSING — run: bun run dict'}`,
);
console.log(`  ai layer    ${llm.detail}`);
if (!hasBuild) console.log('  ui          NOT BUILT — run: bun run build');
console.log(`  process     pid ${process.pid}, started by pid ${process.ppid}`);
console.log('');

/**
 * Records why the server stopped.
 *
 * A process that vanishes with no explanation is impossible to diagnose after
 * the fact — the shell only reports that it was terminated, not by whom. Signals
 * are unattributable on macOS, so the next best thing is a durable note of what
 * arrived and when: the log line plus the pid pair usually identifies the culprit
 * (a parent that exited, a tool reclaiming the port, a manual kill).
 *
 * Writes to data/shutdown.log so the record survives the terminal scrolling away
 * or the window closing.
 */
const startedAt = Date.now();

function recordShutdown(signal: string): void {
  const uptimeSec = Math.round((Date.now() - startedAt) / 1000);
  const line = `${new Date().toISOString()}  ${signal}  pid=${process.pid} parent=${process.ppid} uptime=${uptimeSec}s\n`;

  console.log('');
  console.log(`  jp-ongaku stopping — received ${signal} after ${uptimeSec}s`);
  console.log(`  (recorded in data/shutdown.log; parent process was ${process.ppid})`);

  try {
    appendFileSync(join(DATA_DIR, 'shutdown.log'), line);
  } catch {
    // Not worth failing a shutdown over.
  }

  try {
    // Fold the write-ahead log back into the database file, so an interrupted
    // run never leaves the library in a half-checkpointed state.
    const db = getDb();
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {
    // Ditto.
  }

  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => recordShutdown(signal));
}

export default {
  port: PORT,
  fetch: app.fetch,
  idleTimeout: 255,
};
