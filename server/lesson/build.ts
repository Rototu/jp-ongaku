import type { Database } from 'bun:sqlite';
import type { AnalyzedToken } from '../nlp/tokenize';
import { tokenizeLine, lineRomaji, lineKana } from '../nlp/tokenize';
import { shouldEnroll } from '../nlp/priority';
import { isLoanword, toRomaji } from '../nlp/kana';
import { glossesFor, isNegated } from '../nlp/polarity';
import { alignFurigana } from '../nlp/furigana';
import { getDb, nowIso } from '../db';
import { freshState } from '../srs/sm2';
import type { ParsedLine } from '../lyrics/lrc';
import { groupVerses } from '../lyrics/lrc';
import { annotate } from './titles';
import type { CardBack, CardFront, FuriganaSegment } from '../../shared/types';

/**
 * Turns raw lyric lines into a stored lesson: tokenised lines, deduplicated
 * vocabulary, grammar items, and SRS cards.
 *
 * Everything is keyed so re-importing the same song is idempotent — you never
 * end up with two cards for 星 because two songs used it.
 */

export interface BuildInput {
  title: string;
  artist: string;
  album?: string | null;
  source: 'lrclib' | 'paste';
  lrclibId?: number | null;
  durationMs?: number | null;
  youtubeId?: string | null;
  /** Free-text background the user pasted, handed to the model at analysis. */
  context?: string | null;
  lines: ParsedLine[];
  /** Original text, used for blank-line verse detection. */
  raw: string;
}

export interface BuildResult {
  songId: number;
  lineCount: number;
  verseCount: number;
  wordsEnrolled: number;
  wordsSongOnly: number;
  grammarPoints: number;
  cardsCreated: number;
  /** Cards this pass found the song no longer has any use for. */
  cardsPruned: number;
}

/** Max cloze cards per line — more than this and one song floods the queue. */
const CLOZE_PER_LINE = 1;

/** Placeholder shown in place of the word a cloze card is asking for. */
export const CLOZE_BLANK = '＿＿＿';

/**
 * Ruby for a whole line, built by concatenating its tokens' aligned furigana.
 *
 * Pass `blankIdx` to replace one token with the cloze placeholder; the blank
 * carries no ruby, since a reading above the gap would give away the answer.
 */
export function lineFurigana(
  tokens: AnalyzedToken[],
  blankIdx?: number,
): FuriganaSegment[] {
  const out: FuriganaSegment[] = [];
  tokens.forEach((token, i) => {
    const segments =
      i === blankIdx ? [{ text: CLOZE_BLANK, ruby: '' }] : token.furigana;
    for (const seg of segments) {
      const last = out[out.length - 1];
      // Merge runs with no ruby so the markup stays compact.
      if (last && !last.ruby && !seg.ruby) last.text += seg.text;
      else out.push({ ...seg });
    }
  });
  return out;
}

/**
 * The line under a card's answer explaining the form the lyrics used.
 *
 * Two things belong here, and both are about the gap between the dictionary and
 * the song: the surface the word wore on the line, and — when the surface is
 * negative — the fact that its meaning is flipped. Without the second, a learner
 * reading 見えない below "to be seen" has been told the opposite of the lyric.
 */
function noteForSurface(token: AnalyzedToken, headword?: string): string | undefined {
  const parts: string[] = [];
  if (headword && token.surface !== headword) {
    parts.push(`Seen in the song as ${token.surface} (${token.romaji})`);
  }
  if (isNegated(token)) {
    const lemma = token.entry?.headword ?? token.baseForm;
    parts.push(`Negative form of ${lemma} — the 〜ない tail flips the meaning`);
  }
  return parts.length > 0 ? parts.join('. ') : undefined;
}

