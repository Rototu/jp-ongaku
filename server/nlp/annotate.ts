import type { FuriganaSegment } from '../../shared/types';
import { dict } from '../dict';
import { alignFurigana } from './furigana';
import { hasKanji, hiragana, isKana, isKanjiChar } from './kana';
import { getTokenizer, readingOf } from './tokenize';

/**
 * Ruby for Japanese embedded in English prose.
 *
 * Explanations, grammar notes and model answers quote Japanese inside a
 * sentence — "the 已然形 of 見回す". The lyric pipeline annotates the lyrics
 * themselves, but that text never went through it, so the quoted kanji arrived
 * bare. Since the whole app is built on the premise that kanji is shown and
 * never required, prose has to carry readings too.
 *
 * The text is split into runs; only the runs that contain kanji are tokenised,
 * everything else (English, punctuation, kana) passes through untouched.
 */

/** Whether a character belongs to a Japanese run. */
function isJapaneseChar(ch: string): boolean {
  return isKanjiChar(ch) || isKana(ch) || ch === 'ー' || ch === '〜' || ch === '～';
}

interface Run {
  text: string;
  japanese: boolean;
}

function splitJapaneseRuns(text: string): Run[] {
  const runs: Run[] = [];
  for (const ch of text) {
    const japanese = isJapaneseChar(ch);
    const last = runs[runs.length - 1];
    if (last && last.japanese === japanese) last.text += ch;
    else runs.push({ text: ch, japanese });
  }
  return runs;
}

/** Collapses adjacent unannotated segments so the markup stays tidy. */
function coalesce(segments: FuriganaSegment[]): FuriganaSegment[] {
  const out: FuriganaSegment[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && !last.ruby && !s.ruby) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

/**
 * Reading for one tokenizer token, in hiragana.
 *
 * Words the tokenizer does not know come back with their own surface as the
 * "reading", which would put kanji above kanji. The dictionary is asked next,
 * and failing that the token is left bare rather than annotated with a guess.
 */
function tokenReading(surface: string, raw: string): string | null {
  if (raw && !hasKanji(raw)) return raw;
  const entry = dict().lookup({ surface, baseForm: surface });
  if (entry && !hasKanji(entry.reading)) return hiragana(entry.reading);
  return null;
}

async function annotateRun(run: string): Promise<FuriganaSegment[]> {
  // A quoted word is usually a dictionary entry in its own right. Asking for the
  // whole run first keeps compounds together, where the tokenizer would split
  // them and read each half on its own.
  const whole = dict().lookup({ surface: run, baseForm: run });
  if (whole && whole.headword === run && !hasKanji(whole.reading)) {
    return alignFurigana(run, hiragana(whole.reading));
  }

  const tokenizer = await getTokenizer();
  return tokenizer.tokenize(run).flatMap((t) => {
    const surface = t.surface_form;
    if (!hasKanji(surface)) return [{ text: surface, ruby: '' }];
    const reading = tokenReading(surface, readingOf(t));
    if (!reading) return [{ text: surface, ruby: '' }];
    return alignFurigana(surface, reading);
  });
}

/**
 * Splits mixed English/Japanese text into segments, with ruby over every kanji
 * run whose reading could be established. Text with no kanji comes back as a
 * single plain segment, so callers can treat the result uniformly.
 */
export async function annotateText(text: string): Promise<FuriganaSegment[]> {
  if (!text) return [];
  if (!hasKanji(text)) return [{ text, ruby: '' }];

  const cached = cache.get(text);
  if (cached) return cached;

  const segments: FuriganaSegment[] = [];
  for (const run of splitJapaneseRuns(text)) {
    if (!run.japanese || !hasKanji(run.text)) {
      segments.push({ text: run.text, ruby: '' });
      continue;
    }
    segments.push(...(await annotateRun(run.text)));
  }

  const out = coalesce(segments);
  remember(text, out);
  return out;
}

/**
 * Annotation is deterministic and the same explanations are reopened constantly,
 * so results are kept in memory. The cap keeps a long session from holding every
 * string the user has ever looked at.
 */
const CACHE_LIMIT = 4000;
const cache = new Map<string, FuriganaSegment[]>();

function remember(text: string, segments: FuriganaSegment[]): void {
  if (cache.size >= CACHE_LIMIT) {
    // Oldest first — Map preserves insertion order.
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(text, segments);
}
