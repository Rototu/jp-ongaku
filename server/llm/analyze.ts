import { getDb, nowIso } from '../db';
import { complete, extractJson, LlmUnavailable, resolveProvider } from './provider';
import type { AnalyzedToken } from '../nlp/tokenize';
import { lineRomaji, tokenizeLine } from '../nlp/tokenize';
import { lineFurigana } from '../lesson/build';
import type {
  AiChunk,
  GrammarNote,
  KanjiMnemonic,
  WordExample,
  WordQuestion,
} from '../../shared/types';
import { alignFurigana } from '../nlp/furigana';
import { hiragana, toRomaji } from '../nlp/kana';
import { roleColorIdx } from '../../shared/roles';
import { dict } from '../dict';
import { shippedMnemonics } from '../mnemonics';

/**
 * The explanation layer.
 *
 * The local parse (kuromoji + JMdict) is deterministic and offline, but it is
 * only morphology: it cannot tell 今日 きょう from こんにち by context, cannot
 * decode a contraction, and knows nothing about the set expressions songs are
 * built from. So when a model is available it is the primary source for
 * segmentation, readings and explanations, and the local parse becomes the
 * cross-check and the offline fallback.
 *
 * Correctness guardrails, because wrong material is worse than none:
 *   1. The model's chunks must concatenate back to the exact original line.
 *      A hallucinated or dropped word fails the whole line rather than being
 *      silently taught.
 *   2. Every reading is checked against JMdict and marked verified /
 *      unverified / unknown, so a surprising reading is visible as such.
 *   3. Furigana is aligned locally from the reading, never taken as markup from
 *      the model.
 *   4. A line that fails validation twice keeps the local parse.
 */

const SYSTEM = `You are a meticulous Japanese teacher working with a learner who reads almost no kanji.
They study song lyrics and rely on furigana and romaji.

Absolute rules:
- Accuracy first. If you are unsure of a reading, give the most standard one and say so in the explanation.
- Never invent, drop, reorder or "correct" any character of the line you are given.
- The concatenation of your segments must equal the original line exactly, including punctuation,
  spaces, and any latin or symbol characters.
- Readings must be in hiragana only (katakana words are still read in hiragana), matching how the
  word is actually pronounced in this line.
- The reading is your judgement, not a lookup. Each segment comes with the readings a dictionary
  offers for it; they are candidates, in no particular order of correctness for THIS line. Choose the
  one actually sung here — 今日 is きょう or こんにち depending on the line, 上 is うえ or じょう or
  かみ, and a name can be read a way no dictionary lists. If the sung reading is not among the
  candidates, give it anyway and say in that segment's explanation why it differs.
- Where the learner's background notes tell you how something is pronounced, that instruction wins
  over both the dictionary and your own default.
- If the notes give a reading that covers several words, segment so that one segment carries it. A
  stylised lyric may write four kanji and be sung as one short word; splitting it and reading each
  half literally contradicts the reading you were given. Say what happened in the explanation.
- Segment into meaningful learning units: a word plus its inflection is ONE segment
  (探している, 忘れたくない), a set expression is ONE segment, but case particles
  (は, が, を, に, で, の, も) are their own segments.
- Explain contractions, dropped particles, poetic or inverted word order, and slang — song lyrics
  break textbook grammar constantly and the learner needs to be told when that happens.
- Reply with JSON only. No prose outside the JSON.`;

export interface AnalyzeProgress {
  done: number;
  total: number;
}

/** Lines per request. Small keeps the model accurate on every line. */
const BATCH_SIZE = 6;
/**
 * Cap on the user's own context, in characters.
 *
 * It is repeated in every batch request, so a pasted novel would multiply the
 * cost of analysing one song by its own length. A few thousand characters is
 * enough for an interview excerpt or a plot summary.
 */
const MAX_CONTEXT_CHARS = 4000;

export interface AnalyzeResult {
  provider: string;
  linesAnalyzed: number;
  batches: number;
  skipped: number;
  /** Lines whose segmentation failed validation and kept the local parse. */
  rejected: number;
  /** One message per failed batch. Empty when everything succeeded. */
  errors: string[];
}

interface LlmSegment {
  text?: string;
  reading?: string;
  role?: string;
  meaning?: string;
  explanation?: string;
}

interface LlmLineResult {
  idx?: number;
  translation?: string;
  literal?: string;
  segments?: LlmSegment[];
  notes?: { pattern?: string; explanation?: string }[];
}

interface LineRow {
  id: number;
  idx: number;
  text: string;
  tokens: string;
  has: number;
}

/** Injectable transport, so validation logic is testable without a model. */
export type Completer = (prompt: string, system?: string) => Promise<string>;

