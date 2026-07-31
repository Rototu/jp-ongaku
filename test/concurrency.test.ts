import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { _setDbForTests, getDb, setSetting } from '../server/db';
import { buildLesson } from '../server/lesson/build';
import { analyzeSong } from '../server/llm/analyze';
import { parsePlain } from '../server/lyrics/lrc';

/**
 * Batches of lines are independent, so they must be requested in parallel.
 * These tests pin the pool behaviour with a fake completer that records how many
 * requests are in flight at once.
 */

// 18 hand-written fixture lines: enough for several batches at BATCH_SIZE 6.
const LINES = Array.from({ length: 18 }, (_, i) => `夜空に星が光っている${'。'.repeat((i % 3) + 1)}`);
const FIXTURE = LINES.join('\n');

beforeEach(() => {
  _setDbForTests(new Database(':memory:'));
  setSetting('gateway_api_key', 'test-key');
});

afterEach(() => {
  _setDbForTests(null);
});

async function importFixture() {
  return buildLesson({
    title: 'Concurrency Fixture',
    artist: 'Test Artist',
    source: 'paste',
    lines: parsePlain(FIXTURE),
    raw: FIXTURE,
  });
}

/** Builds a completer that answers every line with a single whole-line chunk. */
function fakeCompleter(options: { delayMs?: number; track?: () => void; release?: () => void } = {}) {
  return async (prompt: string) => {
    options.track?.();
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    options.release?.();

    // Echo back whatever line indices and texts the prompt asked about, so the
    // reconstruction check passes.
    const entries = [...prompt.matchAll(/^(\d+)\t(.+)$/gm)].map((m) => ({
      idx: Number(m[1]),
      text: m[2],
    }));
    return JSON.stringify(
      entries.map((e) => ({
        idx: e.idx,
        translation: `translation of ${e.idx}`,
        segments: [
          { text: e.text, reading: '', role: 'line', meaning: 'whole line', explanation: 'test' },
        ],
        notes: [],
      })),
    );
  };
}

describe('batch concurrency', () => {
  test('runs several batches at once', async () => {
    const song = await importFixture();
    let inFlight = 0;
    let peak = 0;

    setSetting('llm_concurrency', '4');
    const result = await analyzeSong(song.songId, {
      completer: fakeCompleter({
        delayMs: 40,
        track: () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
        },
        release: () => {
          inFlight--;
        },
      }),
    });

    expect(result.linesAnalyzed).toBe(18);
    // 18 lines / 6 per batch = 3 batches, all of which should overlap.
    expect(peak).toBeGreaterThan(1);
  });

  test('honours a concurrency of 1', async () => {
    const song = await importFixture();
    let inFlight = 0;
    let peak = 0;

    setSetting('llm_concurrency', '1');
    await analyzeSong(song.songId, {
      completer: fakeCompleter({
        delayMs: 20,
        track: () => {
          inFlight++;
          peak = Math.max(peak, inFlight);
        },
        release: () => {
          inFlight--;
        },
      }),
    });

    expect(peak).toBe(1);
  });

  test('parallel batches are faster than serial ones', async () => {
    const song = await importFixture();

    setSetting('llm_concurrency', '1');
    const serialStart = performance.now();
    await analyzeSong(song.songId, { completer: fakeCompleter({ delayMs: 60 }) });
    const serial = performance.now() - serialStart;

    // Re-run over the same lines with force so the work is identical.
    setSetting('llm_concurrency', '4');
    const parallelStart = performance.now();
    await analyzeSong(song.songId, { force: true, completer: fakeCompleter({ delayMs: 60 }) });
    const parallel = performance.now() - parallelStart;

    expect(parallel).toBeLessThan(serial);
  });

  test('every line still gets analysed exactly once', async () => {
    const song = await importFixture();
    setSetting('llm_concurrency', '4');
    await analyzeSong(song.songId, { completer: fakeCompleter() });

    const rows = getDb()
      .query<{ n: number; unique_lines: number }, [number]>(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT line_id) AS unique_lines FROM line_analysis a
         JOIN lines l ON l.id = a.line_id WHERE l.song_id = ?`,
      )
      .get(song.songId);
    expect(rows?.n).toBe(18);
    expect(rows?.unique_lines).toBe(18);
  });

  test('a failing batch does not stop the others', async () => {
    const song = await importFixture();
    setSetting('llm_concurrency', '4');
    const good = fakeCompleter();

    const result = await analyzeSong(song.songId, {
      // Keyed on content, not call order: with batches running in parallel the
      // call sequence is nondeterministic, so failing "the first two calls"
      // would hit two different batches' first attempts.
      completer: async (prompt: string, system?: string) => {
        if (/^0\t/m.test(prompt)) throw new Error('AI Gateway 500: upstream exploded');
        return good(prompt, system);
      },
    });

    expect(result.linesAnalyzed).toBeGreaterThan(0);
    expect(result.linesAnalyzed).toBeLessThan(18);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('progress is reported as batches land', async () => {
    const song = await importFixture();
    setSetting('llm_concurrency', '2');
    const seen: number[] = [];

    await analyzeSong(song.songId, {
      completer: fakeCompleter({ delayMs: 10 }),
      onProgress: (p) => seen.push(p.done),
    });

    expect(seen.length).toBeGreaterThan(1);
    // Progress only ever moves forward.
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(18);
  });
});

describe('truncated responses', () => {
  test('are reported as an output-limit problem, not a parse mystery', async () => {
    const song = await importFixture();
    const result = await analyzeSong(song.songId, {
      completer: async () => {
        throw new Error(
          'AI Gateway 200: the model hit its output limit and the reply was cut off. Lower the reasoning effort or use a model with more output room.',
        );
      },
    });

    expect(result.linesAnalyzed).toBe(0);
    expect(result.errors[0]).toMatch(/output limit|cut off/i);
  });

  test('half-written JSON does not corrupt the lesson', async () => {
    const song = await importFixture();
    const result = await analyzeSong(song.songId, {
      // Valid JSON prefix, truncated mid-object.
      completer: async () => '[{"idx":0,"translation":"partial","segments":[{"text":"夜空に',
    });

    expect(result.linesAnalyzed).toBe(0);
    const chunks = getDb()
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM line_analysis WHERE chunks != '[]'")
      .get();
    expect(chunks?.n).toBe(0);
  });
});
