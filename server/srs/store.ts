import { getDb, nowIso } from '../db';
import { schedule, LEECH_THRESHOLD, MATURE_DAYS, freshState } from './sm2';
import { lineFurigana } from '../lesson/build';
import { lineRomaji, type AnalyzedToken } from '../nlp/tokenize';
import type { FuriganaSegment } from '../../shared/types';
import type {
  Card,
  CardBack,
  CardFront,
  CardKind,
  MistakeExample,
  MistakePattern,
  SongMapRow,
  Stats,
  TroubleCluster,
} from '../../shared/types';

interface CardRow {
  id: number;
  kind: string;
  song_id: number | null;
  line_id: number | null;
  word_id: number | null;
  grammar_id: number | null;
  front: string;
  back: string;
  song_title: string | null;
  ease: number;
  interval_days: number;
  reps: number;
  lapses: number;
  due_at: string;
  leech: number;
  suspended: number;
  mnemonic: string | null;
}

const SELECT_CARD = `
  SELECT c.id, c.kind, c.song_id, c.line_id, c.word_id, c.grammar_id, c.front, c.back,
         s.title AS song_title,
         r.ease, r.interval_days, r.reps, r.lapses, r.due_at, r.leech, r.suspended,
         m.text AS mnemonic
  FROM cards c
  JOIN srs r ON r.card_id = c.id
  LEFT JOIN songs s ON s.id = c.song_id
  LEFT JOIN mnemonics m ON m.card_id = c.id
`;

function hydrate(row: CardRow): Card {
  const back = JSON.parse(row.back) as CardBack;
  return {
    id: row.id,
    kind: row.kind as CardKind,
    songId: row.song_id,
    songTitle: row.song_title,
    front: JSON.parse(row.front) as CardFront,
    back: { ...back, mnemonic: row.mnemonic },
    srs: {
      ease: row.ease,
      intervalDays: row.interval_days,
      reps: row.reps,
      lapses: row.lapses,
      dueAt: row.due_at,
      leech: row.leech === 1,
      suspended: row.suspended === 1,
    },
  };
}

export interface QueueOptions {
  limit?: number;
  songId?: number;
  kinds?: CardKind[];
  /** Only cards flagged as leeches. */
  leechesOnly?: boolean;
  /** Include cards not yet due, to keep a session going. */
  includeAhead?: boolean;
}

/**
 * Builds a review queue.
 *
 * Ordering puts leeches first (they are the reason the user is here), then the
 * most overdue, then new cards. Interleaving kinds matters for retention, so
 * cards of the same kind are spread out rather than grouped.
 */
export function queue(opts: QueueOptions = {}): Card[] {
  const db = getDb();
  const limit = Math.min(opts.limit ?? 20, 200);
  const now = nowIso();

  const where: string[] = ['r.suspended = 0'];
  const params: (string | number)[] = [];

  if (!opts.includeAhead) {
    where.push('r.due_at <= ?');
    params.push(now);
  }
  if (opts.songId) {
    where.push('c.song_id = ?');
    params.push(opts.songId);
  }
  if (opts.kinds?.length) {
    where.push(`c.kind IN (${opts.kinds.map(() => '?').join(', ')})`);
    params.push(...opts.kinds);
  }
  if (opts.leechesOnly) where.push('r.leech = 1');

  const rows = db
    .query<CardRow, (string | number)[]>(
      `${SELECT_CARD} WHERE ${where.join(' AND ')}
       ORDER BY r.leech DESC, r.reps = 0 ASC, r.due_at ASC
       LIMIT ?`,
    )
    .all(...params, limit * 2);

  return interleave(rows.map(hydrate)).slice(0, limit);
}

/**
 * Spreads card kinds out so the user isn't served ten vocab cards in a row.
 * Preserves the relative order within each kind.
 */