export async function analyzeSong(
  songId: number,
  opts: {
    force?: boolean;
    onProgress?: (p: AnalyzeProgress) => void;
    completer?: Completer;
  } = {},
): Promise<AnalyzeResult> {
  const db = getDb();
  const provider = resolveProvider();
  const send = opts.completer ?? complete;
  const context = songContext(songId);
  if (!opts.completer && provider.name === 'none') {
    throw new LlmUnavailable('no API key configured for the AI Gateway');
  }

  const rows = db
    .query<LineRow, [number]>(
      `SELECT l.id, l.idx, l.text, l.tokens,
              (SELECT COUNT(*) FROM line_analysis a
                WHERE a.line_id = l.id AND a.translation IS NOT NULL AND a.chunks != '[]') AS has
       FROM lines l WHERE l.song_id = ? ORDER BY l.idx`,
    )
    .all(songId);

  const pending = opts.force ? rows : rows.filter((r) => r.has === 0);
  if (pending.length === 0) {
    return {
      provider: provider.name,
      linesAnalyzed: 0,
      batches: 0,
      skipped: rows.length,
      rejected: 0,
      errors: [],
    };
  }

  const batches: LineRow[][] = [];
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    batches.push(pending.slice(i, i + BATCH_SIZE));
  }

  let analyzed = 0;
  let rejected = 0;
  const errors: string[] = [];

  const save = db.prepare(
    `INSERT INTO line_analysis (line_id, translation, literal, notes, chunks, provider, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (line_id) DO UPDATE SET
       translation = excluded.translation,
       literal     = excluded.literal,
       notes       = excluded.notes,
       chunks      = excluded.chunks,
       provider    = excluded.provider,
       updated_at  = excluded.updated_at`,
  );

  /** Requests one batch, validates it, and persists whatever survived. */
  const runBatch = async (batch: LineRow[], batchNo: number): Promise<void> => {
    let results: LlmLineResult[] | null = null;
    let lastError: unknown = null;

    // One retry with an explicit correction, because a segmentation that does
    // not reconstruct the line is the most common and most dangerous failure.
    for (let attempt = 0; attempt < 2 && results === null; attempt++) {
      try {
        const prompt = buildPrompt(batch, attempt === 1, context);
        const text = await send(prompt, SYSTEM);
        const parsed = extractJson<LlmLineResult[]>(text);
        if (!Array.isArray(parsed)) throw new Error('expected a JSON array of lines');
        results = parsed;
      } catch (err) {
        lastError = err;
      }
    }

    if (results === null) {
      const message = explainFailure(lastError, provider.name);
      console.error(`[analyze] batch ${batchNo + 1}/${batches.length} failed: ${message}`);
      if (!errors.includes(message)) errors.push(message);
      return;
    }

    const byIdx = new Map(batch.map((r) => [r.idx, r]));

    for (const result of results) {
      const line = typeof result.idx === 'number' ? byIdx.get(result.idx) : undefined;
      if (!line) continue;

      const chunks = buildChunks(line.text, result.segments ?? []);
      if (chunks === null) {
        // Segmentation did not reconstruct the line. Keep the translation (it is
        // still useful) but leave the local parse in charge of the words.
        rejected++;
        console.warn(`[analyze] line ${line.idx} segmentation rejected; keeping local parse`);
      }

      const notes: GrammarNote[] = (result.notes ?? [])
        .filter((n) => n.pattern && n.explanation)
        .map((n) => ({
          key: `llm:${slug(n.pattern as string)}`,
          pattern: n.pattern as string,
          explanation: n.explanation as string,
          jlpt: null,
        }));

      db.transaction(() => {
        save.run(
          line.id,
          result.translation ?? null,
          result.literal ?? null,
          JSON.stringify(notes),
          JSON.stringify(chunks ?? []),
          provider.name,
          nowIso(),
        );
      })();
      analyzed++;
    }
  };

  // Batches run concurrently. They are independent — each writes only its own
  // lines — so the only reason this was ever sequential was that it was written
  // that way. Wall clock for a song drops by roughly the pool size.
  const poolSize = Math.max(1, Math.min(provider.concurrency, batches.length));
  let nextBatch = 0;
  let finished = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const batchNo = nextBatch++;
      if (batchNo >= batches.length) return;
      await runBatch(batches[batchNo], batchNo);
      finished++;
      opts.onProgress?.({
        done: Math.min(finished * BATCH_SIZE, pending.length),
        total: pending.length,
      });
    }
  };

  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  if (analyzed > 0) {
    db.prepare('UPDATE songs SET analyzed = 1 WHERE id = ?').run(songId);
  }

  return {
    provider: provider.name,
    linesAnalyzed: analyzed,
    batches: batches.length,
    skipped: rows.length - pending.length,
    rejected,
    errors,
  };
}

/** Whitespace is not meaningful for the reconstruction check. */
function normalize(s: string): string {
  return s.replace(/[\s　]/g, '');
}

/** Particles whose pronunciation differs from their spelling. */
const PARTICLE_ROMAJI: Record<string, string> = { は: 'wa', を: 'o', へ: 'e' };

/**
 * Romaji for a chunk, honouring particle pronunciation.
 *
 * 「を」 is read "o" and 「は」 as a topic marker is "wa", but a straight
 * kana-to-romaji conversion gives "wo" and "ha". The same override exists in the
 * local tokenizer; chunks need it too, since romaji is what this user actually
 * reads.
 */
function chunkRomaji(text: string, reading: string, role: string): string {
  const override = PARTICLE_ROMAJI[text];
  // Only when the chunk *is* the bare particle: 葉 (は, "leaf") must stay "ha",
  // and a longer chunk containing は is romanised normally.
  if (override && reading === text) {
    const looksGrammatical = /particle|marker|topic|object|direction/i.test(role);
    if (looksGrammatical || role === '') return override;
  }
  return toRomaji(reading);
}

