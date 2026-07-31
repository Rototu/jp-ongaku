import { analyzeSong, generateSongKanjiMnemonics } from './analyze';
import { LlmUnavailable, resolveProvider } from './provider';
import { getDb, getSetting } from '../db';

/**
 * Background analysis jobs.
 *
 * Careful analysis is deliberately slow — small batches, a retry when the
 * segmentation does not reconstruct the line — so it cannot run inside a
 * request. Jobs run detached and the UI polls for progress.
 *
 * Two phases, in order. The lines are explained first, because that is what the
 * page is waiting to show; then every kanji in the song gets its memory hooks,
 * so a word already has them by the time it is tapped. Both are resumable by
 * being skippable: analyzeSong ignores lines that already have an analysis, and
 * the mnemonic phase ignores characters that already have hooks.
 *
 * State is in memory only. A job interrupted by a restart leaves the rest of its
 * work undone and the next run picks it up.
 */

export type JobState = 'running' | 'done' | 'failed';

/** Which half of the work is on: the lines, or the kanji behind them. */
export type JobPhase = 'lines' | 'kanji';

export interface JobStatus {
  songId: number;
  state: JobState;
  phase: JobPhase;
  done: number;
  total: number;
  linesAnalyzed: number;
  rejected: number;
  /** Characters given hooks in this run, and how many are being done. */
  kanjiDone: number;
  kanjiTotal: number;
  error: string | null;
  startedAt: string;
}

const jobs = new Map<number, JobStatus>();

export function status(songId: number): JobStatus | null {
  return jobs.get(songId) ?? null;
}

export function isRunning(songId: number): boolean {
  return jobs.get(songId)?.state === 'running';
}

/**
 * Starts analysis unless it is already running for this song.
 * Returns the live status either way, so callers never start a duplicate.
 */
export function start(songId: number, opts: { force?: boolean } = {}): JobStatus {
  const existing = jobs.get(songId);
  if (existing?.state === 'running') return existing;

  const job: JobStatus = {
    songId,
    state: 'running',
    phase: 'lines',
    done: 0,
    total: pendingLineCount(songId, opts.force ?? false),
    linesAnalyzed: 0,
    rejected: 0,
    kanjiDone: 0,
    kanjiTotal: 0,
    error: null,
    startedAt: new Date().toISOString(),
  };
  jobs.set(songId, job);

  void (async () => {
    const result = await analyzeSong(songId, {
      force: opts.force,
      onProgress: (p) => {
        job.done = p.done;
        job.total = p.total;
      },
    });
    job.linesAnalyzed = result.linesAnalyzed;
    job.rejected = result.rejected;
    job.done = job.total;

    // Nothing came back at all: the gateway or the model is in no state to be
    // asked for mnemonics either.
    if (result.linesAnalyzed === 0 && result.errors.length > 0) {
      job.state = 'failed';
      job.error = result.errors[0];
      return;
    }
    job.error = result.errors[0] ?? null;

    // The second phase runs even when every line was already explained: an older
    // song still has kanji that were never given hooks.
    job.phase = 'kanji';
    const hooks = await generateSongKanjiMnemonics(songId, {
      force: opts.force,
      onProgress: (p) => {
        job.kanjiDone = p.done;
        job.kanjiTotal = p.total;
      },
    });
    job.kanjiDone = job.kanjiTotal;
    // Line errors are the ones worth reporting; a mnemonic that failed only means
    // that character is explained on hover instead.
    job.error = job.error ?? hooks.errors[0] ?? null;
    job.state = 'done';
  })().catch((err: unknown) => {
    job.state = 'failed';
    job.error =
      err instanceof LlmUnavailable
        ? 'No AI provider configured. Pick one in Settings.'
        : err instanceof Error
          ? err.message
          : 'Analysis failed';
  });

  return job;
}

function pendingLineCount(songId: number, force: boolean): number {
  const db = getDb();
  const sql = force
    ? 'SELECT COUNT(*) AS n FROM lines WHERE song_id = ?'
    : `SELECT COUNT(*) AS n FROM lines l
       WHERE l.song_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM line_analysis a
           WHERE a.line_id = l.id AND a.translation IS NOT NULL AND a.chunks != '[]'
         )`;
  return db.query<{ n: number }, [number]>(sql).get(songId)?.n ?? 0;
}

/**
 * Kicks off analysis right after import when a provider is available.
 *
 * The user asked for correctness over cost, so this is on by default: a song is
 * fully explained by the time they finish reading the first verse. Set the
 * `auto_analyze` setting to "off" to disable.
 */
export function maybeAutoAnalyze(songId: number): JobStatus | null {
  if (getSetting('auto_analyze') === 'off') return null;
  if (resolveProvider().name === 'none') return null;
  return start(songId);
}