function interleave(cards: Card[]): Card[] {
  const buckets = new Map<string, Card[]>();
  for (const c of cards) {
    const list = buckets.get(c.kind) ?? [];
    list.push(c);
    buckets.set(c.kind, list);
  }
  // Leeches keep their front-of-queue position regardless of kind.
  const leeches = cards.filter((c) => c.srs.leech);
  const leechIds = new Set(leeches.map((c) => c.id));
  for (const [k, list] of buckets) buckets.set(k, list.filter((c) => !leechIds.has(c.id)));

  const out: Card[] = [...leeches];
  let added = true;
  while (added) {
    added = false;
    for (const list of buckets.values()) {
      const next = list.shift();
      if (next) {
        out.push(next);
        added = true;
      }
    }
  }
  return out;
}

export interface GradeResult {
  card: Card;
  intervalDays: number;
  dueAt: string;
  leech: boolean;
  becameLeech: boolean;
}

export function grade(cardId: number, quality: number, ms = 0, given?: string): GradeResult {
  const db = getDb();
  const row = db
    .query<CardRow, [number]>(`${SELECT_CARD} WHERE c.id = ?`)
    .get(cardId);
  if (!row) throw new Error(`card ${cardId} not found`);

  const wasLeech = row.leech === 1;
  const next = schedule(
    {
      ease: row.ease,
      intervalDays: row.interval_days,
      reps: row.reps,
      lapses: row.lapses,
    },
    quality,
  );

  db.transaction(() => {
    db.prepare(
      `UPDATE srs SET ease = ?, interval_days = ?, reps = ?, lapses = ?, due_at = ?,
       last_quality = ?, leech = ? WHERE card_id = ?`,
    ).run(
      next.ease,
      next.intervalDays,
      next.reps,
      next.lapses,
      next.dueAt.toISOString(),
      quality,
      next.leech ? 1 : 0,
      cardId,
    );
    db.prepare('INSERT INTO reviews (card_id, ts, quality, ms, given) VALUES (?, ?, ?, ?, ?)').run(
      cardId,
      nowIso(),
      quality,
      Math.round(ms),
      given ?? null,
    );
  })();

  const updated = db.query<CardRow, [number]>(`${SELECT_CARD} WHERE c.id = ?`).get(cardId)!;
  return {
    card: hydrate(updated),
    intervalDays: next.intervalDays,
    dueAt: next.dueAt.toISOString(),
    leech: next.leech,
    becameLeech: next.leech && !wasLeech,
  };
}

export function stats(): Stats {
  const db = getDb();
  const now = nowIso();
  const one = <T>(sql: string, ...params: (string | number)[]) =>
    db.query<T, (string | number)[]>(sql).get(...params);

  const total = one<{ n: number }>('SELECT COUNT(*) AS n FROM cards')?.n ?? 0;
  const due =
    one<{ n: number }>(
      'SELECT COUNT(*) AS n FROM srs WHERE suspended = 0 AND due_at <= ?',
      now,
    )?.n ?? 0;
  const fresh = one<{ n: number }>('SELECT COUNT(*) AS n FROM srs WHERE reps = 0')?.n ?? 0;
  const learned = one<{ n: number }>('SELECT COUNT(*) AS n FROM srs WHERE reps > 0')?.n ?? 0;
  const mature =
    one<{ n: number }>('SELECT COUNT(*) AS n FROM srs WHERE interval_days >= ?', MATURE_DAYS)?.n ??
    0;
  const leeches = one<{ n: number }>('SELECT COUNT(*) AS n FROM srs WHERE leech = 1')?.n ?? 0;
  const songs = one<{ n: number }>('SELECT COUNT(*) AS n FROM songs')?.n ?? 0;

  const todayStart = startOfLocalDay(new Date()).toISOString();
  const reviewsToday =
    one<{ n: number }>('SELECT COUNT(*) AS n FROM reviews WHERE ts >= ?', todayStart)?.n ?? 0;

  const weekAgo = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const acc = one<{ good: number; total: number }>(
    `SELECT SUM(CASE WHEN quality >= 3 THEN 1 ELSE 0 END) AS good, COUNT(*) AS total
     FROM reviews WHERE ts >= ?`,
    weekAgo,
  );
  const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const accPrev = one<{ good: number; total: number }>(
    `SELECT SUM(CASE WHEN quality >= 3 THEN 1 ELSE 0 END) AS good, COUNT(*) AS total
     FROM reviews WHERE ts >= ? AND ts < ?`,
    twoWeeksAgo,
    weekAgo,
  );

  // "Words you know" counts words, not cards: one word can carry a vocab, a
  // cloze and a listening card, and the user thinks of that as one word.
  const wordsKnown =
    one<{ n: number }>(
      `SELECT COUNT(DISTINCT c.word_id) AS n
       FROM cards c JOIN srs r ON r.card_id = c.id
       WHERE c.word_id IS NOT NULL AND r.reps > 0`,
    )?.n ?? 0;

  return {
    totalCards: total,
    dueNow: due,
    newCards: fresh,
    learned,
    mature,
    leeches,
    streakDays: streak(),
    reviewsToday,
    accuracy7d: acc && acc.total > 0 ? acc.good / acc.total : null,
    accuracyPrev7d: accPrev && accPrev.total > 0 ? accPrev.good / accPrev.total : null,
    songs,
    wordsKnown,
    dueByKind: dueByKind(),
    dailyReviews: reviewsPerDay(7),
    weeklyReviews: reviewsPerWeek(52),
    dailyListenSec: listeningPerDay(7),
  };
}