/**
 * Validates the model's segmentation against the original line and turns it
 * into renderable chunks. Returns null when the segments do not reconstruct the
 * line, which is the caller's signal to keep the local parse.
 */
export function buildChunks(lineText: string, segments: LlmSegment[]): AiChunk[] | null {
  const usable = segments.filter((s) => typeof s.text === 'string' && s.text.length > 0);
  if (usable.length === 0) return null;

  const rebuilt = usable.map((s) => s.text as string).join('');
  if (normalize(rebuilt) !== normalize(lineText)) return null;

  const d = dict();
  const chunks: AiChunk[] = [];

  for (const seg of usable) {
    const text = seg.text as string;
    const role = (seg.role ?? '').trim();
    const studyable = /[぀-ゟ゠-ヿ一-鿿]/.test(text);
    // Katakana readings are normalised to hiragana; punctuation gets none.
    const reading = studyable ? hiragana((seg.reading ?? '').trim()) : '';

    // Furigana is derived locally from the reading. Taking ruby markup from the
    // model would let a mis-split reading land on the wrong kanji.
    const furigana =
      studyable && reading ? alignFurigana(text, reading) : [{ text, ruby: '' }];

    chunks.push({
      text,
      reading,
      romaji: reading ? chunkRomaji(text, reading, role) : '',
      furigana,
      // Hue carries the grammar role, so it is the role that picks the slot.
      colorIdx: studyable ? roleColorIdx(role) : -1,
      role,
      meaning: (seg.meaning ?? '').trim(),
      explanation: (seg.explanation ?? '').trim(),
      readingCheck: checkReading(d, text, reading),
    });
  }

  return chunks;
}

/**
 * Cross-checks a reading against the dictionary so a surprising one is visible
 * rather than taken on faith.
 *
 * Inflected phrases legitimately have readings no single entry carries
 * (探している is not a headword), so a prefix match against an entry's reading
 * counts as verification.
 */
function checkReading(
  d: ReturnType<typeof dict>,
  text: string,
  reading: string,
): AiChunk['readingCheck'] {
  if (!reading || !d.available) return 'unknown';

  const entries = d.entriesFor(text);
  if (entries.length > 0) {
    // Against every reading the dictionary allows, not just each entry's first
    // kana form: 今日 as こんにち is standard, and flagging it as surprising
    // trained the user to distrust a marker that was itself wrong.
    if (d.readingsFor(text).includes(reading)) return 'verified';
    return 'unverified';
  }

  // Not a headword: try the stem, so conjugated forms can still be checked.
  for (let cut = 1; cut <= 3 && cut < [...text].length; cut++) {
    const stem = [...text].slice(0, -cut).join('');
    const stemEntries = d.entriesFor(stem);
    if (stemEntries.length === 0) continue;
    if (stemEntries.some((e) => reading.startsWith(e.reading.slice(0, Math.max(1, e.reading.length - cut))))) {
      return 'verified';
    }
    return 'unverified';
  }

  return 'unknown';
}

/**
 * The readings this song has already settled on, surface -> reading.
 *
 * Built from the analysed chunks, which is where a song's own pronunciations live:
 * a stylised reading the singer uses, a name read a way no dictionary lists, a
 * compound the model decided by context. Anything that quotes the song's Japanese
 * later — a grammar note, an explanation, a generated example — has to agree with
 * what the lyrics above it already show, so this map is what those quotes are
 * annotated against.
 *
 * Only chunks carrying kanji matter: kana needs no ruby, and mapping it would
 * shadow ordinary words for no gain.
 */
export function songReadings(songId: number): Map<string, string> {
  const rows = getDb()
    .query<{ chunks: string }, [number]>(
      `SELECT a.chunks FROM line_analysis a
         JOIN lines l ON l.id = a.line_id
       WHERE l.song_id = ? AND a.chunks IS NOT NULL AND a.chunks != '[]'`,
    )
    .all(songId);

  const readings = new Map<string, string>();
  for (const row of rows) {
    let chunks: AiChunk[];
    try {
      chunks = JSON.parse(row.chunks) as AiChunk[];
    } catch {
      continue;
    }
    for (const chunk of chunks) {
      if (!chunk.text || !chunk.reading) continue;
      if (!/[一-鿿]/.test(chunk.text)) continue;
      // First writer wins: a word read one way in verse one and another in the
      // chorus is rare, and re-reading it per quote would be worse than steady.
      if (!readings.has(chunk.text)) readings.set(chunk.text, chunk.reading);
    }
  }
  return readings;
}

/**
 * The notes the user pasted for this song, if any.
 *
 * A song's meaning often lives outside its words — who is speaking, what the
 * anime is about, what the writer said in an interview — and no amount of
 * morphology recovers that. Whatever the user pastes is handed to the model as
 * background, clearly marked as background so it can never override the text.
 */
export function songContext(songId: number): string | null {
  const row = getDb()
    .query<{ context: string | null }, [number]>('SELECT context FROM songs WHERE id = ?')
    .get(songId);
  const trimmed = row?.context?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_CONTEXT_CHARS);
}

