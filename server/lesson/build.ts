import type { Database } from 'bun:sqlite';
import type { AnalyzedToken } from '../nlp/tokenize';
import { tokenizeLine, lineRomaji, lineKana } from '../nlp/tokenize';
import { shouldEnroll } from '../nlp/priority';
import { isLoanword, toRomaji } from '../nlp/kana';
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

    stats = materialize(db, songId, lineIds, tokenized, input, now);
  })();

  return {
    songId: songId!,
    lineCount: input.lines.length,
    verseCount: new Set(verses).size,
    ...stats,
  };
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
    `INSERT INTO cards (kind, song_id, line_id, word_id, grammar_id, dedupe_key, front, back, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) DO UPDATE SET front = excluded.front, back = excluded.back
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

      if (shouldEnroll(token.priority)) {
        enrolledHere.push({ token, wordId: row.id });
        addCard(
          'vocab',
          `vocab:${row.id}`,
          {
            prompt: 'What does this word mean?',
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
            note:
              token.surface !== entry.headword
                ? `Seen in the song as ${token.surface} (${token.romaji})`
                : undefined,
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
        `grammar:${note.key}`,
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
          glosses: token.entry?.senses.flatMap((s) => s.glosses).slice(0, 3),
        },
        { wordId, lineId },
      );
    }

    // --- listening ----------------------------------------------------------
    // Only meaningful with both a timing and a video to play.
    const timeMs = input.lines[lineIdx].timeMs;
    const nextTime = input.lines[lineIdx + 1]?.timeMs ?? null;
    if (input.youtubeId && timeMs !== null) {
      const endMs = nextTime !== null ? nextTime : timeMs + 6000;
      addCard(
        'listening',
        `listening:${lineId}`,
        {
          prompt: 'Listen, then read the line',
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

  return { wordsEnrolled, wordsSongOnly, grammarPoints, cardsCreated };
}