/** Cards due right now, split by kind. Today's setlist is built from this. */
function dueByKind(): Partial<Record<CardKind, number>> {
  const rows = getDb()
    .query<{ kind: string; n: number }, [string]>(
      `SELECT c.kind, COUNT(*) AS n
       FROM cards c JOIN srs r ON r.card_id = c.id
       WHERE r.suspended = 0 AND r.due_at <= ?
       GROUP BY c.kind`,
    )
    .all(nowIso());
  const out: Partial<Record<CardKind, number>> = {};
  for (const r of rows) out[r.kind as CardKind] = r.n;
  return out;
}

/**
 * Reviews per local day, oldest first, ending today.
 *
 * Bucketed in JavaScript for the same reason `streak` is: SQLite's `localtime`
 * and the JS `TZ` can disagree, and a chart that files a review under the wrong
 * day is worse than no chart.
 */
function reviewsPerDay(days: number): number[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
  const rows = db
    .query<{ ts: string }, [string]>('SELECT ts FROM reviews WHERE ts >= ?')
    .all(cutoff);

  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = localDayKey(new Date(r.ts));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const out: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = localNoon(new Date(Date.now() - i * 86_400_000));
    out.push(counts.get(localDayKey(day)) ?? 0);
  }
  return out;
}

/** Reviews per 7-day bucket, oldest first, ending with the week containing today. */
function reviewsPerWeek(weeks: number): number[] {
  const db = getDb();
  const cutoff = new Date(Date.now() - weeks * 7 * 86_400_000).toISOString();
  const rows = db
    .query<{ ts: string }, [string]>('SELECT ts FROM reviews WHERE ts >= ?')
    .all(cutoff);

  const out = new Array<number>(weeks).fill(0);
  const now = Date.now();
  for (const r of rows) {
    const age = now - new Date(r.ts).getTime();
    const bucket = weeks - 1 - Math.floor(age / (7 * 86_400_000));
    if (bucket >= 0 && bucket < weeks) out[bucket] += 1;
  }
  return out;
}

/** Seconds listened per local day, oldest first, ending today. */
function listeningPerDay(days: number): number[] {
  const db = getDb();
  const rows = db
    .query<{ day: string; seconds: number }, []>('SELECT day, seconds FROM listening')
    .all();
  const byDay = new Map(rows.map((r) => [r.day, r.seconds]));

  const out: number[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = localNoon(new Date(Date.now() - i * 86_400_000));
    out.push(byDay.get(localDayKey(day)) ?? 0);
  }
  return out;
}

/** Adds playback time to today's bucket. Called by the player in coarse ticks. */
export function logListening(seconds: number): void {
  if (!Number.isFinite(seconds) || seconds <= 0) return;
  const day = localDayKey(new Date());
  getDb()
    .prepare(
      `INSERT INTO listening (day, seconds) VALUES (?, ?)
       ON CONFLICT(day) DO UPDATE SET seconds = seconds + excluded.seconds`,
    )
    .run(day, Math.min(Math.round(seconds), 3600));
}

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Local calendar day of an instant, as YYYY-MM-DD. */
function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Midday of the local day containing `d`.
 *
 * Day-to-day walking is anchored at noon, never midnight: subtracting 24 hours
 * from midnight lands in the previous day only when there is no DST shift, and
 * subtracting more to compensate overshoots into the day before that. From
 * noon, a 24-hour step always lands in the adjacent day whatever the offset
 * does.
 */