function contextBlock(context: string | null): string {
  if (!context) return '';
  return `Background and instructions the learner supplied for this song. Use it to pick the right
sense of a word, the right speaker, and a translation that fits what the song is actually about.
If it says how something is pronounced — a name, a coined word, a kanji the singer reads their own
way — follow that over any dictionary reading. It is context and instruction, not text to translate,
and it never changes the characters of the lines themselves:
"""
${context}
"""

`;
}

/** How many dictionary readings to offer per token, to bound the prompt. */
const MAX_READING_CANDIDATES = 5;

export interface ReadingOptions {
  /** Readings the dictionary lists for the segment exactly as written. */
  forSurface: string[];
  /**
   * The dictionary form and its readings, when the surface is inflected. Kept
   * apart from `forSurface` because they are not readings *of* the surface: 行って
   * is いって or おこなって depending on whether the lemma is 行く or 行う, and the
   * model needs to see that fork without being invited to answer いく.
   */
  baseForm: { form: string; readings: string[] } | null;
  /** What the tokenizer heard — for an inflected form, often the only guide. */
  parsed: string;
}

/**
 * Everything known about how a token could be read, for the model to choose from.
 *
 * The tokenizer commits to one reading and is regularly wrong where the reading
 * depends on context, which is most of the interesting cases: 今日, 上, 明日, every
 * name. Handing the model that single guess as though it were the answer made the
 * readings only as good as kuromoji's. Handing over the whole candidate set lets it
 * do the thing it is actually better at — choosing by context.
 */
export function readingCandidates(token: AnalyzedToken): ReadingOptions {
  const d = dict();
  const kana = (raw: string | undefined | null) => hiragana((raw ?? '').trim());
  const dedupe = (list: string[]) => {
    const out: string[] = [];
    for (const item of list) if (item && !out.includes(item)) out.push(item);
    return out.slice(0, MAX_READING_CANDIDATES);
  };

  const forSurface = d.available ? dedupe(d.readingsFor(token.surface).map(kana)) : [];

  const base = token.baseForm && token.baseForm !== token.surface ? token.baseForm : null;
  const baseReadings = base && d.available ? dedupe(d.readingsFor(base).map(kana)) : [];

  return {
    forSurface,
    baseForm: base && baseReadings.length > 0 ? { form: base, readings: baseReadings } : null,
    parsed: kana(token.reading),
  };
}

/** One token's readings as a line of the prompt. */
function readingHint(options: ReadingOptions): string {
  const parts: string[] = [];
  if (options.forSurface.length > 0) {
    parts.push(`readings to choose from: ${options.forSurface.join('|')}`);
  }
  if (options.baseForm) {
    parts.push(`dictionary form ${options.baseForm.form}: ${options.baseForm.readings.join('|')}`);
  }
  // With nothing from the dictionary the model is on its own — a coined word or a
  // name — and should know that the one reading it has is a machine guess.
  if (parts.length === 0) {
    return `no dictionary entry; parsed as ${options.parsed || '?'}`;
  }
  if (options.parsed && !options.forSurface.includes(options.parsed)) {
    parts.push(`parser guessed ${options.parsed}`);
  }
  return parts.join('; ');
}

function buildPrompt(batch: LineRow[], retry: boolean, context: string | null = null): string {
  const lines = batch.map((r) => {
    const tokens = JSON.parse(r.tokens) as AnalyzedToken[];
    const breakdown = tokens
      .filter((t) => !t.filler)
      .map((t) => {
        const gloss =
          t.functionGloss ?? t.entry?.senses[0]?.glosses.slice(0, 2).join('/') ?? '?';
        return `${t.surface}(=${gloss}; ${readingHint(readingCandidates(t))})`;
      })
      .join(' ');
    return `${r.idx}\t${r.text}\n\tlocal parse (may be wrong, trust the line): ${breakdown}`;
  });

  const correction = retry
    ? `\nYOUR PREVIOUS ANSWER WAS REJECTED because the segments did not join back into the exact
original line. Join your "text" values in order and compare character by character with the line
before answering. Do not translate, normalise or fix the Japanese text in any way.\n`
    : '';

  return `${contextBlock(context)}Analyse these lines from a Japanese song.
${correction}
${lines.join('\n')}

For each line return:
{
  "idx": <the number given>,
  "translation": "<natural English translation of the whole line>",
  "literal": "<literal word-order gloss, only if it differs usefully; else omit>",
  "segments": [
    {
      "text": "<exact substring of the line>",
      "reading": "<hiragana reading as sung here — your choice among the candidates offered, or your own if none of them fit>",
      "role": "<start with one of: noun, pronoun, verb, adjective, particle, expression, adverb — then any detail, e.g. 'noun (subject)', 'verb, progressive', 'particle (topic)'>",
      "meaning": "<what this segment means on its own, a few words>",
      "explanation": "<one or two sentences: why this form, what it does here, any contraction or slang>"
    }
  ],
  "notes": [ { "pattern": "<grammar point>", "explanation": "<one or two sentences>" } ]
}

The "segments" joined in order MUST equal the line exactly. Include punctuation as its own segment
with an empty reading. Return a JSON array of one object per line, in order. JSON only.`;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9　-鿿〜]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

