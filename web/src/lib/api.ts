import type {
  Card,
  CardKind,
  CardReasonKind,
  ClozeChoice,
  DictEntryLite,
  FuriganaSegment,
  KanjiMnemonic,
  LlmStatus,
  MistakePattern,
  Song,
  SongDetail,
  SongMapRow,
  Stats,
  TroubleCluster,
  WordExample,
  WordQuestion,
} from '../../../shared/types';

export interface ApiError extends Error {
  status: number;
  payload?: unknown;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const payload = text ? safeJson(text) : undefined;

  if (!res.ok) {
    const message =
      (payload as { error?: string })?.error ?? `Request failed with status ${res.status}`;
    const err = new Error(message) as ApiError;
    err.status = res.status;
    err.payload = payload;
    throw err;
  }
  return payload as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 300) };
  }
}

export interface Health {
  ok: boolean;
  dictionary: { available: boolean; entries: number; kanji: number; builtAt: string | null };
  llm: LlmStatus;
  katakanaDeck: number;
  enrollThreshold: number;
}

export interface SearchHit {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  hasSynced: boolean;
  japanese: boolean;
  lineCount: number;
  /** Where the last timestamp falls — how much of the song the lyrics cover. */
  lyricSpanSec: number | null;
  /** Where the first line lands: the tell between a single and an intro-less edit. */
  lyricStartSec: number | null;
  /** The entry's stated length disagrees with its own timings; trust the timings. */
  durationMismatch: boolean;
  /** Other entries with byte-identical lyrics, folded into this one. */
  duplicates: number;
  titleFurigana: { text: string; ruby: string }[] | null;
  titleRomaji: string | null;
  artistFurigana: { text: string; ruby: string }[] | null;
  artistRomaji: string | null;
}

/** What a pasted YouTube link told us about the song it plays. */
export interface YoutubeMeta {
  videoId: string;
  rawTitle: string;
  channel: string;
  durationSec: number | null;
  thumbnailUrl: string | null;
  title: string;
  artist: string;
  /** How the title was split, so the UI can admit when it guessed. */
  guessedBy: 'brackets' | 'separator' | 'channel' | 'ai';
}

export interface LibrarySong extends Song {
  dueCards: number;
  totalCards: number;
}

export interface AnalysisJob {
  songId: number;
  state: 'running' | 'done' | 'failed';
  /** Lines first, then the memory hooks for every kanji in the song. */
  phase: 'lines' | 'kanji';
  done: number;
  total: number;
  linesAnalyzed: number;
  /** Lines whose AI segmentation failed validation and kept the local parse. */
  rejected: number;
  kanjiDone: number;
  kanjiTotal: number;
  error: string | null;
  startedAt: string;
}

export interface ImportResult {
  songId: number;
  lineCount: number;
  verseCount: number;
  wordsEnrolled: number;
  wordsSongOnly: number;
  grammarPoints: number;
  cardsCreated: number;
  /** Present when analysis started automatically on import. */
  analysis: AnalysisJob | null;
  /** Set when the import had to correct the source metadata, e.g. a wrong length. */
  notice?: string | null;
}

export interface SongWord {
  id: number;
  lemma: string;
  reading: string;
  romaji: string;
  furigana: { text: string; ruby: string }[];
  glosses: string[];
  jlpt: number | null;
  priority: number;
  loanword: boolean;
  enrolled: boolean;
  lapses: number;
  /** Every card for this word has been retired, so it reads as fully known. */
  retired: boolean;
  /**
   * The forms this word actually wore in the song. The stored lemma is the
   * dictionary headword, which for kana particles is a kanji the lyrics never
   * show — の is filed under 乃 — so matching a word on the page needs these.
   */
  seenAs: string[];
  /** 0..100 — how well the word is stuck. 0 for anything never answered. */
  mastery: number;
  /** When the word's soonest unretired card comes back. Null when none is due. */
  dueAt: string | null;
}

/** Interval in days each grade button would set, shown on the buttons. */
export interface GradePreview {
  again: number;
  hard: number;
  good: number;
  easy: number;
}

export interface TroubleLine {
  lineId: number;
  songId: number;
  songTitle: string;
  text: string;
  furigana: FuriganaSegment[];
  romaji: string;
  timeMs: number | null;
  lapses: number;
  cardIds: number[];
}