export async function buildLesson(input: BuildInput): Promise<BuildResult> {
  const db = getDb();
  const now = nowIso();

  const verses = groupVerses(input.lines, input.raw);

  // Tokenise before opening the write transaction: it is async and the
  // tokenizer is shared, so holding a transaction across it would block.
  const tokenized: AnalyzedToken[][] = [];
  for (const line of input.lines) {
    tokenized.push(await tokenizeLine(line.text));
  }

  const titleAnn = await annotate(input.title);
  const artistAnn = await annotate(input.artist);

  const existing = db
    .query<{ id: number }, [string, string]>('SELECT id FROM songs WHERE title = ? AND artist = ?')
    .get(input.title, input.artist);

  let songId: number;
  let stats: Omit<BuildResult, 'songId' | 'lineCount' | 'verseCount'> = {
    wordsEnrolled: 0,
    wordsSongOnly: 0,
    grammarPoints: 0,
    cardsCreated: 0,
    cardsPruned: 0,
  };

  db.transaction(() => {
    if (existing) {
      songId = existing.id;
      db.prepare(
        `UPDATE songs SET album = ?, source = ?, lrclib_id = COALESCE(?, lrclib_id),
         duration_ms = COALESCE(?, duration_ms), youtube_id = COALESCE(?, youtube_id), synced = ?,
         title_furigana = ?, title_romaji = ?, artist_furigana = ?, artist_romaji = ?,
         context = COALESCE(?, context)
         WHERE id = ?`,
      ).run(
        input.album ?? null,
        input.source,
        input.lrclibId ?? null,
        input.durationMs ?? null,
        input.youtubeId ?? null,
        input.lines.some((l) => l.timeMs !== null) ? 1 : 0,
        titleAnn ? JSON.stringify(titleAnn.furigana) : null,
        titleAnn ? titleAnn.romaji : '',
        artistAnn ? JSON.stringify(artistAnn.furigana) : null,
        artistAnn ? artistAnn.romaji : '',
        input.context?.trim() || null,
        songId,
      );
      // Lines are updated in place rather than deleted and re-inserted.
      // Deleting them would cascade to cards and from there to reviews,
      // throwing away the user's history the moment they re-import a song to
      // pick up better or newly synced lyrics.
      db.prepare('DELETE FROM lines WHERE song_id = ? AND idx >= ?').run(
        songId,
        input.lines.length,
      );
    } else {
      const res = db
        .prepare(
          `INSERT INTO songs (title, artist, album, source, lrclib_id, youtube_id, duration_ms, synced, analyzed, created_at,
                              title_furigana, title_romaji, artist_furigana, artist_romaji, context)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.title,
          input.artist,
          input.album ?? null,
          input.source,
          input.lrclibId ?? null,
          input.youtubeId ?? null,
          input.durationMs ?? null,
          input.lines.some((l) => l.timeMs !== null) ? 1 : 0,
          now,
          titleAnn ? JSON.stringify(titleAnn.furigana) : null,
          titleAnn ? titleAnn.romaji : '',
          artistAnn ? JSON.stringify(artistAnn.furigana) : null,
          artistAnn ? artistAnn.romaji : '',
          input.context?.trim() || null,
        );
      songId = Number(res.lastInsertRowid);
    }

    const insLine = db.prepare(
      `INSERT INTO lines (song_id, idx, text, time_ms, verse_idx, tokens)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (song_id, idx) DO UPDATE SET
         text      = excluded.text,
         time_ms   = COALESCE(excluded.time_ms, time_ms),
         verse_idx = excluded.verse_idx,
         tokens    = excluded.tokens
       RETURNING id`,
    );

    const lineIds: number[] = [];
    input.lines.forEach((line, i) => {
      const row = insLine.get(
        songId,
        i,
        line.text,
        line.timeMs,
        verses[i] ?? 0,
        JSON.stringify(tokenized[i]),
      ) as { id: number };
      lineIds.push(row.id);
    });

    for (const verse of new Set(verses)) {
      db.prepare(
        `INSERT INTO verse_progress (song_id, verse_idx, state, lines_done, updated_at)
         VALUES (?, ?, 'new', 0, ?)
         ON CONFLICT (song_id, verse_idx) DO NOTHING`,
      ).run(songId, verse, now);
    }

    const built = materialize(db, songId, lineIds, tokenized, input, now);
    // Only an existing song can have leftovers, and only its own rows are
    // considered — a first import has nothing to prune.
    const pruned = existing
      ? pruneStale(db, songId, built)
      : { cardsPruned: 0, linksPruned: 0 };

    stats = {
      wordsEnrolled: built.wordsEnrolled,
      wordsSongOnly: built.wordsSongOnly,
      grammarPoints: built.grammarPoints,
      cardsCreated: built.cardsCreated,
      cardsPruned: pruned.cardsPruned,
    };
  })();

  return {
    songId: songId!,
    lineCount: input.lines.length,
    verseCount: new Set(verses).size,
    ...stats,
  };
}

/**
 * Rebuilds a song's lesson from the lyrics already stored for it.
 *
 * The same path as an import, minus the network: lines come from the database, so
 * a fix to tokenising, the dictionary or a card's wording reaches songs the user
 * imported before the fix existed. Card ids and SRS state survive, since every
 * write is the same upsert an import uses.
 */
export async function rebuildLesson(songId: number): Promise<BuildResult | null> {
  const db = getDb();
  const song = db
    .query<
      {
        id: number;
        title: string;
        artist: string;
        album: string | null;
        source: string;
        lrclib_id: number | null;
        duration_ms: number | null;
        youtube_id: string | null;
        context: string | null;
      },
      [number]
    >(
      `SELECT id, title, artist, album, source, lrclib_id, duration_ms, youtube_id, context
       FROM songs WHERE id = ?`,
    )
    .get(songId);
  if (!song) return null;

  const lines = db
    .query<{ text: string; time_ms: number | null; verse_idx: number }, [number]>(
      'SELECT text, time_ms, verse_idx FROM lines WHERE song_id = ? ORDER BY idx ASC',
    )
    .all(songId);
  if (lines.length === 0) return null;

  // Verses are regrouped from the stored verse indices rather than from blank
  // lines: the raw lyrics are not kept, and the recorded grouping is the one the
  // user has been studying against.
  const raw = rawFromVerses(lines);

  return buildLesson({
    title: song.title,
    artist: song.artist,
    album: song.album,
    source: song.source === 'lrclib' ? 'lrclib' : 'paste',
    lrclibId: song.lrclib_id,
    durationMs: song.duration_ms,
    youtubeId: song.youtube_id,
    context: song.context,
    lines: lines.map((l) => ({ text: l.text, timeMs: l.time_ms })),
    raw,
  });
}

/** Reconstructs the blank-line layout that produced a set of verse indices. */
function rawFromVerses(lines: { text: string; verse_idx: number }[]): string {
  const out: string[] = [];
  let current = lines[0]?.verse_idx ?? 0;
  for (const line of lines) {
    if (line.verse_idx !== current) {
      out.push('');
      current = line.verse_idx;
    }
    out.push(line.text);
  }
  return out.join('\n');
}

function materialize(
  db: Database,
  songId: number,
  lineIds: number[],
  tokenized: AnalyzedToken[][],
  input: BuildInput,
  now: string,
) {
  let wordsEnrolled = 0;
  let wordsSongOnly = 0;
  let grammarPoints = 0;
  let cardsCreated = 0;
  // Every dedupe key and word link this pass produced. A rebuild uses them to
  // spot what the song no longer has any use for — a vocab card for 菊
  // "chrysanthemum", built when きいて resolved to the wrong entry, otherwise
  // keeps coming up forever.
  const keys = new Set<string>();
  const wordLinks = new Set<string>();

  const upsertWord = db.prepare(
    `INSERT INTO words (lemma, reading, romaji, furigana, glosses, pos, jlpt, common, priority, loanword, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (lemma, reading) DO UPDATE SET
       priority = MAX(priority, excluded.priority),
       glosses  = CASE WHEN length(excluded.glosses) > length(glosses) THEN excluded.glosses ELSE glosses END
     RETURNING id`,
  );
  // The surface goes in on conflict too: a re-import of an existing lesson is the
  // path by which older links pick the column up.
  const linkWord = db.prepare(
    `INSERT INTO word_songs (word_id, song_id, line_id, seen_as) VALUES (?, ?, ?, ?)
     ON CONFLICT (word_id, line_id) DO UPDATE SET seen_as = excluded.seen_as`,
  );
  const upsertGrammar = db.prepare(
    `INSERT INTO grammar_items (key, pattern, explanation, jlpt, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET explanation = excluded.explanation
     RETURNING id`,
  );

  const insCard = db.prepare(
    // The links are refreshed on conflict as well as the faces. A rebuild can
    // resolve a word differently — きいて used to land on 菊 and now lands on
    // 聞く — and a card left pointing at the old word row would be deleted with
    // it while its key was still in use.
    `INSERT INTO cards (kind, song_id, line_id, word_id, grammar_id, dedupe_key, front, back, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) DO UPDATE SET
       front      = excluded.front,
       back       = excluded.back,
       line_id    = excluded.line_id,
       word_id    = excluded.word_id,
       grammar_id = excluded.grammar_id
     RETURNING id`,
  );
  const insSrs = db.prepare(
    `INSERT INTO srs (card_id, ease, interval_days, reps, lapses, due_at, leech, suspended)
     VALUES (?, 2.5, 0, 0, 0, ?, 0, 0)
     ON CONFLICT (card_id) DO NOTHING`,
  );

  const addCard = (
    kind: string,
    dedupeKey: string,
    front: CardFront,
    back: CardBack,
    refs: { lineId?: number; wordId?: number; grammarId?: number },
  ) => {
    const row = insCard.get(
      kind,
      songId,
      refs.lineId ?? null,
      refs.wordId ?? null,
      refs.grammarId ?? null,
      dedupeKey,
      JSON.stringify(front),
      JSON.stringify(back),
      now,
    ) as { id: number } | null;
    keys.add(dedupeKey);
    if (!row) return;
    const fresh = freshState();
    const before = db
      .query<{ n: number }, [number]>('SELECT COUNT(*) AS n FROM srs WHERE card_id = ?')
      .get(row.id);
    insSrs.run(row.id, fresh.dueAt);
    if ((before?.n ?? 0) === 0) cardsCreated++;
  };

  tokenized.forEach((tokens, lineIdx) => {
    const lineId = lineIds[lineIdx];
    const lineText = input.lines[lineIdx].text;
    const romaji = lineRomaji(tokens);

    // --- vocabulary ---------------------------------------------------------
    const studyable = tokens.filter((t) => !t.filler && t.entry && t.priority > 0);
    const enrolledHere: { token: AnalyzedToken; wordId: number }[] = [];

    for (const token of studyable) {
      const entry = token.entry!;
      const glosses = entry.senses.flatMap((s) => s.glosses).slice(0, 6);
      if (glosses.length === 0) continue;

      // Ruby and romaji must describe the *dictionary form* stored alongside
      // them. The token's own furigana belongs to the inflected surface
      // (探している), so reusing it for the lemma (探す) puts the wrong reading
      // above the word everywhere the lemma is shown.
      const lemmaFurigana = alignFurigana(entry.headword, entry.reading);
      const lemmaRomaji = toRomaji(entry.reading);

      const row = upsertWord.get(
        entry.headword,
        entry.reading,
        lemmaRomaji,
        JSON.stringify(lemmaFurigana),
        JSON.stringify(glosses),
        token.pos,
        entry.jlpt,
        entry.common ? 1 : 0,
        token.priority,
        isLoanword(token.surface) ? 1 : 0,
        now,
      ) as { id: number };

      linkWord.run(row.id, songId, lineId, token.surface);
      wordLinks.add(`${row.id}:${lineId}`);

      if (shouldEnroll(token.priority)) {
        enrolledHere.push({ token, wordId: row.id });
        addCard(
          'vocab',
          `vocab:${row.id}`,
          {
            prompt: 'How do you read this word?',
            jp: entry.headword,
            furigana: lemmaFurigana,
            romaji: lemmaRomaji,
          },
          {
            answer: glosses.slice(0, 3).join('; '),
            reading: entry.reading,
            romaji: lemmaRomaji,
            glosses,
            // How it appeared in the song, with its own reading, since the
            // inflected form is what the user will meet again.
            note: noteForSurface(token, entry.headword),
          },
          { wordId: row.id, lineId },
        );
        wordsEnrolled++;
      } else {
        wordsSongOnly++;
      }
    }

    // --- grammar ------------------------------------------------------------
    for (const note of tokens.flatMap((t) => t.grammar)) {
      const g = upsertGrammar.get(
        note.key,
        note.pattern,
        note.explanation,
        note.jlpt,
        now,
      ) as { id: number };
      addCard(
        'grammar',
        // Scoped to the song: the front of a grammar card is one of *this*
        // song's lines. A key shared across songs meant the second import
        // overwrote the example with a line the card does not belong to, so
        // studying song A served a lyric from song B.
        `grammar:${songId}:${note.key}`,
        {
          prompt: `What does ${note.pattern} do?`,
          jp: lineText,
          // The example line is Japanese the user has to read, so it needs ruby
          // like everything else — a bare-kanji example teaches nothing.
          furigana: lineFurigana(tokens),
          romaji,
        },
        {
          answer: note.pattern,
          note: note.explanation,
        },
        { grammarId: g.id, lineId },
      );
      grammarPoints++;
    }

    // --- cloze --------------------------------------------------------------
    const clozeTargets = [...enrolledHere]
      .sort((a, b) => b.token.priority - a.token.priority)
      .slice(0, CLOZE_PER_LINE);

    for (const { token, wordId } of clozeTargets) {
      const blanked = tokens
        .map((t, i) => (i === token.idx ? '＿＿＿' : t.surface))
        .join('');
      addCard(
        'cloze',
        `cloze:${lineId}:${token.idx}`,
        {
          prompt: 'Which word fills the blank?',
          jp: blanked,
          // Ruby on the surrounding words, with the blank left unannotated —
          // otherwise the reading above the gap gives the answer away.
          furigana: lineFurigana(tokens, token.idx),
          romaji: tokens
            .map((t, i) => (i === token.idx ? '___' : t.filler ? t.surface : t.romaji))
            .join(' ')
            .replace(/\s{2,}/g, ' ')
            .trim(),
          blankIdx: token.idx,
          choices: [],
        },
        {
          answer: token.surface,
          reading: token.reading,
          romaji: token.romaji,
          furigana: token.furigana,
          // The answer here is the inflected surface, so the meaning has to
          // follow it: 見えない is not "to be visible".
          glosses: glossesFor(token),
          note: noteForSurface(token),
        },
        { wordId, lineId },
      );
    }

    // --- listening ----------------------------------------------------------
    // Only meaningful with both a timing and a video to play.
    const timeMs = input.lines[lineIdx].timeMs;
    const nextTime = input.lines[lineIdx + 1]?.timeMs ?? null;
    if (input.youtubeId && timeMs !== null) {
      const endMs = nextTime === null ? timeMs + 6000 : nextTime;
      addCard(
        'listening',
        `listening:${lineId}`,
        {
          // The question itself — four meanings to choose between — is assembled
          // in the review queue, since the translations it needs arrive with the
          // analysis pass rather than with the lesson.
          prompt: 'What is this line saying?',
          audio: { youtubeId: input.youtubeId, startMs: timeMs, endMs },
        },
        {
          answer: lineText,
          furigana: lineFurigana(tokens),
          reading: lineKana(tokens),
          romaji,
        },
        { lineId },
      );
    }
  });

  return { wordsEnrolled, wordsSongOnly, grammarPoints, cardsCreated, keys, wordLinks };
}

/**
 * Removes what a fresh pass over the same lyrics no longer produces.
 *
 * A lesson is upserted, never replaced, so the user's review history survives a
 * re-import. The cost is that anything the old pass got wrong stays: when a
 * better dictionary lookup moved きいて off 菊 "chrysanthemum", the 菊 card and
 * its link to the song remained, and the queue kept asking about a flower that is
 * not in the song. Only rows this song owns are touched, and a word is dropped
 * solely when no song links it any more — deleting one takes its cards, and with
 * them their history, so the condition has to be exact.
 */
function pruneStale(
  db: Database,
  songId: number,
  produced: { keys: Set<string>; wordLinks: Set<string> },
): { cardsPruned: number; linksPruned: number } {
  const countCards = db.query<{ n: number }, [number]>(
    'SELECT COUNT(*) AS n FROM cards WHERE song_id = ?',
  );
  const before = countCards.get(songId)?.n ?? 0;

  // Vocabulary cards are exempt: a word below the enrolment bar gets no card
  // here, and the user can add one by hand from the song page. Judging those by
  // "did this pass produce the key" would delete every card they chose to study.
  // Their cleanup runs through the word links below instead.
  const cards = db
    .query<{ id: number; dedupe_key: string }, [number]>(
      `SELECT id, dedupe_key FROM cards
       WHERE song_id = ? AND kind IN ('cloze', 'grammar', 'listening')`,
    )
    .all(songId);
  const stale = cards.filter((c) => !produced.keys.has(c.dedupe_key));

  const delCard = db.prepare('DELETE FROM cards WHERE id = ?');
  for (const card of stale) delCard.run(card.id);

  const links = db
    .query<{ word_id: number; line_id: number }, [number]>(
      'SELECT word_id, line_id FROM word_songs WHERE song_id = ?',
    )
    .all(songId);
  const staleLinks = links.filter((l) => !produced.wordLinks.has(`${l.word_id}:${l.line_id}`));

  const delLink = db.prepare('DELETE FROM word_songs WHERE word_id = ? AND line_id = ?');
  const delWord = db.prepare(
    `DELETE FROM words WHERE id = ?
     AND NOT EXISTS (SELECT 1 FROM word_songs ws WHERE ws.word_id = words.id)`,
  );
  for (const link of staleLinks) delLink.run(link.word_id, link.line_id);
  // Words this song was the last to mention, and the cards that hung off them.
  // Scoped to the links just removed: a word orphaned by something else is not
  // this pass's business, and deleting one costs its review history.
  for (const wordId of new Set(staleLinks.map((l) => l.word_id))) delWord.run(wordId);

  // Counted from the table rather than from `stale`, so the vocabulary cards that
  // went with a deleted word are included.
  const after = countCards.get(songId)?.n ?? 0;
  return { cardsPruned: Math.max(0, before - after), linksPruned: staleLinks.length };
}