/**
 * Turns a gateway failure into something the user can act on.
 *
 * Status is read from the prefix the transport writes, never by searching the
 * whole string — provider error prose contains numbers and URLs, and matching
 * those mislabels the failure (a rate-limit reported as a bad API key).
 * The gateway's own message is appended when present, because it usually names
 * the exact remedy.
 */
function explainFailure(err: unknown, _provider: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  const statusMatch = /^AI Gateway (\d{3}): ([\s\S]*)$/.exec(raw);
  const status = statusMatch ? Number(statusMatch[1]) : null;
  const detail = statusMatch ? statusMatch[2].trim() : raw;

  const withDetail = (summary: string) =>
    detail && detail.length > 0 ? `${summary} — the gateway said: ${detail.slice(0, 260)}` : summary;

  if (status === 401 || status === 403) {
    return withDetail('The AI Gateway rejected the API key. Check it in Settings.');
  }
  if (status === 404) {
    return withDetail('The gateway does not recognise that model id. Check the model in Settings.');
  }
  if (status === 429) {
    return withDetail(
      'The gateway is rate-limiting this model. Finished lines are already saved; re-run to continue, or switch model in Settings.',
    );
  }
  if (status === 400) {
    return withDetail('The gateway rejected the request.');
  }
  if (status !== null && status >= 500) {
    return withDetail('The gateway or the model provider had a server error. Re-running resumes where it stopped.');
  }
  if (/timeout|timed out|aborted/i.test(raw)) {
    return 'The AI request timed out. Try again — analysis resumes from where it stopped, so nothing is wasted.';
  }
  if (/no JSON found|unexpected format/i.test(raw)) {
    return 'The model replied in an unexpected format. Retrying usually fixes it; a stronger model fixes it for good.';
  }
  if (/no API key/i.test(raw)) {
    return 'No API key set for the AI Gateway. Add one in Settings.';
  }
  return raw.slice(0, 300);
}

/**
 * Generates a memory hook for a card the user keeps failing.
 * Returns null when no provider is available.
 */
export async function generateMnemonic(cardId: number): Promise<string | null> {
  const db = getDb();
  const row = db
    .query<{ front: string; back: string; kind: string }, [number]>(
      'SELECT front, back, kind FROM cards WHERE id = ?',
    )
    .get(cardId);
  if (!row) return null;

  const front = JSON.parse(row.front) as { jp?: string; romaji?: string };
  const back = JSON.parse(row.back) as { answer: string; reading?: string; romaji?: string };

  const prompt = `Create one memory hook for a learner who keeps forgetting this item.

Japanese: ${front.jp ?? back.reading ?? ''}
Reading: ${back.reading ?? ''}
Romaji: ${back.romaji ?? front.romaji ?? ''}
Meaning: ${back.answer}

Give a single vivid hook — a sound-alike in English, an image, or a story built from the
kanji components. Two sentences maximum. It must use the actual sound of the reading.
Return JSON: {"mnemonic": "..."}`;

  try {
    const text = await complete(prompt, SYSTEM);
    const parsed = extractJson<{ mnemonic?: string }>(text);
    const mnemonic = parsed.mnemonic?.trim();
    if (!mnemonic) return null;
    db.prepare(
      `INSERT INTO mnemonics (card_id, text, created_at) VALUES (?, ?, ?)
       ON CONFLICT (card_id) DO UPDATE SET text = excluded.text, created_at = excluded.created_at`,
    ).run(cardId, mnemonic, nowIso());
    return mnemonic;
  } catch (err) {
    if (err instanceof LlmUnavailable) return null;
    throw new Error(explainFailure(err, resolveProvider().name));
  }
}

// --- usage examples and follow-up questions ---------------------------------
//
// Both are asked about one word at a time, on demand, and both are cached in the
// database keyed by the word itself. Tapping the same word tomorrow costs
// nothing, and the answers stay available offline once they exist.

/** How many sentences one request asks for. */
const EXAMPLE_COUNT = 3;

export interface WordRef {
  term: string;
  reading?: string;
  /** Meaning as the app already shows it, so the model keeps the same sense. */
  meaning?: string;
  /** The lyric line the word was tapped in. */
  lineText?: string;
  songId?: number;
}

/** Normalised so the cache key is stable however the caller spells it. */
function refKey(ref: WordRef): { term: string; reading: string } {
  return { term: ref.term.trim(), reading: (ref.reading ?? '').trim() };
}

/** Background lines shared by the example and question prompts. */
function wordContextLines(ref: WordRef): string {
  const parts: string[] = [];
  if (ref.reading) parts.push(`Reading in this line: ${ref.reading}`);
  if (ref.meaning) parts.push(`Meaning the learner has been shown: ${ref.meaning}`);
  if (ref.lineText) parts.push(`The lyric line it appeared in: ${ref.lineText}`);
  const context = ref.songId ? songContext(ref.songId) : null;
  const block = contextBlock(context);
  return `${parts.join('\n')}\n${block ? `\n${block}` : ''}`;
}

