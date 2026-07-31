// Shared between server and web. Keep it free of runtime imports.

export type CardKind = 'vocab' | 'grammar' | 'cloze' | 'listening' | 'kana' | 'kanji';

export interface FuriganaSegment {
  /** Chunk of the surface form (may be kanji, kana, or punctuation). */
  text: string;
  /** Reading shown above `text`. Empty when `text` needs no annotation. */
  ruby: string;
}

export interface Token {
  idx: number;
  surface: string;
  /** Reading of the surface form, in hiragana. */
  reading: string;
  romaji: string;
  /** Dictionary form (辞書形). Equal to surface for non-inflecting words. */
  baseForm: string;
  baseReading: string;
  pos: string;
  posDetail: string;
  /** Inflection info from the tokenizer, when the token is conjugated. */
  conjugation?: string;
  furigana: FuriganaSegment[];
  /** True when the token is punctuation/whitespace and should not be studied. */
  filler: boolean;
  entry?: DictEntryLite;
  /** 0..100 — how worth memorising this word is for a learner. */
  priority: number;
}

export interface DictEntryLite {
  id: string;
  headword: string;
  reading: string;
  common: boolean;
  /** Lower is more frequent; null when unranked. */
  freqRank: number | null;
  senses: DictSense[];
  jlpt: number | null;
}

export interface DictSense {
  pos: string[];
  glosses: string[];
  misc: string[];
  info: string[];
}

export interface SongLine {
  id: number;
  idx: number;
  text: string;
  /** Milliseconds into the track, or null when the song has no timings. */
  timeMs: number | null;
  verseIdx: number;
  tokens: Token[];
  analysis?: LineAnalysis;
}

export interface LineAnalysis {
  translation: string | null;
  literal: string | null;
  notes: GrammarNote[];
  provider: string | null;
  /** AI segmentation of the line. Empty when only the local parse exists. */
  chunks: AiChunk[];
}

/**
 * One coloured piece of a line: a word or set expression, with its own reading,
 * meaning and explanation. This is the unit the learner reads and taps.
 */
export interface AiChunk {
  text: string;
  /** Reading in hiragana. Empty for punctuation or latin text. */
  reading: string;
  romaji: string;
  furigana: FuriganaSegment[];
  /**
   * Palette slot for the grammar role, from ROLE_CATEGORIES in shared/roles.ts.
   * -1 = uncoloured, i.e. punctuation or latin text with nothing to study.
   *
   * Renderers derive the slot from `role` instead of reading this, so chunks
   * analysed before hue meant anything still colour correctly; the sign is what
   * they take from here.
   */
  colorIdx: number;
  /** Grammatical role in plain English, e.g. "noun (topic)", "verb, past". */
  role: string;
  /** Short meaning of this piece on its own. */
  meaning: string;
  /** Why it is in this form, what it does in the sentence, slang, contractions. */
  explanation: string;
  /**
   * Whether the reading matches a dictionary entry for this surface.
   * 'verified'   — a JMdict entry has exactly this reading.
   * 'unverified' — the surface is in the dictionary but with other readings.
   * 'unknown'    — not in the dictionary (name, coinage, inflected phrase).
   */
  readingCheck: 'verified' | 'unverified' | 'unknown';
}

export interface GrammarNote {
  /** Stable key so the same pattern across songs maps to one card. */
  key: string;
  pattern: string;
  explanation: string;
  jlpt: number | null;
}

export interface Song {
  id: number;
  title: string;
  artist: string;
  /** Ruby for the title, when it contains Japanese script. */
  titleFurigana: FuriganaSegment[] | null;
  titleRomaji: string | null;
  artistFurigana: FuriganaSegment[] | null;
  artistRomaji: string | null;
  album: string | null;
  source: 'lrclib' | 'paste';
  /**
   * Anything the user pasted to help the model: an interview, a fan reading,
   * the plot of the anime it belongs to. Null when they gave none.
   */
  context: string | null;
  youtubeId: string | null;
  durationMs: number | null;
  /** Favourited songs lead the setlist and sort first in the library. */
  favourite: boolean;
  synced: boolean;
  analyzed: boolean;
  createdAt: string;
  lineCount: number;
  verseCount: number;
}

export interface SongDetail extends Song {
  lines: SongLine[];
  progress: VerseProgress[];
}

export interface VerseProgress {
  verseIdx: number;
  state: 'new' | 'in_progress' | 'done';
  linesDone: number;
  lineCount: number;
}

export interface Card {
  id: number;
  kind: CardKind;
  songId: number | null;
  songTitle: string | null;
  front: CardFront;
  back: CardBack;
  srs: SrsState;
}

