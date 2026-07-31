import { describe, expect, test } from 'bun:test';
import { groupVerses, parseLrc } from '../server/lyrics/lrc';

/** Builds a timed fixture: `[gapSeconds]` between placeholder lines. */
function timed(gaps: number[]): string {
  let t = 0;
  const out: string[] = [`[00:00.00]line0`];
  gaps.forEach((gap, i) => {
    t += gap;
    const m = Math.floor(t / 60);
    const s = (t % 60).toFixed(2).padStart(5, '0');
    out.push(`[${String(m).padStart(2, '0')}:${s}]line${i + 1}`);
  });
  return out.join('\n');
}

describe('verse grouping keeps sections usable as checkpoints', () => {
  test('folds a lone intro line into the following section', () => {
    // One line, long pause, then a block of four.
    const raw = timed([20, 2, 2, 2]);
    const { lines } = parseLrc(raw);
    const verses = groupVerses(lines, raw);
    expect(verses[0]).toBe(verses[1]);
    expect(new Set(verses).size).toBe(1);
  });

  test('folds a lone trailing line into the previous section', () => {
    const raw = timed([2, 2, 2, 30]);
    const { lines } = parseLrc(raw);
    const verses = groupVerses(lines, raw);
    expect(verses[verses.length - 1]).toBe(verses[verses.length - 2]);
  });

  test('no section is left with a single line', () => {
    const raw = timed([30, 2, 2, 2, 30, 2, 2, 40]);
    const { lines } = parseLrc(raw);
    const verses = groupVerses(lines, raw);

    const counts = new Map<number, number>();
    for (const v of verses) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const n of counts.values()) expect(n).toBeGreaterThanOrEqual(2);
  });

  test('verse indexes stay dense after merging', () => {
    const raw = timed([30, 2, 2, 30, 2, 2, 2]);
    const { lines } = parseLrc(raw);
    const verses = groupVerses(lines, raw);
    const unique = [...new Set(verses)].sort((a, b) => a - b);
    expect(unique).toEqual(unique.map((_, i) => i));
  });

  test('genuine multi-line sections are still separated', () => {
    const raw = timed([2, 2, 30, 2, 2]);
    const { lines } = parseLrc(raw);
    const verses = groupVerses(lines, raw);
    expect(new Set(verses).size).toBe(2);
    expect(verses).toEqual([0, 0, 0, 1, 1, 1]);
  });

  test('blank-line sections get the same runt treatment', () => {
    // A single line, a blank, then a real block — as pasted lyrics often look.
    const raw = 'alpha\n\nbravo\ncharlie\ndelta';
    const lines = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((text) => ({ text, timeMs: null }));
    const verses = groupVerses(lines, raw);
    const counts = new Map<number, number>();
    for (const v of verses) counts.set(v, (counts.get(v) ?? 0) + 1);
    for (const n of counts.values()) expect(n).toBeGreaterThanOrEqual(2);
  });

  test('returns one index per line no matter what', () => {
    for (const gaps of [[], [2], [40], [2, 40, 2], [40, 40, 40]]) {
      const raw = timed(gaps);
      const { lines } = parseLrc(raw);
      expect(groupVerses(lines, raw)).toHaveLength(lines.length);
    }
  });
});
