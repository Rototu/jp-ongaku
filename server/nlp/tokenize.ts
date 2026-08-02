import kuromoji from 'kuromoji';
import { join } from 'node:path';
import type { FuriganaSegment, GrammarNote, Token } from '../../shared/types';
import { ROOT } from '../paths';
import { dict } from '../dict';
import { alignFurigana } from './furigana';
import { hiragana, isLoanword, toRomaji } from './kana';
import { priorityFor } from './priority';
import { chunkTokens } from './merge';
import { detectPatterns } from './grammar';
import { functionWordGloss } from './particles';

export interface KuromojiToken {
  surface_form: string;
  pos: string;
  pos_detail_1: string;
  pos_detail_2: string;
  pos_detail_3: string;
  conjugated_type: string;
  conjugated_form: string;
  basic_form: string;
  reading?: string;
  pronunciation?: string;
}

interface Tokenizer {
  tokenize(text: string): KuromojiToken[];
}

const DIC_PATH = join(ROOT, 'node_modules', 'kuromoji', 'dict');

let tokenizerPromise: Promise<Tokenizer> | null = null;

/** kuromoji loads ~15MB of dictionary; do it once, lazily, and share it. */
export function getTokenizer(): Promise<Tokenizer> {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: DIC_PATH }).build((err: Error | null, tokenizer: Tokenizer) => {
        if (err) reject(err);
        else resolve(tokenizer);
      });
    });
  }
  return tokenizerPromise;
}

/** POS tags that carry no vocabulary value on their own. */
const FILLER_POS = new Set(['記号', 'フィラー']);
/** POS tags that are grammar, not vocabulary — glossed, never auto-enrolled. */
const GRAMMAR_POS = new Set(['助詞', '助動詞']);

function isFiller(t: KuromojiToken): boolean {
  if (FILLER_POS.has(t.pos)) return true;
  return t.surface_form.trim() === '';
}

export function readingOf(t: KuromojiToken): string {
  // Unknown words (latin, symbols, novel katakana) come back without a reading.
  if (t.reading && t.reading !== '*') return hiragana(t.reading);
  return hiragana(t.surface_form);
}

function baseFormOf(t: KuromojiToken): string {
  return t.basic_form && t.basic_form !== '*' ? t.basic_form : t.surface_form;
}

/** Collapses adjacent unannotated segments so ruby markup stays tidy. */
function coalesce(segments: FuriganaSegment[]): FuriganaSegment[] {
  const out: FuriganaSegment[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (last && !last.ruby && !s.ruby) last.text += s.text;
    else out.push({ ...s });
  }
  return out;
}

/** Romaji for one token, honouring particle pronunciation (は -> wa). */
function romajiFor(t: KuromojiToken, reading: string): string {
  const fw = functionWordGloss(t.surface_form, t.pos);
  if (fw?.romaji) return fw.romaji;
  return toRomaji(reading);
}

/**
 * Reading of a token's dictionary form, derived by replacing the inflected tail
 * of the surface reading with the dictionary form's tail. 走り/はしり + 走る
 * gives はしる, which lets the dictionary disambiguate by reading.
 */
function baseReadingGuess(
  head: KuromojiToken,
  headReading: string,
  baseForm: string,
): string | undefined {
  if (baseForm === head.surface_form) return headReading;
  const surface = head.surface_form;
  // Find the shared prefix of surface and base form; the reading keeps that
  // prefix's reading and takes the base form's remainder.
  let shared = 0;
  while (shared < surface.length && shared < baseForm.length && surface[shared] === baseForm[shared]) {
    shared++;
  }
  const droppedTail = [...surface].length - shared;
  if (droppedTail < 0 || shared === 0) return undefined;
  const kept = droppedTail === 0 ? headReading : headReading.slice(0, headReading.length - droppedTail);
  if (!kept) return undefined;
  return kept + baseForm.slice(shared);
}

export interface AnalyzedToken extends Token {
  /** Grammar patterns carried by this chunk. */
  grammar: GrammarNote[];
  /** Curated explanation when the chunk is a particle or auxiliary. */
  functionGloss?: string;
  /** Raw tokenizer surfaces that were merged into this chunk. */
  parts: string[];
}

export async function tokenizeLine(text: string): Promise<AnalyzedToken[]> {
  const tokenizer = await getTokenizer();
  const raw = tokenizer.tokenize(text);
  const chunks = chunkTokens(raw);
  const d = dict();
  const out: AnalyzedToken[] = [];

  chunks.forEach((chunk, idx) => {
    const head = chunk.head;
    const surface = chunk.tokens.map((t) => t.surface_form).join('');
    const reading = chunk.tokens.map((t) => readingOf(t)).join('');
    const filler = chunk.tokens.every(isFiller);
    const baseForm = baseFormOf(head);
    const grammarOnly = GRAMMAR_POS.has(head.pos);

    const headReading = readingOf(head);
    const chosen =
      filler || grammarOnly
        ? undefined
        : d.lookup({
            surface: head.surface_form,
            reading: headReading,
            baseForm,
            // Reading of the dictionary form: the head's reading with its
            // inflected tail swapped back (走り/はしり -> 走る/はしる).
            baseReading: baseReadingGuess(head, headReading, baseForm),
          });

    const fw = functionWordGloss(head.surface_form, head.pos);
    const grammar = filler ? [] : detectPatterns(chunk.tokens);

    const furigana = filler
      ? [{ text: surface, ruby: '' }]
      : coalesce(
          chunk.tokens.flatMap((t) =>
            isFiller(t)
              ? [{ text: t.surface_form, ruby: '' }]
              : alignFurigana(t.surface_form, readingOf(t)),
          ),
        );

    // Romanise the chunk's full reading in one pass. Doing it per token loses
    // gemination and long vowels that straddle a token boundary
    // (だっ + た would come out "data" instead of "datta").
    const romaji = filler
      ? surface
      : chunk.tokens.length === 1
        ? romajiFor(head, reading)
        : toRomaji(reading);

    out.push({
      idx,
      surface,
      reading,
      romaji,
      baseForm,
      baseReading: chosen?.reading ?? headReading,
      pos: head.pos,
      posDetail: [head.pos_detail_1, head.pos_detail_2, head.pos_detail_3]
        .filter((x) => x && x !== '*')
        .join('/'),
      conjugation:
        chunk.tokens.length > 1
          ? chunk.tokens
              .slice(1)
              .map((t) => t.surface_form)
              .join(' + ')
          : undefined,
      furigana,
      filler,
      entry: chosen,
      functionGloss: fw?.gloss,
      grammar,
      parts: chunk.tokens.map((t) => t.surface_form),
      priority:
        filler || grammarOnly
          ? 0
          : priorityFor({ token: head, entry: chosen, loanword: isLoanword(surface) }),
    });
  });

  return out;
}

/** Romaji for a whole line, spaced by chunk so it reads naturally. */
export function lineRomaji(tokens: AnalyzedToken[]): string {
  return tokens
    .map((t) => (t.filler ? t.surface : t.romaji))
    .join(' ')
    .replace(/\s+([、。！？,.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Kana-only rendering of a line, for listening prompts. */
export function lineKana(tokens: AnalyzedToken[]): string {
  return tokens.map((t) => (t.filler ? t.surface : t.reading)).join('');
}
