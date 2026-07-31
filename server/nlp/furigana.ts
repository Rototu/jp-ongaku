import type { FuriganaSegment } from '../../shared/types';
import { dict } from '../dict';
import { hiragana, isKanjiChar } from './kana';

/**
 * Aligns a surface form against its reading so each kanji run gets exactly the
 * kana that belong to it.
 *
 * Order of preference:
 *   1. JmdictFurigana's curated mapping (handles 今日/きょう, 大人/おとな, and
 *      other cases no algorithm can derive).
 *   2. Kana-anchored alignment: the kana already visible in the surface form
 *      pin down where each kanji run's reading starts and ends.
 *   3. Whole-word ruby as a last resort.
 */
export function alignFurigana(surface: string, reading: string): FuriganaSegment[] {
  const kana = hiragana(reading);

  if (!surface) return [];
  // No kanji at all: nothing to annotate.
  if (![...surface].some(isKanjiChar)) return [{ text: surface, ruby: '' }];

  const curated = dict().furigana(surface, kana);
  if (curated && curated.length > 0) return curated;

  const algo = kanaAnchoredAlign(surface, kana);
  if (algo) return algo;

  return [{ text: surface, ruby: kana }];
}

interface Run {
  text: string;
  kanji: boolean;
}

function splitRuns(surface: string): Run[] {
  const runs: Run[] = [];
  for (const ch of surface) {
    const kanji = isKanjiChar(ch);
    const last = runs[runs.length - 1];
    if (last && last.kanji === kanji) last.text += ch;
    else runs.push({ text: ch, kanji });
  }
  return runs;
}

/**
 * Walks the runs left to right. Kana runs must appear verbatim in the reading;
 * finding the next kana run tells us how much reading belongs to the kanji run
 * before it. Returns null when the reading cannot be matched, so the caller can
 * fall back rather than display something wrong.
 */
function kanaAnchoredAlign(surface: string, reading: string): FuriganaSegment[] | null {
  const runs = splitRuns(surface);
  const segments: FuriganaSegment[] = [];
  let pos = 0;

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];

    if (!run.kanji) {
      const runKana = hiragana(run.text);
      // Non-kanji, non-kana (punctuation, latin, digits) can't be matched
      // against the reading; emit as-is and keep going.
      if (!reading.startsWith(runKana, pos)) {
        const idx = reading.indexOf(runKana, pos);
        if (runKana.trim() === '' || idx === -1) {
          segments.push({ text: run.text, ruby: '' });
          continue;
        }
        pos = idx;
      }
      segments.push({ text: run.text, ruby: '' });
      pos += runKana.length;
      continue;
    }

    const next = runs[i + 1];
    if (!next) {
      // Trailing kanji run takes the rest of the reading.
      const rest = reading.slice(pos);
      if (!rest) return null;
      segments.push({ text: run.text, ruby: rest });
      pos = reading.length;
      continue;
    }

    const nextKana = hiragana(next.text);
    if (nextKana.trim() === '') {
      // Followed by punctuation: give this run everything up to the end.
      segments.push({ text: run.text, ruby: reading.slice(pos) });
      pos = reading.length;
      continue;
    }

    // A kanji run always reads as at least one kana, so start searching past it.
    const anchor = reading.indexOf(nextKana, pos + 1);
    if (anchor === -1 || anchor <= pos) return null;
    segments.push({ text: run.text, ruby: reading.slice(pos, anchor) });
    pos = anchor;
  }

  if (pos !== reading.length) return null;
  return segments;
}

/** Renders segments back to plain kana — used for cloze answers and audio hints. */
export function segmentsToReading(segments: FuriganaSegment[]): string {
  return segments.map((s) => (s.ruby ? s.ruby : hiragana(s.text))).join('');
}