function localNoon(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12);
}

/**
 * Consecutive days (ending today or yesterday) with at least one review.
 *
 * Day bucketing happens in JavaScript, deliberately. SQLite's `localtime`
 * modifier resolves against the operating system's zone, while JS honours the
 * TZ environment variable — when those differ, timestamps get filed under one
 * date and compared against another, and the streak silently reads zero. Doing
 * both sides in JS keeps one definition of "day".
 */
function streak(): number {
  const db = getDb();
  // 400 days is well past any streak worth counting, and bounds the scan.
  const cutoff = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const rows = db
    .query<{ ts: string }, [string]>('SELECT ts FROM reviews WHERE ts >= ? ORDER BY ts DESC')
    .all(cutoff);
  if (rows.length === 0) return 0;

  const days = new Set(rows.map((r) => localDayKey(new Date(r.ts))));

  const now = new Date();
  let cursor = localNoon(now);
  // A streak stays alive until the day after the last review ends, so a day
  // with no reviews yet falls back to yesterday before giving up.
  if (!days.has(localDayKey(cursor))) {
    cursor = localNoon(new Date(cursor.getTime() - 86_400_000));
    if (!days.has(localDayKey(cursor))) return 0;
  }

  let count = 0;
  while (days.has(localDayKey(cursor))) {
    count++;
    cursor = localNoon(new Date(cursor.getTime() - 86_400_000));
  }
  return count;
}

export interface TroubleLine {
  lineId: number;
  songId: number;
  songTitle: string;
  text: string;
  /** Ruby and romaji for `text`, so the list is readable without kanji. */
  furigana: FuriganaSegment[];
  romaji: string;
  timeMs: number | null;
  lapses: number;
  cardIds: number[];
}

/**
 * Lines the user keeps failing, ranked worst first — the "replay just these"
 * list. A line's pain is the total lapses across every card anchored to it.
 */
export function troubleLines(songId?: number, limit = 20): TroubleLine[] {
  const db = getDb();
  const params: (string | number)[] = [];
  let filter = '';
  if (songId) {
    filter = 'AND c.song_id = ?';
    params.push(songId);
  }
  const rows = db
    .query<
      {
        line_id: number;
        song_id: number;
        song_title: string;
        text: string;
        tokens: string;
        time_ms: number | null;
        lapses: number;
        card_ids: string;
      },
      (string | number)[]
    >(
      `SELECT l.id AS line_id, l.song_id, s.title AS song_title, l.text, l.tokens, l.time_ms,
              SUM(r.lapses) AS lapses, GROUP_CONCAT(c.id) AS card_ids
       FROM cards c
       JOIN srs r ON r.card_id = c.id
       JOIN lines l ON l.id = c.line_id
       JOIN songs s ON s.id = l.song_id
       WHERE r.lapses > 0 ${filter}
       GROUP BY l.id
       ORDER BY lapses DESC, l.song_id, l.idx
       LIMIT ?`,
    )
    .all(...params, limit);

  return rows.map((r) => {
    // The line's tokens are already stored, so its ruby and romaji come for
    // free rather than needing the tokenizer again.
    const tokens = JSON.parse(r.tokens) as AnalyzedToken[];
    return {
      lineId: r.line_id,
      songId: r.song_id,
      songTitle: r.song_title,
      text: r.text,
      furigana: lineFurigana(tokens),
      romaji: lineRomaji(tokens),
      timeMs: r.time_ms,
      lapses: r.lapses,
      cardIds: r.card_ids.split(',').map(Number),
    };
  });
}

/**
 * Aggregates review failures into readable patterns.
 *
 * Three angles, because a learner's errors cluster differently depending on
 * what they're doing: which grammar points fail, which parts of speech fail,
 * and which specific particles get confused in cloze answers.
 */