export interface CardFront {
  prompt: string;
  /** Japanese text to display with furigana, when applicable. */
  jp?: string;
  furigana?: FuriganaSegment[];
  romaji?: string;
  /** Cloze: the line with the target replaced by a blank. */
  blankIdx?: number;
  audio?: { youtubeId: string; startMs: number; endMs: number } | null;
  choices?: string[];
}

/**
 * One multiple-choice option on a cloze card.
 *
 * Carries its own reading: the options are Japanese the user has to read in
 * order to answer, so bare kanji makes the card unanswerable rather than harder.
 */
export interface ClozeChoice {
  text: string;
  furigana: FuriganaSegment[];
  romaji: string;
}

export interface CardBack {
  answer: string;
  reading?: string;
  romaji?: string;
  /** Ruby for `answer`. Required whenever the answer contains kanji. */
  furigana?: FuriganaSegment[];
  glosses?: string[];
  note?: string;
  lineTranslation?: string;
  mnemonic?: string | null;
}

export interface SrsState {
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  dueAt: string;
  leech: boolean;
  suspended: boolean;
}

export interface ReviewGrade {
  cardId: number;
  /** SM-2 quality 0..5. <3 counts as a lapse. */
  quality: number;
  ms: number;
}

export interface Stats {
  totalCards: number;
  dueNow: number;
  newCards: number;
  learned: number;
  mature: number;
  leeches: number;
  streakDays: number;
  reviewsToday: number;
  accuracy7d: number | null;
  /** Accuracy over the seven days before that, for a week-on-week comparison. */
  accuracyPrev7d: number | null;
  songs: number;
  /** Distinct vocabulary words answered correctly at least once. */
  wordsKnown: number;
  /** How many cards of each kind are due right now. Drives Today's setlist. */
  dueByKind: Partial<Record<CardKind, number>>;
  /** Reviews per day for the last seven local days, oldest first. */
  dailyReviews: number[];
  /** Reviews per week for the last 52 weeks, oldest first. */
  weeklyReviews: number[];
  /** Seconds of song playback logged this week, one entry per day, oldest first. */
  dailyListenSec: number[];
}

/**
 * One song's line-by-line knowledge, for the song map on Progress.
 *
 * `cells` is one entry per line in order: -1 when nothing anchored to the line
 * has been studied, otherwise a 0..100 mastery, and `trouble` marks the lines
 * that keep failing whatever their mastery says.
 */
export interface SongMapRow {
  songId: number;
  title: string;
  titleFurigana: FuriganaSegment[] | null;
  artist: string;
  lineCount: number;
  cells: { lineId: number; mastery: number; trouble: boolean; timeMs: number | null }[];
  /** Mean mastery across the whole song, 0..100. */
  percent: number;
}

/** A named pair of things the user keeps confusing, with a one-tap drill. */
export interface TroubleCluster {
  key: string;
  /** The confusable items themselves, e.g. ["シ", "ツ"]. */
  items: string[];
  label: string;
  detail: string;
  lapses: number;
  cardIds: number[];
  /** What the user said was going wrong, when they told us. */
  reason: string | null;
}

/** Preset answers to "what's going wrong?", shown after a card keeps lapsing. */
export type CardReasonKind =
  | 'looks-like-another'
  | 'cannot-hear'
  | 'meaning'
  | 'reading'
  | 'other';

export interface MistakePattern {
  kind: string;
  detail: string;
  count: number;
  lastSeen: string;
  examples: MistakeExample[];
}

/** An example on the mistakes report, with its reading attached. */
export interface MistakeExample {
  text: string;
  romaji: string;
}

/**
 * One generated usage example for a word or phrase.
 *
 * Furigana and romaji are built locally from the sentence, the same way lyric
 * lines are, so an example is readable by someone who reads no kanji.
 */
export interface WordExample {
  jp: string;
  furigana: FuriganaSegment[];
  romaji: string;
  english: string;
  /** Register, nuance, or why this form was used. Optional. */
  note: string | null;
}

/**
 * Memory hooks for one kanji, in the WaniKani mould: one for what it means, one
 * for how it sounds. Generated once per character and cached, since 言 is the
 * same 言 in every word it appears in.
 */
export interface KanjiMnemonic {
  char: string;
  /** Hook for the meaning, built from the shape or the parts. */
  meaning: string;
  /** Hook for the reading, built around its actual sound. */
  reading: string;
  /** The reading the hook uses, so it is never shown as explaining all of them. */
  readingKey: string;
}

/** A question the user asked about a word, and the answer, both cached. */
export interface WordQuestion {
  question: string;
  answer: string;
  createdAt: string;
}

export interface LlmStatus {
  provider: 'gateway' | 'none';
  available: boolean;
  detail: string;
}
