import { describe, expect, test } from 'bun:test';
import { parseLrc, parsePlain, groupVerses } from '../server/lyrics/lrc';

// Test fixtures are placeholder text written for these tests.
describe('parseLrc', () => {
  test('parses timestamps into milliseconds', () => {
    const { lines } = parseLrc('[00:12.34]first\n[01:05.00]second');
    expect(lines).toEqual([
      { text: 'first', timeMs: 12_340 },
      { text: 'second', timeMs: 65_000 },
    ]);
  });

  test('treats three-digit fractions as milliseconds', () => {
    const { lines } = parseLrc('[00:01.500]x');
    expect(lines[0].timeMs).toBe(1500);
  });

  test('expands a line carrying several timestamps', () => {
    const { lines } = parseLrc('[00:10.00][01:10.00]chorus');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.timeMs)).toEqual([10_000, 70_000]);
  });

  test('drops metadata tags and applies offset', () => {
    const { lines, offsetMs } = parseLrc('[ar:Someone]\n[offset:+500]\n[00:01.00]x');
    expect(offsetMs).toBe(500);
    expect(lines).toEqual([{ text: 'x', timeMs: 1500 }]);
  });

  test('skips empty interlude markers', () => {
    const { lines } = parseLrc('[00:01.00]a\n[00:05.00]\n[00:09.00]b');
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  test('sorts out-of-order timestamps', () => {
    const { lines } = parseLrc('[00:20.00]late\n[00:05.00]early');
    expect(lines.map((l) => l.text)).toEqual(['early', 'late']);
  });

  test('falls back to unsynced lines when no timestamps exist', () => {
    const { lines } = parseLrc('plain one\nplain two');
    expect(lines).toEqual([
      { text: 'plain one', timeMs: null },
      { text: 'plain two', timeMs: null },
    ]);
  });
});

describe('parsePlain', () => {
  test('drops blank lines', () => {
    expect(parsePlain('a\n\n\nb\n').map((l) => l.text)).toEqual(['a', 'b']);
  });
});

describe('groupVerses', () => {
  test('uses blank-line separation from the source when present', () => {
    const raw = 'a\nb\n\nc\nd';
    const lines = parsePlain(raw);
    expect(groupVerses(lines, raw)).toEqual([0, 0, 1, 1]);
  });

  test('splits on timing gaps when the source has no blank lines', () => {
    const raw = [
      '[00:00.00]a',
      '[00:02.00]b',
      '[00:04.00]c',
      '[00:30.00]d',
      '[00:32.00]e',
    ].join('\n');
    const { lines } = parseLrc(raw);
    expect(groupVerses(lines, raw)).toEqual([0, 0, 0, 1, 1]);
  });

  test('falls back to fixed blocks when there is no other signal', () => {
    const raw = Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n');
    const lines = parsePlain(raw);
    expect(groupVerses(lines, raw, 4)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2]);
  });

  test('always returns one verse index per line', () => {
    const raw = 'a\nb\nc';
    const lines = parsePlain(raw);
    expect(groupVerses(lines, raw)).toHaveLength(3);
  });
});