export function mistakePatterns(): MistakePattern[] {
  const db = getDb();
  const out: MistakePattern[] = [];

  const ids = (concat: string | null): number[] =>
    (concat ?? '')
      .split(',')
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n));

  /** Example lines, with romaji taken from their stored tokens. */
  const lineExamples = (lineIds: number[], limit: number): MistakeExample[] => {
    if (lineIds.length === 0) return [];
    const slice = lineIds.slice(0, limit);
    const rows = db
      .query<{ text: string; tokens: string }, number[]>(
        `SELECT text, tokens FROM lines WHERE id IN (${slice.map(() => '?').join(',')})`,
      )
      .all(...slice);
    return rows.map((r) => ({
      text: r.text,
      romaji: lineRomaji(JSON.parse(r.tokens) as AnalyzedToken[]),
    }));
  };

  /** Example words, with the romaji already stored alongside them. */
  const wordExamples = (wordIds: number[], limit: number): MistakeExample[] => {
    if (wordIds.length === 0) return [];
    const slice = wordIds.slice(0, limit);
    const rows = db
      .query<{ lemma: string; romaji: string }, number[]>(
        `SELECT lemma, romaji FROM words WHERE id IN (${slice.map(() => '?').join(',')})`,
      )
      .all(...slice);
    return rows.map((r) => ({ text: r.lemma, romaji: r.romaji ?? '' }));
  };

  /** Romaji for a word the user typed or picked, when the library knows it. */
  const romajiForLemma = (lemma: string): string =>
    db
      .query<{ romaji: string }, [string]>('SELECT romaji FROM words WHERE lemma = ? LIMIT 1')
      .get(lemma)?.romaji ?? '';

  const grammar = db
    .query<{ pattern: string; n: number; last: string; line_ids: string | null }, []>(
      `SELECT g.pattern, COUNT(*) AS n, MAX(rv.ts) AS last,
              GROUP_CONCAT(DISTINCT l.id) AS line_ids
       FROM reviews rv
       JOIN cards c ON c.id = rv.card_id
       JOIN grammar_items g ON g.id = c.grammar_id
       LEFT JOIN lines l ON l.id = c.line_id
       WHERE rv.quality < 3
       GROUP BY g.id
       HAVING n >= 2
       ORDER BY n DESC LIMIT 10`,
    )
    .all();
  for (const g of grammar) {
    out.push({
      kind: 'grammar',
      detail: `${g.pattern} keeps slipping`,
      count: g.n,
      lastSeen: g.last,
      examples: lineExamples(ids(g.line_ids), 3),
    });
  }

  const pos = db
    .query<{ pos: string; n: number; last: string; word_ids: string | null }, []>(
      `SELECT w.pos, COUNT(*) AS n, MAX(rv.ts) AS last, GROUP_CONCAT(DISTINCT w.id) AS word_ids
       FROM reviews rv
       JOIN cards c ON c.id = rv.card_id
       JOIN words w ON w.id = c.word_id
       WHERE rv.quality < 3 AND w.pos IS NOT NULL
       GROUP BY w.pos
       HAVING n >= 3
       ORDER BY n DESC LIMIT 5`,
    )
    .all();
  for (const p of pos) {
    out.push({
      kind: 'word-type',
      detail: `${posLabel(p.pos)} are your weakest word type`,
      count: p.n,
      lastSeen: p.last,
      examples: wordExamples(ids(p.word_ids), 5),
    });
  }

  const loan = db
    .query<{ n: number; last: string; word_ids: string | null }, []>(
      `SELECT COUNT(*) AS n, MAX(rv.ts) AS last, GROUP_CONCAT(DISTINCT w.id) AS word_ids
       FROM reviews rv
       JOIN cards c ON c.id = rv.card_id
       JOIN words w ON w.id = c.word_id
       WHERE rv.quality < 3 AND w.loanword = 1`,
    )
    .get();
  if (loan && loan.n >= 3) {
    out.push({
      kind: 'katakana',
      detail: 'Katakana loanwords trip you up more than kanji words',
      count: loan.n,
      lastSeen: loan.last,
      examples: wordExamples(ids(loan.word_ids), 5),
    });
  }

  const wrongCloze = db
    .query<{ given: string; answer: string; n: number; last: string }, []>(
      `SELECT rv.given, json_extract(c.back, '$.answer') AS answer, COUNT(*) AS n, MAX(rv.ts) AS last
       FROM reviews rv
       JOIN cards c ON c.id = rv.card_id
       WHERE rv.quality < 3 AND rv.given IS NOT NULL AND rv.given != ''
         AND rv.given != json_extract(c.back, '$.answer')
       GROUP BY rv.given, answer
       HAVING n >= 2
       ORDER BY n DESC LIMIT 8`,
    )
    .all();
  for (const w of wrongCloze) {
    // The two words go in `examples` rather than being embedded in the detail
    // text, so each one can carry its own romaji instead of appearing as bare
    // kanji in a sentence.
    out.push({
      kind: 'confusion',
      detail: 'You pick the first of these where the second belongs',
      count: w.n,
      lastSeen: w.last,
      examples: [
        { text: w.given, romaji: romajiForLemma(w.given) },
        { text: w.answer, romaji: romajiForLemma(w.answer) },
      ],
    });
  }

  return out.sort((a, b) => b.count - a.count);
}

