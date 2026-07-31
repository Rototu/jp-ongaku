export interface ParsedLine {
  text: string;
  /** Milliseconds into the track, or null for unsynced lyrics. */
  timeMs: number | null;
}

const TIMESTAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
/** Metadata tags LRC files carry: [ar:artist], [ti:title], [offset:+250]… */
const METADATA = /^\[(ar|ti|al|au|by|re|ve|length|offset|tool|encoding):(.*)\]$/i;

/**
 * Parses an LRC file into timed lines.
 *
 * Handles the real-world quirks: multiple timestamps on one line (a repeated
 * chorus line is often listed once with several times), metadata tags, the
 * [offset:] tag, and blank interlude markers.
 */
export function parseLrc(source: string): { lines: ParsedLine[]; offsetMs: number } {
  let offsetMs = 0;
  const collected: ParsedLine[] = [];

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const meta = METADATA.exec(line);
    if (meta) {
      if (meta[1].toLowerCase() === 'offset') {
        const parsed = Number.parseInt(meta[2].trim(), 10);
        if (Number.isFinite(parsed)) offsetMs = parsed;
      }
      continue;
    }

    TIMESTAMP.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = TIMESTAMP.exec(line)) !== null) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      const fracRaw = match[3] ?? '0';
      // Two-digit fractions are centiseconds, three-digit are milliseconds.
      const frac = fracRaw.length === 3 ? Number(fracRaw) : Number(fracRaw) * 10;
      stamps.push(minutes * 60_000 + seconds * 1000 + frac);
    }

    const text = line.replace(TIMESTAMP, '').trim();
    if (stamps.length === 0) {
      collected.push({ text: line, timeMs: null });
      continue;
    }
    // A line with no text is an interlude marker; keep no entry for it.
    if (!text) continue;
    for (const timeMs of stamps) collected.push({ text, timeMs });
  }

  const synced = collected.filter((l) => l.timeMs !== null);
  if (synced.length === 0) {
    return { lines: collected.filter((l) => l.text.length > 0), offsetMs };
  }

  synced.sort((a, b) => (a.timeMs as number) - (b.timeMs as number));
  return {
    lines: synced.map((l) => ({ text: l.text, timeMs: (l.timeMs as number) + offsetMs })),
    offsetMs,
  };
}

/** Splits plain (unsynced) lyrics into lines, dropping blank padding. */
export function parsePlain(source: string): ParsedLine[] {
  return source
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((text) => ({ text, timeMs: null }));
}

/**
 * Groups lines into verses.
 *
 * Blank-line separation in the source is the best signal, but LRCLIB strips
 * most of it, so a timing gap is the fallback: a pause longer than the usual
 * line spacing means a new section started. Failing both, fixed-size blocks
 * keep sessions checkpointable.
 */
export function groupVerses(
  lines: ParsedLine[],
  rawSource: string,
  blockSize = 8,
): number[] {
  const verses: number[] = [];

  const blankSeparated = verseFromBlankLines(lines, rawSource);
  if (blankSeparated) return mergeRunts(blankSeparated);

  const timed = lines.every((l) => l.timeMs !== null);
  if (timed && lines.length > 2) {
    const gaps: number[] = [];
    for (let i = 1; i < lines.length; i++) {
      gaps.push((lines[i].timeMs as number) - (lines[i - 1].timeMs as number));
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] || 0;
    // A gap over 2.5x the median (and at least 3s) reads as a section break.
    const threshold = Math.max(median * 2.5, 3000);

    let verse = 0;
    verses.push(0);
    for (let i = 1; i < lines.length; i++) {
      if (gaps[i - 1] > threshold) verse++;
      verses.push(verse);
    }
    if (new Set(verses).size > 1) return mergeRunts(verses);
  }

  return lines.map((_, i) => Math.floor(i / blockSize));
}

/** Sections shorter than this are folded into a neighbour. */
const MIN_VERSE_LINES = 2;

/**
 * Folds one-line sections into their neighbours.
 *
 * Timing gaps around an intro call-out or a trailing outro line produce
 * single-line sections, which make useless checkpoints — the user would "finish
 * a section" by reading one line.
 */
function mergeRunts(verses: number[]): number[] {
  if (verses.length === 0) return verses;

  const counts = new Map<number, number>();
  for (const v of verses) counts.set(v, (counts.get(v) ?? 0) + 1);
  if ([...counts.values()].every((n) => n >= MIN_VERSE_LINES)) return verses;

  const ordered = [...counts.keys()].sort((a, b) => a - b);
  const remap = new Map<number, number>();
  for (const [i, verse] of ordered.entries()) {
    if ((counts.get(verse) ?? 0) >= MIN_VERSE_LINES) {
      remap.set(verse, verse);
      continue;
    }
    // Prefer merging backwards into the previous section; the first section has
    // only the next one to join.
    const prev = ordered[i - 1];
    const target = prev !== undefined ? (remap.get(prev) ?? prev) : ordered[i + 1];
    remap.set(verse, target ?? verse);
  }

  return normalizeVerses(verses.map((v) => remap.get(v) ?? v));
}

function verseFromBlankLines(lines: ParsedLine[], rawSource: string): number[] | null {
  const rawLines = rawSource.split(/\r?\n/).map((l) => l.trim());
  if (!rawLines.some((l) => l.length === 0)) return null;

  // Walk the raw source, counting blank-line breaks, and map each non-blank
  // line onto the verse index it fell in.
  const verseByText = new Map<string, number>();
  let verse = 0;
  let sawContent = false;
  for (const raw of rawLines) {
    const text = raw.replace(TIMESTAMP, '').trim();
    if (!text) {
      if (sawContent) {
        verse++;
        sawContent = false;
      }
      continue;
    }
    if (METADATA.test(raw)) continue;
    sawContent = true;
    if (!verseByText.has(text)) verseByText.set(text, verse);
  }

  const result = lines.map((l) => verseByText.get(l.text));
  if (result.some((v) => v === undefined)) return null;
  const normalized = normalizeVerses(result as number[]);
  return new Set(normalized).size > 1 ? normalized : null;
}

/** Renumbers verse ids to a dense 0..n-1 sequence. */
function normalizeVerses(verses: number[]): number[] {
  const seen = new Map<number, number>();
  return verses.map((v) => {
    if (!seen.has(v)) seen.set(v, seen.size);
    return seen.get(v) as number;
  });
}