/** Cached examples for a word, or null when none have been generated yet. */
export function cachedExamples(term: string, reading = ''): WordExample[] | null {
  const row = getDb()
    .query<{ examples: string }, [string, string]>(
      'SELECT examples FROM word_examples WHERE term = ? AND reading = ?',
    )
    .get(term.trim(), reading.trim());
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.examples) as WordExample[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Generates usage examples for a word or phrase and stores them.
 *
 * Returns the cached set unchanged unless `force` is set, which is the whole
 * point: examples are only worth generating once per word.
 *
 * The sentences come from the model, but their furigana and romaji are built
 * locally by the same tokenizer that annotates lyrics — ruby is never taken as
 * markup from a model, here or anywhere else.
 */
export async function generateExamples(
  ref: WordRef,
  opts: { force?: boolean; completer?: Completer } = {},
): Promise<{ examples: WordExample[]; cached: boolean }> {
  const { term, reading } = refKey(ref);
  if (!term) throw new Error('term is required');

  if (!opts.force) {
    const cached = cachedExamples(term, reading);
    if (cached) return { examples: cached, cached: true };
  }

  const send = opts.completer ?? complete;
  const prompt = `Write ${EXAMPLE_COUNT} short example sentences using 「${term}」.

${wordContextLines(ref)}
Rules:
- Everyday Japanese a beginner could meet: 6 to 14 characters per sentence, one clause each.
- Use 「${term}」 in the same sense it has in the line above. Vary the form and the register
  (plain, polite, question, negative) across the examples and say which is which in the note.
- Keep each sentence self-contained — no pronouns pointing at something unstated.

Return JSON: {"examples": [{"jp": "<the sentence in Japanese>", "english": "<natural translation>",
"note": "<register or nuance in one short clause, or omit>"}]}`;

  let raw: { examples?: { jp?: string; english?: string; note?: string }[] };
  try {
    raw = extractJson<typeof raw>(await send(prompt, SYSTEM));
  } catch (err) {
    if (err instanceof LlmUnavailable) throw err;
    throw new Error(explainFailure(err, resolveProvider().name));
  }

  const examples: WordExample[] = [];
  for (const candidate of raw.examples ?? []) {
    const jp = candidate.jp?.trim();
    const english = candidate.english?.trim();
    if (!jp || !english) continue;
    const tokens = await tokenizeLine(jp);
    examples.push({
      jp,
      furigana: lineFurigana(tokens),
      romaji: lineRomaji(tokens),
      english,
      note: candidate.note?.trim() || null,
    });
  }

  if (examples.length === 0) {
    throw new Error('The model returned no usable examples. Try again.');
  }

  getDb()
    .prepare(
      `INSERT INTO word_examples (term, reading, examples, provider, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (term, reading) DO UPDATE SET
         examples   = excluded.examples,
         provider   = excluded.provider,
         created_at = excluded.created_at`,
    )
    .run(term, reading, JSON.stringify(examples), resolveProvider().name, nowIso());

  return { examples, cached: false };
}

// --- kanji mnemonics --------------------------------------------------------
//
// A hook for the meaning and a hook for the sound, per character, in the
// WaniKani mould. Cached by the character alone: 言 is the same 言 in 言葉 as in
// 言う, so the second word that contains it costs nothing.

/**
 * Hooks available for these characters: the shipped artifact first, then this
 * user's own.
 *
 * The artifact covers the whole dictionary, so it answers nearly everything. The
 * user's table sits on top of it because that is where a character regenerated on
 * purpose lands, and a deliberate regeneration should win over the shipped text.
 */
export function cachedKanjiMnemonics(chars: string[]): Record<string, KanjiMnemonic> {
  const wanted = [...new Set(chars.filter((c) => c.length > 0))];
  if (wanted.length === 0) return {};
  const out: Record<string, KanjiMnemonic> = { ...shippedMnemonics(wanted) };
  const rows = getDb()
    .query<{ char: string; meaning: string; reading: string; reading_key: string }, string[]>(
      `SELECT char, meaning, reading, reading_key FROM kanji_mnemonics
       WHERE char IN (${wanted.map(() => '?').join(',')})`,
    )
    .all(...wanted);
  for (const row of rows) {
    out[row.char] = {
      char: row.char,
      meaning: row.meaning,
      reading: row.reading,
      readingKey: row.reading_key,
    };
  }
  return out;
}

/** What the model is told about a character, so its hooks are about the real one. */
export interface KanjiFacts {
  char: string;
  meanings: string[];
  on: string[];
  kun: string[];
  /** Components it decomposes into, from KRADFILE. Empty when unknown. */
  components?: string[];
}

/**
 * The request that asks for hooks, in one place because two callers send it: a
 * word being tapped, and the artifact build that covers the whole dictionary.
 *
 * `glossary` is what makes the artifact worth building — the names already given
 * to this batch's components, so 亠 is the same "lid" in 夜 as in 京 instead of
 * being re-imagined per request. It is empty on the tap path, which has no way to
 * know what other characters were called.
 */
export function kanjiMnemonicPrompt(facts: KanjiFacts[], glossary: [string, string][] = []): string {
  const listed = facts
    .map((f) => {
      const parts = [`${f.char} — meanings: ${f.meanings.slice(0, 4).join(', ') || 'unknown'}`];
      if (f.on.length > 0) parts.push(`on: ${f.on.slice(0, 3).join('、')}`);
      if (f.kun.length > 0) parts.push(`kun: ${f.kun.slice(0, 3).join('、')}`);
      if (f.components && f.components.length > 0) {
        parts.push(`parts: ${f.components.join(' ')}`);
      }
      return parts.join(' · ');
    })
    .join('\n');

  const glossaryBlock =
    glossary.length > 0
      ? `\nNames already in use for parts. Use these exact words when a part appears:\n${glossary
          .map(([char, name]) => `${char} = ${name}`)
          .join('\n')}\n`
      : '';

  return `Write memory hooks for these kanji, the way WaniKani does.

${listed}
${glossaryBlock}
For each character give two hooks:
- "meaning": how to remember what it means. Build it from the parts listed above, and name those
  parts so the learner can see them too.
- "reading": how to remember how it sounds. Build it around the actual sound of ONE reading —
  prefer the most common one — using an English sound-alike or a short image that contains it.
  Say which reading it is in "readingKey", in kana exactly as given above.

Rules:
- Two sentences maximum per hook. Concrete and visual beats clever.
- The sound-alike must really contain the sound of the reading. Do not invent a reading that is
  not in the list above.
- Do not just restate the meaning or spell out the reading — a hook that carries no image is
  worse than none.

Return JSON: {"kanji": [{"char": "<the character>", "meaning": "...", "reading": "...",
"readingKey": "<the reading the hook uses, in kana>"}]}`;
}

/**
 * Pulls usable hooks out of a reply, dropping anything that was not asked for.
 *
 * A model that answers for a character outside the batch, or gives half an
 * answer, must not have that written against a character — the entry is dropped
 * and the character stays uncovered, which the next run picks up.
 */
export function parseKanjiMnemonics(text: string, asked: KanjiFacts[]): KanjiMnemonic[] {
  const raw = extractJson<{
    kanji?: { char?: string; meaning?: string; reading?: string; readingKey?: string }[];
  }>(text);
  const wanted = new Map(asked.map((f) => [f.char, f]));
  const out: KanjiMnemonic[] = [];
  const seen = new Set<string>();

  for (const candidate of raw.kanji ?? []) {
    const char = candidate.char?.trim();
    const meaning = candidate.meaning?.trim();
    const reading = candidate.reading?.trim();
    if (!char || !meaning || !reading || !wanted.has(char) || seen.has(char)) continue;
    seen.add(char);

    // A readingKey the character does not actually have would teach a reading
    // that does not exist, so it is dropped back to empty rather than shown.
    const key = candidate.readingKey?.trim() ?? '';
    const facts = wanted.get(char) as KanjiFacts;
    const real = [...facts.on, ...facts.kun].map((r) => r.replace(/[.\-‐]/g, ''));
    const readingKey = real.includes(key.replace(/[.\-‐]/g, '')) ? key : '';

    out.push({ char, meaning, reading, readingKey });
  }
  return out;
}

/**
 * Generates the missing hooks for a set of characters, in one request.
 *
 * A word is looked up as a whole — 目覚める brings both 目 and 覚 — so asking per
 * character would pay for two round trips where one does. Already-cached
 * characters are returned untouched and never re-asked.
 */
export async function generateKanjiMnemonics(
  facts: KanjiFacts[],
  opts: { force?: boolean; completer?: Completer } = {},
): Promise<Record<string, KanjiMnemonic>> {
  const known = opts.force ? {} : cachedKanjiMnemonics(facts.map((f) => f.char));
  const missing = facts.filter((f) => f.char.length > 0 && !known[f.char]);
  if (missing.length === 0) return known;

  const send = opts.completer ?? complete;
  let parsed: KanjiMnemonic[];
  try {
    parsed = parseKanjiMnemonics(await send(kanjiMnemonicPrompt(missing), SYSTEM), missing);
  } catch (err) {
    if (err instanceof LlmUnavailable) throw err;
    throw new Error(explainFailure(err, resolveProvider().name));
  }

  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO kanji_mnemonics (char, meaning, reading, reading_key, provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (char) DO UPDATE SET
       meaning     = excluded.meaning,
       reading     = excluded.reading,
       reading_key = excluded.reading_key,
       provider    = excluded.provider,
       created_at  = excluded.created_at`,
  );
  const provider = resolveProvider().name;
  const now = nowIso();
  const out = { ...known };

  for (const hook of parsed) {
    insert.run(hook.char, hook.meaning, hook.reading, hook.readingKey, provider, now);
    out[hook.char] = hook;
  }

  return out;
}

/** Characters per mnemonic request. Small keeps each hook thought about. */
const KANJI_BATCH = 6;

export interface KanjiMnemonicRun {
  /** Characters that got hooks in this run. */
  generated: number;
  /** Characters that already had them, from this song or any earlier one. */
  skipped: number;
  errors: string[];
}

/**
 * Writes the hooks for every kanji in a song, ahead of being asked for them.
 *
 * Done at analysis time rather than on hover, so a word opens with its
 * mnemonics already there instead of a model request starting when the mouse
 * arrives. The cache is per character and global, so a song shares the work of
 * every song imported before it — the second song by the same artist usually
 * needs a fraction of its characters.
 *
 * A failed batch costs its own characters and nothing else: they stay uncached
 * and the hover path picks them up later.
 */
export async function generateSongKanjiMnemonics(
  songId: number,
  opts: {
    force?: boolean;
    onProgress?: (p: AnalyzeProgress) => void;
    completer?: Completer;
  } = {},
): Promise<KanjiMnemonicRun> {
  const provider = resolveProvider();
  if (!opts.completer && provider.name === 'none') {
    throw new LlmUnavailable('no API key configured for the AI Gateway');
  }

  const texts = getDb()
    .query<{ text: string }, [number]>('SELECT text FROM lines WHERE song_id = ? ORDER BY idx')
    .all(songId)
    .map((r) => r.text);

  // First appearance order, so an interrupted run has covered the opening of the
  // song rather than a scattering of it.
  const seen = new Set<string>();
  const facts: KanjiFacts[] = [];
  for (const char of texts.join('')) {
    if (!/[一-龯]/.test(char) || seen.has(char)) continue;
    seen.add(char);
    const info = dict().kanji(char);
    if (info) facts.push({ char, meanings: info.meanings, on: info.on, kun: info.kun });
  }

  const cached = opts.force ? {} : cachedKanjiMnemonics(facts.map((f) => f.char));
  const missing = facts.filter((f) => !cached[f.char]);
  const skipped = facts.length - missing.length;
  if (missing.length === 0) {
    opts.onProgress?.({ done: 0, total: 0 });
    return { generated: 0, skipped, errors: [] };
  }

  const batches: KanjiFacts[][] = [];
  for (let i = 0; i < missing.length; i += KANJI_BATCH) {
    batches.push(missing.slice(i, i + KANJI_BATCH));
  }

  let generated = 0;
  let finished = 0;
  const errors: string[] = [];

  const runBatch = async (batch: KanjiFacts[], batchNo: number): Promise<void> => {
    try {
      const out = await generateKanjiMnemonics(batch, {
        force: opts.force,
        completer: opts.completer,
      });
      generated += batch.filter((f) => out[f.char]).length;
    } catch (err) {
      if (err instanceof LlmUnavailable) throw err;
      const message = err instanceof Error ? err.message : 'mnemonics failed';
      console.error(`[mnemonics] batch ${batchNo + 1}/${batches.length} failed: ${message}`);
      if (!errors.includes(message)) errors.push(message);
    }
  };

  const poolSize = Math.max(1, Math.min(provider.concurrency, batches.length));
  let nextBatch = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const batchNo = nextBatch++;
      if (batchNo >= batches.length) return;
      await runBatch(batches[batchNo], batchNo);
      finished++;
      opts.onProgress?.({
        done: Math.min(finished * KANJI_BATCH, missing.length),
        total: missing.length,
      });
    }
  };

  await Promise.all(Array.from({ length: poolSize }, () => worker()));

  return { generated, skipped, errors };
}

/** Everything the user has already asked about this word, oldest first. */
export function questionHistory(term: string, reading = ''): WordQuestion[] {
  return getDb()
    .query<{ question: string; answer: string; created_at: string }, [string, string]>(
      `SELECT question, answer, created_at FROM word_questions
       WHERE term = ? AND reading = ? ORDER BY created_at, id`,
    )
    .all(term.trim(), reading.trim())
    .map((r) => ({ question: r.question, answer: r.answer, createdAt: r.created_at }));
}

/**
 * Answers a free-form question about a word or phrase, and stores the answer.
 * An identical question is served from the cache rather than paid for twice.
 */
export async function askAboutWord(
  ref: WordRef,
  question: string,
  opts: { completer?: Completer } = {},
): Promise<{ answer: string; cached: boolean }> {
  const { term, reading } = refKey(ref);
  const q = question.trim();
  if (!term) throw new Error('term is required');
  if (!q) throw new Error('question is required');

  const db = getDb();
  const hit = db
    .query<{ answer: string }, [string, string, string]>(
      'SELECT answer FROM word_questions WHERE term = ? AND reading = ? AND question = ?',
    )
    .get(term, reading, q);
  if (hit) return { answer: hit.answer, cached: true };

  const earlier = questionHistory(term, reading)
    .slice(-3)
    .map((h) => `Q: ${h.question}\nA: ${h.answer}`)
    .join('\n\n');

  const send = opts.completer ?? complete;
  const prompt = `A learner is studying 「${term}」 from a song and asks a question about it.

${wordContextLines(ref)}${earlier ? `Earlier in this thread:\n${earlier}\n\n` : ''}Their question: ${q}

Answer it directly, in English, in at most four sentences. Show Japanese examples when they help,
each with its hiragana reading in brackets. If the honest answer is that it depends or that the
usage is irregular, say so rather than inventing a rule.

Return JSON: {"answer": "..."}`;

  let answer: string | undefined;
  try {
    answer = extractJson<{ answer?: string }>(await send(prompt, SYSTEM)).answer?.trim();
  } catch (err) {
    if (err instanceof LlmUnavailable) throw err;
    throw new Error(explainFailure(err, resolveProvider().name));
  }
  if (!answer) throw new Error('The model returned an empty answer. Try rephrasing.');

  db.prepare(
    `INSERT INTO word_questions (term, reading, question, answer, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (term, reading, question) DO UPDATE SET
       answer = excluded.answer, created_at = excluded.created_at`,
  ).run(term, reading, q, answer, nowIso());

  return { answer, cached: false };
}