function posLabel(pos: string): string {
  const map: Record<string, string> = {
    名詞: 'Nouns',
    動詞: 'Verbs',
    形容詞: 'Adjectives',
    副詞: 'Adverbs',
    連体詞: 'Pre-noun adjectivals',
    接続詞: 'Conjunctions',
    感動詞: 'Interjections',
  };
  return map[pos] ?? pos;
}

/** Suspends or unsuspends a card. */
export function setSuspended(cardId: number, suspended: boolean): void {
  getDb().prepare('UPDATE srs SET suspended = ? WHERE card_id = ?').run(suspended ? 1 : 0, cardId);
}

/** Clears a card's leech flag and resets its lapse counter after a drill. */
export function clearLeech(cardId: number): void {
  getDb().prepare('UPDATE srs SET leech = 0, lapses = 0 WHERE card_id = ?').run(cardId);
}

export function getCard(cardId: number): Card | null {
  const row = getDb().query<CardRow, [number]>(`${SELECT_CARD} WHERE c.id = ?`).get(cardId);
  return row ? hydrate(row) : null;
}

/** Enrolls a song-only word into the deck on demand. */
export function enrollWord(wordId: number): Card | null {
  const db = getDb();
  const word = db
    .query<
      { id: number; lemma: string; reading: string; romaji: string; furigana: string; glosses: string },
      [number]
    >('SELECT id, lemma, reading, romaji, furigana, glosses FROM words WHERE id = ?')
    .get(wordId);
  if (!word) return null;

  const glosses = JSON.parse(word.glosses) as string[];
  const front: CardFront = {
    prompt: 'What does this word mean?',
    jp: word.lemma,
    furigana: JSON.parse(word.furigana),
    romaji: word.romaji,
  };
  const back: CardBack = {
    answer: glosses.slice(0, 3).join('; '),
    reading: word.reading,
    romaji: word.romaji,
    glosses,
  };
  const songId = db
    .query<{ song_id: number }, [number]>(
      'SELECT song_id FROM word_songs WHERE word_id = ? LIMIT 1',
    )
    .get(wordId)?.song_id;

  const row = db
    .prepare(
      `INSERT INTO cards (kind, song_id, line_id, word_id, grammar_id, dedupe_key, front, back, created_at)
       VALUES ('vocab', ?, NULL, ?, NULL, ?, ?, ?, ?)
       ON CONFLICT (dedupe_key) DO UPDATE SET front = excluded.front
       RETURNING id`,
    )
    .get(
      songId ?? null,
      wordId,
      `vocab:${wordId}`,
      JSON.stringify(front),
      JSON.stringify(back),
      nowIso(),
    ) as { id: number };

  const fresh = freshState();
  db.prepare(
    `INSERT INTO srs (card_id, due_at) VALUES (?, ?) ON CONFLICT (card_id) DO NOTHING`,
  ).run(row.id, fresh.dueAt);

  return getCard(row.id);
}