/**
 * Identifies the word an examples or question request is about.
 *
 * `term` and `reading` are the cache key; the rest is context that sharpens the
 * answer — the sense already shown, the line it was tapped in, and the song, so
 * the user's own notes about that song are taken into account.
 */
export interface WordRefInput {
  term: string;
  reading?: string;
  meaning?: string;
  lineText?: string;
  songId?: number;
}

export interface KanjiInfo {
  char: string;
  meanings: string[];
  on: string[];
  kun: string[];
  grade: number | null;
  strokes: number | null;
  /** Memory hooks, once they have been generated for this character. */
  mnemonic?: KanjiMnemonic | null;
}

export const api = {
  health: () => request<Health>('/health'),

  search: (q: string, artist?: string, durationSec?: number | null) =>
    request<{ hits: SearchHit[]; error?: string }>(
      `/search?q=${encodeURIComponent(q)}${artist ? `&artist=${encodeURIComponent(artist)}` : ''}` +
        `${durationSec ? `&duration=${Math.round(durationSec)}` : ''}`,
    ),

  /** Reads a YouTube link and returns lyric candidates ranked against its length. */
  resolveYoutube: (url: string) =>
    request<{ video: YoutubeMeta; hits: SearchHit[]; error?: string }>(
      `/youtube/resolve?url=${encodeURIComponent(url)}`,
    ),

  importFromLrclib: (lrclibId: number, youtubeId?: string, context?: string) =>
    request<ImportResult>('/songs/import', {
      method: 'POST',
      body: JSON.stringify({ lrclibId, youtubeId, context }),
    }),

  importPasted: (input: {
    title: string;
    artist: string;
    album?: string;
    lyrics: string;
    youtubeId?: string;
    context?: string;
  }) => request<ImportResult>('/songs/import', { method: 'POST', body: JSON.stringify(input) }),

  songs: () => request<{ songs: LibrarySong[] }>('/songs'),
  song: (id: number) => request<SongDetail>(`/songs/${id}`),
  deleteSong: (id: number) => request<{ deleted: boolean }>(`/songs/${id}`, { method: 'DELETE' }),

  updateSong: (
    id: number,
    body: {
      youtubeId?: string | null;
      timings?: { idx: number; timeMs: number }[];
      /** Moves every timed line by this many ms, for lyrics timed to another cut. */
      shiftMs?: number;
      titleReading?: string;
      artistReading?: string;
      context?: string | null;
      favourite?: boolean;
    },
  ) => request<{ ok: true }>(`/songs/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),

  songWords: (id: number) => request<{ words: SongWord[] }>(`/songs/${id}/words`),

  /** Starts background analysis and returns the initial job status. */
  analyzeSong: (id: number, force = false) =>
    request<AnalysisJob>(`/songs/${id}/analyze${force ? '?force=1' : ''}`, { method: 'POST' }),

  analysisStatus: (id: number) =>
    request<{
      job: AnalysisJob | null;
      lines: number;
      linesAnalyzed: number;
      linesSegmented: number;
      llm: LlmStatus;
    }>(`/songs/${id}/analysis`),

  saveProgress: (id: number, verseIdx: number, linesDone: number, state: string) =>
    request<{ ok: true }>(`/songs/${id}/progress`, {
      method: 'POST',
      body: JSON.stringify({ verseIdx, linesDone, state }),
    }),

  queue: (opts: { limit?: number; songId?: number; kinds?: CardKind[]; leeches?: boolean; ahead?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (opts.limit) p.set('limit', String(opts.limit));
    if (opts.songId) p.set('songId', String(opts.songId));
    if (opts.kinds?.length) p.set('kinds', opts.kinds.join(','));
    if (opts.leeches) p.set('leeches', '1');
    if (opts.ahead) p.set('ahead', '1');
    return request<{
      cards: Card[];
      cloze: Record<number, ClozeChoice[]>;
      /** Listening: the four meanings on offer, the right one among them. */
      listening: Record<number, string[]>;
      previews: Record<number, GradePreview>;
    }>(`/review/queue?${p}`);
  },

  grade: (cardId: number, quality: number, ms: number, given?: string) =>
    request<{ card: Card; intervalDays: number; dueAt: string; leech: boolean; becameLeech: boolean }>(
      '/review/grade',
      { method: 'POST', body: JSON.stringify({ cardId, quality, ms, given }) },
    ),

  stats: () => request<Stats>('/stats'),

  trouble: (songId?: number) =>
    request<{ lines: TroubleLine[]; leeches: Card[]; clusters: TroubleCluster[] }>(
      `/trouble${songId ? `?songId=${songId}` : ''}`,
    ),

  songMap: () => request<{ songs: SongMapRow[] }>('/songmap'),

  /** Records why a card keeps failing. Changes how the trouble list reads back. */
  cardReason: (cardId: number, reason: CardReasonKind, note?: string) =>
    request<{ ok: true }>(`/cards/${cardId}/reason`, {
      method: 'POST',
      body: JSON.stringify({ reason, note }),
    }),

  /** Coarse playback accounting for "listening this week". Fire-and-forget. */
  logListening: (seconds: number) =>
    request<{ ok: true }>('/listening', {
      method: 'POST',
      body: JSON.stringify({ seconds }),
    }),

  mistakes: () => request<{ patterns: MistakePattern[] }>('/mistakes'),

  mnemonic: (cardId: number) =>
    request<{ mnemonic: string }>(`/cards/${cardId}/mnemonic`, { method: 'POST' }),

  suspend: (cardId: number, suspended: boolean) =>
    request<{ ok: true }>(`/cards/${cardId}/suspend`, {
      method: 'POST',
      body: JSON.stringify({ suspended }),
    }),

  clearLeech: (cardId: number) =>
    request<{ ok: true }>(`/cards/${cardId}/clear-leech`, { method: 'POST' }),

  enrollWord: (wordId: number) =>
    request<{ card: Card }>(`/words/${wordId}/enroll`, { method: 'POST' }),

  /** Cached examples only — never calls a model, so it is safe on panel open. */
  wordExamples: (term: string, reading = '') =>
    request<{ examples: WordExample[] | null }>(
      `/words/examples?term=${encodeURIComponent(term)}&reading=${encodeURIComponent(reading)}`,
    ),

  generateExamples: (input: WordRefInput & { force?: boolean }) =>
    request<{ examples: WordExample[]; cached: boolean }>('/words/examples', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  wordQuestions: (term: string, reading = '') =>
    request<{ questions: WordQuestion[] }>(
      `/words/questions?term=${encodeURIComponent(term)}&reading=${encodeURIComponent(reading)}`,
    ),

  askWord: (input: WordRefInput & { question: string }) =>
    request<{ answer: string; cached: boolean }>('/words/ask', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  lookup: (term: string) =>
    request<{ entries: DictEntryLite[]; kanji: KanjiInfo[] }>(
      `/lookup?term=${encodeURIComponent(term)}`,
    ),

  /** Ruby for Japanese quoted inside prose, keyed by the string that was sent. */
  /** `songId` scopes the readings to that song's own, over the dictionary's. */
  furigana: (texts: string[], songId?: number) =>
    request<{ segments: Record<string, FuriganaSegment[]> }>('/furigana', {
      method: 'POST',
      body: JSON.stringify({ texts, songId }),
    }),

  kanjiMnemonics: (chars: string[]) =>
    request<{ mnemonics: Record<string, KanjiMnemonic> }>('/kanji/mnemonics', {
      method: 'POST',
      body: JSON.stringify({ chars }),
    }),

  seedKana: () => request<{ created: number; total: number }>('/kana/seed', { method: 'POST' }),

  settings: () =>
    request<{ settings: Record<string, string | null>; llm: LlmStatus }>('/settings'),

  saveSettings: (body: Record<string, string | null>) =>
    request<{ ok: true; llm: LlmStatus }>('/settings', { method: 'PUT', body: JSON.stringify(body) }),

  /** The whole user database as a download — an <a href>, not a fetch. */
  backupUrl: '/api/backup',

  /**
   * Replaces the user database with an uploaded backup. The server validates
   * before touching anything, so a wrong file is an error, not data loss.
   */
  restoreBackup: async (file: File): Promise<{ ok: true; version: number; songs: number; cards: number }> => {
    const res = await fetch('/api/backup/restore', { method: 'POST', body: file });
    const text = await res.text();
    const payload = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const message =
        (payload as { error?: string })?.error ?? `Restore failed with status ${res.status}`;
      const err = new Error(message) as ApiError;
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload as { ok: true; version: number; songs: number; cards: number };
  },
};