/**
 * How well a card is stuck, 0..100.
 *
 * The interval is the honest signal — SM-2 only stretches it when the answer
 * keeps coming back — so mastery is the interval measured against the point a
 * card counts as mature, with a ceiling for anything still lapsing so a leech
 * can never read as solid.
 */
export function mastery(srs: {
  intervalDays: number;
  reps: number;
  lapses: number;
  leech: boolean;
}): number {
  if (srs.reps === 0) return 0;
  const raw = Math.min(1, srs.intervalDays / MATURE_DAYS);
  let score = Math.round(raw * 100);
  if (srs.leech) score = Math.min(score, 40);
  else if (srs.lapses > 0) score = Math.min(score, 88);
  return Math.max(1, score);
}

/** What each grade button would do to a card, in days. Shown on the buttons. */
export function previewIntervals(cardId: number): Record<'again' | 'hard' | 'good' | 'easy', number> {
  const row = getDb()
    .query<
      { ease: number; interval_days: number; reps: number; lapses: number },
      [number]
    >('SELECT ease, interval_days, reps, lapses FROM srs WHERE card_id = ?')
    .get(cardId);
  const state = row
    ? { ease: row.ease, intervalDays: row.interval_days, reps: row.reps, lapses: row.lapses }
    : { ease: 2.5, intervalDays: 0, reps: 0, lapses: 0 };

  return {
    again: schedule(state, 0).intervalDays,
    hard: schedule(state, 2).intervalDays,
    good: schedule(state, 4).intervalDays,
    easy: schedule(state, 5).intervalDays,
  };
}

/**
 * The whole library as one grid: every line of every song, shaded by how well
 * its cards are known. This is the song map on Progress.
 */
export function songMap(): SongMapRow[] {
  const db = getDb();
  const songs = db
    .query<
      {
        id: number;
        title: string;
        title_furigana: string | null;
        artist: string;
      },
      []
    >('SELECT id, title, title_furigana, artist FROM songs ORDER BY favourite DESC, created_at DESC')
    .all();

  const lines = db
    .query<
      {
        id: number;
        song_id: number;
        time_ms: number | null;
        interval_days: number | null;
        reps: number | null;
        lapses: number | null;
        leech: number | null;
        cards: number | null;
      },
      []
    >(
      `SELECT l.id, l.song_id, l.time_ms,
              AVG(r.interval_days) AS interval_days,
              SUM(r.reps)          AS reps,
              SUM(r.lapses)        AS lapses,
              MAX(r.leech)         AS leech,
              COUNT(r.card_id)     AS cards
       FROM lines l
       LEFT JOIN cards c ON c.line_id = l.id
       LEFT JOIN srs r   ON r.card_id = c.id
       GROUP BY l.id
       ORDER BY l.song_id, l.idx`,
    )
    .all();

  const bySong = new Map<number, SongMapRow['cells']>();
  for (const l of lines) {
    const cells = bySong.get(l.song_id) ?? [];
    const studied = (l.cards ?? 0) > 0 && (l.reps ?? 0) > 0;
    cells.push({
      lineId: l.id,
      mastery: studied
        ? mastery({
            intervalDays: l.interval_days ?? 0,
            reps: l.reps ?? 0,
            lapses: l.lapses ?? 0,
            leech: l.leech === 1,
          })
        : -1,
      trouble: (l.lapses ?? 0) >= LEECH_THRESHOLD,
      timeMs: l.time_ms,
    });
    bySong.set(l.song_id, cells);
  }

  return songs.map((s) => {
    const cells = bySong.get(s.id) ?? [];
    const known = cells.filter((c) => c.mastery >= 0);
    return {
      songId: s.id,
      title: s.title,
      titleFurigana: s.title_furigana ? (JSON.parse(s.title_furigana) as FuriganaSegment[]) : null,
      artist: s.artist,
      lineCount: cells.length,
      cells,
      percent:
        cells.length === 0
          ? 0
          : Math.round(known.reduce((sum, c) => sum + c.mastery, 0) / cells.length),
    };
  });
}

/** Records why a card keeps failing, in the user's words or from a preset. */
export function setCardReason(cardId: number, reason: string, note?: string): void {
  getDb()
    .prepare(
      `INSERT INTO card_reasons (card_id, reason, note, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (card_id) DO UPDATE SET reason = excluded.reason, note = excluded.note,
       created_at = excluded.created_at`,
    )
    .run(cardId, reason, note ?? null, nowIso());
}

const REASON_LABELS: Record<string, string> = {
  'looks-like-another': 'they look like the same word to me',
  'cannot-hear': 'I cannot hear the difference',
  meaning: 'the meaning will not stick',
  reading: 'the reading will not stick',
};

/**
 * Groups failing cards into named confusable sets.
 *
 * Two cards belong together when they are the same kind and the user has picked
 * the one as the answer to the other in a cloze, or — for kana and short vocab —
 * when their answers are near-identical in length and script. The pair is what
 * the user experiences: シ is only hard *next to* ツ.
 */
export function troubleClusters(limit = 6): TroubleCluster[] {
  const db = getDb();
  const rows = db
    .query<
      {
        id: number;
        kind: string;
        front: string;
        back: string;
        lapses: number;
        reason: string | null;
        note: string | null;
      },
      [number]
    >(
      `SELECT c.id, c.kind, c.front, c.back, r.lapses, x.reason, x.note
       FROM cards c
       JOIN srs r ON r.card_id = c.id
       LEFT JOIN card_reasons x ON x.card_id = c.id
       WHERE r.lapses >= ?
       ORDER BY r.lapses DESC`,
    )
    .all(2);
  if (rows.length === 0) return [];

  // What the user actually typed or picked when they were wrong: the strongest
  // evidence for "these two get confused" the database has.
  const confusions = db
    .query<{ card_id: number; given: string; n: number }, []>(
      `SELECT card_id, given, COUNT(*) AS n
       FROM reviews
       WHERE quality < 3 AND given IS NOT NULL AND given <> ''
       GROUP BY card_id, given
       ORDER BY n DESC`,
    )
    .all();

  // What to *show* for a card. A katakana card's answer is its romaji, and "shi
  // vs tsu" is not the confusion — the glyphs are, so the front wins when it has
  // Japanese on it.
  const answerOf = new Map<number, string>();
  const shownOf = new Map<number, string>();
  for (const r of rows) {
    const answer = (JSON.parse(r.back) as CardBack).answer;
    const front = JSON.parse(r.front) as CardFront;
    answerOf.set(r.id, answer);
    shownOf.set(r.id, front.jp && front.jp.length <= 12 ? front.jp : answer);
  }

  const used = new Set<number>();
  const clusters: TroubleCluster[] = [];

  for (const row of rows) {
    if (used.has(row.id) || clusters.length >= limit) continue;
    const answer = answerOf.get(row.id) ?? '';
    const wrong = confusions.find((c) => c.card_id === row.id)?.given;

    const partner = wrong
      ? rows.find((o) => o.id !== row.id && !used.has(o.id) && answerOf.get(o.id) === wrong)
      : undefined;

    const items = [
      shownOf.get(row.id) ?? answer,
      ...(partner ? [shownOf.get(partner.id) ?? ''] : wrong ? [wrong] : []),
    ]
      .filter(Boolean)
      .slice(0, 2);

    const cardIds = [row.id, ...(partner ? [partner.id] : [])];
    for (const id of cardIds) used.add(id);

    const lapses = row.lapses + (partner?.lapses ?? 0);
    const reason = row.reason ?? partner?.reason ?? null;

    clusters.push({
      key: cardIds.join('-'),
      items,
      label:
        items.length > 1
          ? row.kind === 'kana'
            ? 'The mirrored pair'
            : 'These two swap places'
          : 'Keeps slipping',
      detail:
        items.length > 1
          ? `Failed ${lapses}× between them — you have answered one with the other.`
          : `Failed ${lapses}×.`,
      lapses,
      cardIds,
      reason: reason ? (REASON_LABELS[reason] ?? reason) : null,
    });
  }

  return clusters;
}

export { LEECH_THRESHOLD, MATURE_DAYS };
