import { Hono } from 'hono';
import { getDb, getSetting, nowIso, setSetting } from '../db';
import { dict } from '../dict';
import * as lrclib from '../lyrics/lrclib';
import * as youtube from '../lyrics/youtube';
import { parseLrc, parsePlain, groupVerses } from '../lyrics/lrc';
import { buildLesson } from '../lesson/build';
import { seedKatakanaDeck, katakanaDeckSize } from '../lesson/kana-deck';
import { annotate, annotateWithReading } from '../lesson/titles';
import * as srs from '../srs/store';
import {
  askAboutWord,
  cachedExamples,
  cachedKanjiMnemonics,
  generateExamples,
  generateKanjiMnemonics,
  generateMnemonic,
  questionHistory,
  songReadings,
  type KanjiFacts,
  type WordRef,
} from '../llm/analyze';
import * as jobs from '../llm/jobs';
import { LlmUnavailable, status as llmStatus } from '../llm/provider';
import { annotateText, KNOWN_SCOPE } from '../nlp/annotate';
import { tokenizeLine } from '../nlp/tokenize';
import { ENROLL_THRESHOLD } from '../nlp/priority';
import type { AnalyzedToken } from '../nlp/tokenize';
import type {
  AiChunk,
  CardKind,
  ClozeChoice,
  FuriganaSegment,
  GrammarNote,
  LineAnalysis,
  Song,
  SongDetail,
  SongLine,
  VerseProgress,
} from '../../shared/types';

export const api = new Hono();

/**
 * Extracts a YouTube video id from a raw id, a watch URL, or a youtu.be link.
 *
 * One implementation, in the YouTube client, so the field that accepts a pasted
 * link and the field that accepts one later cannot disagree about what a link is.
 */
export const parseYoutubeId = youtube.videoIdFrom;

/** m:ss for a millisecond length, for notices about a song's runtime. */
function clockSec(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

api.get('/health', (c) => {
  const d = dict().stats();
  return c.json({
    ok: true,
    dictionary: { available: dict().available, ...d },
    llm: llmStatus(),
    katakanaDeck: katakanaDeckSize(),
    enrollThreshold: ENROLL_THRESHOLD,
  });
});

// --- lyrics search & import -------------------------------------------------

/**
 * Adds ruby and romaji to search results.
 *
 * A list of bare-kanji titles is unreadable for someone who does not read kanji,
 * which is the whole audience — so this happens before they have to choose.
 */
async function annotateHits(hits: lrclib.LrclibHit[]) {
  return Promise.all(
    hits.map(async (hit) => {
      const [title, artistName] = await Promise.all([
        annotate(hit.trackName),
        annotate(hit.artistName),
      ]);
      return {
        ...hit,
        titleFurigana: title?.furigana ?? null,
        titleRomaji: title?.romaji ?? null,
        artistFurigana: artistName?.furigana ?? null,
        artistRomaji: artistName?.romaji ?? null,
      };
    }),
  );
}

api.get('/search', async (c) => {
  const q = c.req.query('q')?.trim();
  const artist = c.req.query('artist')?.trim();
  const duration = Number(c.req.query('duration'));
  if (!q) return c.json({ error: 'q is required' }, 400);
  try {
    const hits = await lrclib.search(
      q,
      artist || undefined,
      Number.isFinite(duration) && duration > 0 ? duration : null,
    );
    return c.json({ hits: await annotateHits(hits) });
  } catch (err) {
    return c.json(
      {
        hits: [],
        error: `Lyrics search unavailable: ${err instanceof Error ? err.message : 'unknown error'}`,
      },
      502,
    );
  }
});

/**
 * A YouTube link, turned into a song to import.
 *
 * The user pastes what they are listening to. The video's own title and channel
 * name give the song and the performer, the watch page gives its length, and the
 * lyric candidates come back ranked against that length — so the full song sorts
 * above the TV-size edit without the user having to know which is which.
 */
api.get('/youtube/resolve', async (c) => {
  const url = c.req.query('url')?.trim();
  if (!url) return c.json({ error: 'url is required' }, 400);

  let video: youtube.YoutubeMeta;
  try {
    video = await youtube.resolve(url);
  } catch (err) {
    const status = err instanceof youtube.NotAVideo ? 400 : 502;
    return c.json(
      { error: err instanceof Error ? err.message : 'Could not read that video' },
      status,
    );
  }

  try {
    // Widen the query only as far as needed: stop at the first candidate that
    // returns Japanese lyrics, since anything else is unusable for studying.
    let hits: lrclib.LrclibHit[] = [];
    for (const candidate of youtube.searchCandidates(video)) {
      const found = await lrclib.search(candidate.q, candidate.artist, video.durationSec);
      if (found.some((h) => h.japanese)) {
        hits = found;
        break;
      }
      if (hits.length === 0) hits = found;
    }
    return c.json({ video, hits: await annotateHits(hits) });
  } catch (err) {
    // The video resolved; only the lyric search failed. Hand back what we have
    // so the user can search by hand instead of starting over.
    return c.json({
      video,
      hits: [],
      error: `Lyrics search unavailable: ${err instanceof Error ? err.message : 'unknown error'}`,
    });
  }
});

api.post('/songs/import', async (c) => {
  const body = await c.req.json<{
    lrclibId?: number;
    title?: string;
    artist?: string;
    album?: string;
    lyrics?: string;
    youtubeId?: string;
    context?: string;
  }>();

  const youtubeId = parseYoutubeId(body.youtubeId);
  const context = body.context?.trim() || null;

  if (body.lrclibId) {
    let fetched: lrclib.FetchedLyrics;
    try {
      fetched = await lrclib.fetchById(body.lrclibId);
    } catch (err) {
      const msg = err instanceof lrclib.NotFound ? 'not found on LRCLIB' : String(err);
      return c.json({ error: `Could not fetch lyrics: ${msg}` }, 502);
    }
    if (!lrclib.hasJapanese(fetched.raw)) {
      return c.json(
        {
          error:
            'Those lyrics contain no Japanese script — probably a romaji or translated transcription. Pick another result or paste the Japanese lyrics.',
        },
        422,
      );
    }
    const result = await buildLesson({
      title: fetched.title,
      artist: fetched.artist,
      album: fetched.album,
      source: 'lrclib',
      lrclibId: fetched.lrclibId,
      durationMs: fetched.durationMs,
      youtubeId,
      context,
      lines: fetched.lines,
      raw: fetched.raw,
    });
    // Explain the song right away rather than waiting for the user to ask.
    const job = jobs.maybeAutoAnalyze(result.songId);
    // LRCLIB lengths are crowdsourced and sometimes belong to a different cut of
    // the song. Say so rather than silently shipping a scrub bar that ends early.
    const notice =
      fetched.statedDurationMs !== null && fetched.durationMs !== null
        ? `LRCLIB listed this entry as ${clockSec(fetched.statedDurationMs)}, but its timings run to ${clockSec(fetched.durationMs)} — the full lyrics were imported and the length corrected.`
        : null;
    return c.json({ ...result, analysis: job, notice });
  }

  const { title, artist, lyrics } = body;
  if (!title?.trim() || !artist?.trim() || !lyrics?.trim()) {
    return c.json({ error: 'title, artist and lyrics are all required when pasting' }, 400);
  }
  if (!lrclib.hasJapanese(lyrics)) {
    return c.json({ error: 'Those lyrics contain no Japanese script.' }, 422);
  }

  // Pasted text may itself be an LRC file with timestamps.
  const looksLrc = /\[\d{1,3}:\d{1,2}/.test(lyrics);
  const lines = looksLrc ? parseLrc(lyrics).lines : parsePlain(lyrics);
  if (lines.length === 0) return c.json({ error: 'No lyric lines found' }, 400);

  const result = await buildLesson({
    title: title.trim(),
    artist: artist.trim(),
    album: body.album?.trim() || null,
    source: 'paste',
    youtubeId,
    context,
    lines,
    raw: lyrics,
  });
  const job = jobs.maybeAutoAnalyze(result.songId);
  return c.json({ ...result, analysis: job });
});

// --- library ----------------------------------------------------------------

interface SongRow {
  id: number;
  title: string;
  artist: string;
  album: string | null;
  source: string;
  context: string | null;
  youtube_id: string | null;
  duration_ms: number | null;
  favourite: number;
  synced: number;
  analyzed: number;
  created_at: string;
  title_furigana: string | null;
  title_romaji: string | null;
  artist_furigana: string | null;
  artist_romaji: string | null;
}

/** Stored as JSON; empty/absent means "no Japanese, nothing to annotate". */
function parseSegments(json: string | null): FuriganaSegment[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as FuriganaSegment[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function toSong(row: SongRow, lineCount: number, verseCount: number): Song {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    titleFurigana: parseSegments(row.title_furigana),
    titleRomaji: row.title_romaji || null,
    artistFurigana: parseSegments(row.artist_furigana),
    artistRomaji: row.artist_romaji || null,
    album: row.album,
    source: row.source as 'lrclib' | 'paste',
    context: row.context,
    youtubeId: row.youtube_id,
    durationMs: row.duration_ms,
    favourite: row.favourite === 1,
    synced: row.synced === 1,
    analyzed: row.analyzed === 1,
    createdAt: row.created_at,
    lineCount,
    verseCount,
  };
}

api.get('/songs', (c) => {
  const db = getDb();
  const rows = db
    .query<SongRow & { line_count: number; verse_count: number; due: number; cards: number }, []>(
      `SELECT s.*,
              (SELECT COUNT(*) FROM lines l WHERE l.song_id = s.id) AS line_count,
              (SELECT COUNT(DISTINCT l.verse_idx) FROM lines l WHERE l.song_id = s.id) AS verse_count,
              (SELECT COUNT(*) FROM cards c JOIN srs r ON r.card_id = c.id
                 WHERE c.song_id = s.id AND r.suspended = 0 AND r.due_at <= datetime('now')) AS due,
              (SELECT COUNT(*) FROM cards c WHERE c.song_id = s.id) AS cards
       FROM songs s ORDER BY s.favourite DESC, s.created_at DESC`,
    )
    .all();

  return c.json({
    songs: rows.map((r) => ({
      ...toSong(r, r.line_count, r.verse_count),
      dueCards: r.due,
      totalCards: r.cards,
    })),
  });
});

api.get('/songs/:id', (c) => {
  const id = Number(c.req.param('id'));
  const db = getDb();
  const song = db.query<SongRow, [number]>('SELECT * FROM songs WHERE id = ?').get(id);
  if (!song) return c.json({ error: 'song not found' }, 404);

  const lineRows = db
    .query<
      {
        id: number;
        idx: number;
        text: string;
        time_ms: number | null;
        verse_idx: number;
        tokens: string;
        translation: string | null;
        literal: string | null;
        notes: string | null;
        chunks: string | null;
        provider: string | null;
      },
      [number]
    >(
      `SELECT l.id, l.idx, l.text, l.time_ms, l.verse_idx, l.tokens,
              a.translation, a.literal, a.notes, a.chunks, a.provider
       FROM lines l LEFT JOIN line_analysis a ON a.line_id = l.id
       WHERE l.song_id = ? ORDER BY l.idx`,
    )
    .all(id);

  const lines: SongLine[] = lineRows.map((r) => {
    const analysis: LineAnalysis | undefined =
      r.translation || r.notes || r.chunks
        ? {
            translation: r.translation,
            literal: r.literal,
            notes: r.notes ? (JSON.parse(r.notes) as GrammarNote[]) : [],
            chunks: r.chunks ? (JSON.parse(r.chunks) as AiChunk[]) : [],
            provider: r.provider,
          }
        : undefined;
    return {
      id: r.id,
      idx: r.idx,
      text: r.text,
      timeMs: r.time_ms,
      verseIdx: r.verse_idx,
      tokens: JSON.parse(r.tokens) as AnalyzedToken[],
      analysis,
    };
  });

  const progressRows = db
    .query<{ verse_idx: number; state: string; lines_done: number }, [number]>(
      'SELECT verse_idx, state, lines_done FROM verse_progress WHERE song_id = ? ORDER BY verse_idx',
    )
    .all(id);

  const counts = new Map<number, number>();
  for (const l of lines) counts.set(l.verseIdx, (counts.get(l.verseIdx) ?? 0) + 1);

  const progress: VerseProgress[] = [...counts.keys()].sort((a, b) => a - b).map((verseIdx) => {
    const row = progressRows.find((p) => p.verse_idx === verseIdx);
    return {
      verseIdx,
      state: (row?.state ?? 'new') as VerseProgress['state'],
      linesDone: row?.lines_done ?? 0,
      lineCount: counts.get(verseIdx) ?? 0,
    };
  });

  const detail: SongDetail = {
    ...toSong(song, lines.length, counts.size),
    lines,
    progress,
  };
  return c.json(detail);
});

api.delete('/songs/:id', (c) => {
  const id = Number(c.req.param('id'));
  const res = getDb().prepare('DELETE FROM songs WHERE id = ?').run(id);
  return c.json({ deleted: res.changes > 0 });
});

api.patch('/songs/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{
    youtubeId?: string | null;
    timings?: { idx: number; timeMs: number }[];
    shiftMs?: number;
    titleReading?: string;
    artistReading?: string;
    context?: string | null;
    favourite?: boolean;
  }>();
  const db = getDb();

  if (body.favourite !== undefined) {
    db.prepare('UPDATE songs SET favourite = ? WHERE id = ?').run(body.favourite ? 1 : 0, id);
  }

  // Context can be edited after import: the user often finds the interview or
  // the plot summary after the lesson already exists, and re-explaining the
  // song then picks it up.
  if (body.context !== undefined) {
    db.prepare('UPDATE songs SET context = ? WHERE id = ?').run(
      body.context?.trim() || null,
      id,
    );
  }

  // Reading overrides: the automatic guess is wrong for most coined titles.
  for (const [field, value] of [
    ['title', body.titleReading],
    ['artist', body.artistReading],
  ] as const) {
    if (value === undefined) continue;
    const row = db
      .query<{ text: string }, [number]>(`SELECT ${field} AS text FROM songs WHERE id = ?`)
      .get(id);
    if (!row) return c.json({ error: 'song not found' }, 404);

    if (!value.trim()) {
      // Cleared: fall back to the automatic annotation.
      const auto = await annotate(row.text);
      db.prepare(
        `UPDATE songs SET ${field}_furigana = ?, ${field}_romaji = ? WHERE id = ?`,
      ).run(auto ? JSON.stringify(auto.furigana) : null, auto ? auto.romaji : '', id);
      continue;
    }

    const applied = annotateWithReading(row.text, value);
    if (!applied) return c.json({ error: `Could not read "${value}" as a reading` }, 400);
    db.prepare(`UPDATE songs SET ${field}_furigana = ?, ${field}_romaji = ? WHERE id = ?`).run(
      JSON.stringify(applied.furigana),
      applied.romaji,
      id,
    );
  }

  if (body.youtubeId !== undefined) {
    const parsed = parseYoutubeId(body.youtubeId);
    if (body.youtubeId && !parsed) {
      return c.json({ error: 'Could not read a YouTube video id from that' }, 400);
    }
    db.prepare('UPDATE songs SET youtube_id = ? WHERE id = ?').run(parsed, id);
    // Listening cards carry the video id inside their audio clip, so a changed
    // video has to repoint them — otherwise every clip keeps playing the old
    // upload. The upsert keeps card ids, and with them the review history. A
    // cleared video leaves nothing to play, so those cards go instead.
    if (parsed) rebuildListeningCards(id);
    else removeListeningCards(id);
  }

  if (body.timings?.length) {
    const upd = db.prepare('UPDATE lines SET time_ms = ? WHERE song_id = ? AND idx = ?');
    db.transaction(() => {
      for (const t of body.timings!) upd.run(Math.round(t.timeMs), id, t.idx);
      db.prepare('UPDATE songs SET synced = 1 WHERE id = ?').run(id);
    })();
    // Timings unlock listening cards, which need a video to play.
    rebuildListeningCards(id);
  }

  // Lyrics timed against a different cut of the song are right about the spacing
  // and wrong about the start — an edit that drops a 20-second intro puts every
  // line 20 seconds early. One offset fixes the whole song, which beats tapping
  // forty lines again to correct a constant.
  if (body.shiftMs) {
    const shift = Math.round(body.shiftMs);
    db.prepare(
      `UPDATE lines SET time_ms = MAX(0, time_ms + ?) WHERE song_id = ? AND time_ms IS NOT NULL`,
    ).run(shift, id);
    // A later start can push the last line past the stored length, which would
    // crop the scrub bar; the video is the authority on how long the track is.
    const last = db
      .query<{ t: number | null }, [number]>(
        'SELECT MAX(time_ms) AS t FROM lines WHERE song_id = ?',
      )
      .get(id);
    if (last?.t != null) {
      db.prepare(
        'UPDATE songs SET duration_ms = MAX(COALESCE(duration_ms, 0), ?) WHERE id = ?',
      ).run(last.t + 8000, id);
    }
    // Every clip's start and end moved with the lines.
    rebuildListeningCards(id);
  }

  return c.json({ ok: true });
});

/**
 * Creates or repoints listening cards once a song has both timings and a video.
 * Called after timing *and* video changes rather than at import, because either
 * can arrive later — and because a card built against the previous video would
 * otherwise keep playing a clip from it.
 */
export function rebuildListeningCards(songId: number) {
  const db = getDb();
  const song = db
    .query<{ youtube_id: string | null }, [number]>('SELECT youtube_id FROM songs WHERE id = ?')
    .get(songId);
  if (!song?.youtube_id) return;

  const lines = db
    .query<{ id: number; idx: number; text: string; time_ms: number | null }, [number]>(
      'SELECT id, idx, text, time_ms FROM lines WHERE song_id = ? ORDER BY idx',
    )
    .all(songId);

  const insCard = db.prepare(
    `INSERT INTO cards (kind, song_id, line_id, dedupe_key, front, back, created_at)
     VALUES ('listening', ?, ?, ?, ?, ?, ?)
     ON CONFLICT (dedupe_key) DO UPDATE SET front = excluded.front, back = excluded.back
     RETURNING id`,
  );
  const insSrs = db.prepare(
    "INSERT INTO srs (card_id, due_at) VALUES (?, ?) ON CONFLICT (card_id) DO NOTHING",
  );

  db.transaction(() => {
    lines.forEach((line, i) => {
      if (line.time_ms === null) return;
      const endMs = lines[i + 1]?.time_ms ?? line.time_ms + 6000;
      const row = insCard.get(
        songId,
        line.id,
        `listening:${line.id}`,
        JSON.stringify({
          prompt: 'Listen, then read the line',
          audio: { youtubeId: song.youtube_id, startMs: line.time_ms, endMs },
        }),
        JSON.stringify({ answer: line.text }),
        nowIso(),
      ) as { id: number };
      insSrs.run(row.id, nowIso());
    });
  })();
}

/**
 * Drops a song's listening cards, for when its video is taken away. Their whole
 * prompt is a clip of that video, so without it there is nothing to answer; the
 * srs rows and review history go with them by foreign key.
 */
export function removeListeningCards(songId: number): number {
  const db = getDb();
  // Counted before the delete: `changes` also takes in the srs and review rows
  // that cascade, so it would report a multiple of the cards actually removed.
  const doomed =
    db
      .query<{ n: number }, [number]>(
        "SELECT COUNT(*) AS n FROM cards WHERE song_id = ? AND kind = 'listening'",
      )
      .get(songId)?.n ?? 0;
  db.prepare("DELETE FROM cards WHERE song_id = ? AND kind = 'listening'").run(songId);
  return doomed;
}

api.get('/songs/:id/words', (c) => {
  const id = Number(c.req.param('id'));
  const rows = getDb()
    .query<
      {
        id: number;
        lemma: string;
        reading: string;
        romaji: string;
        furigana: string;
        glosses: string;
        jlpt: number | null;
        priority: number;
        loanword: number;
        enrolled: number;
        lapses: number | null;
        interval_days: number | null;
        reps: number | null;
        leech: number | null;
        retired: number | null;
        due_at: string | null;
        seen_as: string | null;
      },
      [number, number]
    >(
      // MIN over suspended, so a word only counts as retired once every card for
      // it is out of the rotation — one retired reading does not retire the word.
      `SELECT DISTINCT w.id, w.lemma, w.reading, w.romaji, w.furigana, w.glosses, w.jlpt,
              w.priority, w.loanword,
              (SELECT COUNT(*) FROM cards c WHERE c.word_id = w.id) AS enrolled,
              (SELECT MAX(r.lapses) FROM cards c JOIN srs r ON r.card_id = c.id WHERE c.word_id = w.id) AS lapses,
              (SELECT MAX(r.interval_days) FROM cards c JOIN srs r ON r.card_id = c.id WHERE c.word_id = w.id) AS interval_days,
              (SELECT SUM(r.reps) FROM cards c JOIN srs r ON r.card_id = c.id WHERE c.word_id = w.id) AS reps,
              (SELECT MAX(r.leech) FROM cards c JOIN srs r ON r.card_id = c.id WHERE c.word_id = w.id) AS leech,
              (SELECT MIN(r.suspended) FROM cards c JOIN srs r ON r.card_id = c.id WHERE c.word_id = w.id) AS retired,
              (SELECT MIN(r.due_at) FROM cards c JOIN srs r ON r.card_id = c.id
                 WHERE c.word_id = w.id AND r.suspended = 0) AS due_at,
              -- Every form the word wore in this song. One word can appear as
              -- several (探した, 探して), and none of them need equal the headword.
              (SELECT GROUP_CONCAT(DISTINCT ws2.seen_as) FROM word_songs ws2
                 WHERE ws2.word_id = w.id AND ws2.song_id = ?) AS seen_as
       FROM words w
       JOIN word_songs ws ON ws.word_id = w.id
       WHERE ws.song_id = ?
       ORDER BY w.priority DESC, w.lemma`,
    )
    .all(id, id);

  return c.json({
    words: rows.map((r) => ({
      id: r.id,
      lemma: r.lemma,
      reading: r.reading,
      romaji: r.romaji,
      furigana: JSON.parse(r.furigana),
      glosses: JSON.parse(r.glosses),
      jlpt: r.jlpt,
      priority: r.priority,
      loanword: r.loanword === 1,
      enrolled: r.enrolled > 0,
      lapses: r.lapses ?? 0,
      retired: r.retired === 1,
      seenAs: r.seen_as ? r.seen_as.split(',').filter(Boolean) : [],
      // The word garden shows a mastery ring rather than a table column, so the
      // word list carries the same SRS numbers a card does.
      mastery: srs.mastery({
        intervalDays: r.interval_days ?? 0,
        reps: r.reps ?? 0,
        lapses: r.lapses ?? 0,
        leech: r.leech === 1,
        suspended: r.retired === 1,
      }),
      dueAt: r.due_at,
    })),
  });
});

/**
 * Starts analysis in the background and returns immediately with a job status.
 * Careful analysis takes minutes on a full song, so the client polls
 * GET /songs/:id/analysis rather than holding a request open.
 */
api.post('/songs/:id/analyze', (c) => {
  const id = Number(c.req.param('id'));
  const force = c.req.query('force') === '1';

  if (jobs.isRunning(id)) return c.json(jobs.status(id));
  if (llmStatus().provider === 'none') {
    return c.json({ error: 'No AI provider configured', llm: llmStatus() }, 409);
  }
  return c.json(jobs.start(id, { force }));
});

api.get('/songs/:id/analysis', (c) => {
  const id = Number(c.req.param('id'));
  const db = getDb();
  const counts = db
    .query<{ total: number; analyzed: number; segmented: number }, [number]>(
      `SELECT
         (SELECT COUNT(*) FROM lines WHERE song_id = ?1) AS total,
         (SELECT COUNT(*) FROM lines l JOIN line_analysis a ON a.line_id = l.id
           WHERE l.song_id = ?1 AND a.translation IS NOT NULL) AS analyzed,
         (SELECT COUNT(*) FROM lines l JOIN line_analysis a ON a.line_id = l.id
           WHERE l.song_id = ?1 AND a.chunks != '[]') AS segmented`,
    )
    .get(id);

  return c.json({
    job: jobs.status(id),
    lines: counts?.total ?? 0,
    linesAnalyzed: counts?.analyzed ?? 0,
    linesSegmented: counts?.segmented ?? 0,
    llm: llmStatus(),
  });
});

api.post('/songs/:id/progress', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ verseIdx: number; linesDone?: number; state?: string }>();
  if (typeof body.verseIdx !== 'number') return c.json({ error: 'verseIdx required' }, 400);

  getDb()
    .prepare(
      `INSERT INTO verse_progress (song_id, verse_idx, state, lines_done, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (song_id, verse_idx) DO UPDATE SET
         state = excluded.state,
         lines_done = MAX(lines_done, excluded.lines_done),
         updated_at = excluded.updated_at`,
    )
    .run(id, body.verseIdx, body.state ?? 'in_progress', body.linesDone ?? 0, nowIso());

  return c.json({ ok: true });
});

// --- review -----------------------------------------------------------------

api.get('/review/queue', (c) => {
  const limit = Number(c.req.query('limit') ?? 20);
  const songId = c.req.query('songId') ? Number(c.req.query('songId')) : undefined;
  const kinds = c.req.query('kinds')?.split(',').filter(Boolean) as CardKind[] | undefined;
  const cards = srs.queue({
    limit,
    songId,
    kinds,
    leechesOnly: c.req.query('leeches') === '1',
    includeAhead: c.req.query('ahead') === '1',
  });
  // Each grade button says what it will do ("6 days"), so the schedule is
  // visible before the user commits to an answer rather than after.
  const previews: Record<number, ReturnType<typeof srs.previewIntervals>> = {};
  for (const card of cards) previews[card.id] = srs.previewIntervals(card.id);

  return c.json({ cards, cloze: buildClozeChoices(cards), previews });
});

/**
 * Multiple-choice options for cloze cards.
 *
 * Distractors are drawn from other words in the library so they are plausible
 * rather than obviously wrong. Every option ships with its own furigana and
 * romaji: the options are the part of the card the user actually has to read,
 * and this user does not read kanji, so bare kanji buttons make the question
 * unanswerable instead of harder.
 */
function buildClozeChoices(
  cards: {
    id: number;
    kind: string;
    back: { answer: string; furigana?: FuriganaSegment[]; romaji?: string; reading?: string };
  }[],
): Record<number, ClozeChoice[]> {
  const db = getDb();
  const out: Record<number, ClozeChoice[]> = {};

  for (const card of cards) {
    if (card.kind !== 'cloze') continue;
    const answer = card.back.answer;

    const rows = db
      .query<
        { lemma: string; furigana: string; romaji: string },
        [string, number]
      >(
        `SELECT lemma, furigana, romaji FROM words
         WHERE lemma != ? AND length(lemma) BETWEEN 1 AND 6
         ORDER BY abs(priority - 50), RANDOM() LIMIT ?`,
      )
      .all(answer, 3);

    const choices: ClozeChoice[] = [
      {
        text: answer,
        // The card's own stored ruby for the answer; fall back to a single
        // unannotated segment so a choice is never rendered without something.
        furigana: card.back.furigana?.length
          ? card.back.furigana
          : [{ text: answer, ruby: '' }],
        romaji: card.back.romaji ?? '',
      },
      ...rows.map((r) => ({
        text: r.lemma,
        furigana: parseSegments(r.furigana) ?? [{ text: r.lemma, ruby: '' }],
        romaji: r.romaji ?? '',
      })),
    ];

    // Shuffle so the answer isn't always first.
    for (let i = choices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [choices[i], choices[j]] = [choices[j], choices[i]];
    }
    out[card.id] = choices;
  }
  return out;
}

api.post('/review/grade', async (c) => {
  const body = await c.req.json<{ cardId: number; quality: number; ms?: number; given?: string }>();
  if (typeof body.cardId !== 'number' || typeof body.quality !== 'number') {
    return c.json({ error: 'cardId and quality are required' }, 400);
  }
  try {
    const result = srs.grade(body.cardId, body.quality, body.ms ?? 0, body.given);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'grade failed' }, 400);
  }
});

api.get('/stats', (c) => c.json(srs.stats()));

api.get('/trouble', (c) => {
  const songId = c.req.query('songId') ? Number(c.req.query('songId')) : undefined;
  return c.json({
    lines: srs.troubleLines(songId),
    leeches: srs.queue({ leechesOnly: true, includeAhead: true, limit: 50 }),
    clusters: srs.troubleClusters(),
  });
});

api.get('/mistakes', (c) => c.json({ patterns: srs.mistakePatterns() }));

/** Every line of every song, shaded by how well it is known. The song map. */
api.get('/songmap', (c) => c.json({ songs: srs.songMap() }));

/**
 * Why a card keeps failing, in the user's own words or from a preset.
 *
 * Asked after the third miss, when a plain "again" has clearly stopped being
 * useful, and read back on Today so the answer visibly changes something.
 */
api.post('/cards/:id/reason', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req
    .json<{ reason?: string; note?: string }>()
    .catch(() => ({}) as { reason?: string; note?: string });
  if (!body.reason) return c.json({ error: 'reason is required' }, 400);
  srs.setCardReason(id, body.reason, body.note);
  return c.json({ ok: true });
});

/** Coarse playback accounting, so "listening this week" is real rather than a guess. */
api.post('/listening', async (c) => {
  const body = await c.req
    .json<{ seconds?: number }>()
    .catch(() => ({}) as { seconds?: number });
  srs.logListening(body.seconds ?? 0);
  return c.json({ ok: true });
});

api.post('/cards/:id/mnemonic', async (c) => {
  const id = Number(c.req.param('id'));
  try {
    const mnemonic = await generateMnemonic(id);
    if (!mnemonic) return c.json({ error: 'No AI provider configured', llm: llmStatus() }, 409);
    return c.json({ mnemonic });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : 'failed' }, 500);
  }
});

api.post('/cards/:id/suspend', async (c) => {
  const id = Number(c.req.param('id'));
  const body = await c.req.json<{ suspended?: boolean }>().catch(() => ({ suspended: true }));
  srs.setSuspended(id, body.suspended ?? true);
  return c.json({ ok: true });
});

api.post('/cards/:id/clear-leech', (c) => {
  srs.clearLeech(Number(c.req.param('id')));
  return c.json({ ok: true });
});

// --- word examples & questions ---------------------------------------------
//
// Keyed by the text of the word, not by a word id: the user taps AI chunks and
// set expressions that have no dictionary entry. Both caches are read without
// touching a model, so the GET routes work with no API key at all.

/** Reads the word being asked about from a request body. */
function readWordRef(body: {
  term?: string;
  reading?: string;
  meaning?: string;
  lineText?: string;
  songId?: number;
}): WordRef | null {
  const term = body.term?.trim();
  if (!term) return null;
  return {
    term,
    reading: body.reading?.trim() || undefined,
    meaning: body.meaning?.trim() || undefined,
    lineText: body.lineText?.trim() || undefined,
    songId: typeof body.songId === 'number' ? body.songId : undefined,
  };
}

api.get('/words/examples', (c) => {
  const term = c.req.query('term')?.trim();
  if (!term) return c.json({ error: 'term is required' }, 400);
  return c.json({ examples: cachedExamples(term, c.req.query('reading') ?? '') });
});

api.post('/words/examples', async (c) => {
  const body = await c.req.json<Parameters<typeof readWordRef>[0] & { force?: boolean }>();
  const ref = readWordRef(body);
  if (!ref) return c.json({ error: 'term is required' }, 400);

  try {
    const result = await generateExamples(ref, { force: body.force === true });
    return c.json(result);
  } catch (err) {
    if (err instanceof LlmUnavailable) {
      return c.json({ error: 'No AI provider configured', llm: llmStatus() }, 409);
    }
    return c.json({ error: err instanceof Error ? err.message : 'failed' }, 502);
  }
});

api.get('/words/questions', (c) => {
  const term = c.req.query('term')?.trim();
  if (!term) return c.json({ error: 'term is required' }, 400);
  return c.json({ questions: questionHistory(term, c.req.query('reading') ?? '') });
});

api.post('/words/ask', async (c) => {
  const body = await c.req.json<Parameters<typeof readWordRef>[0] & { question?: string }>();
  const ref = readWordRef(body);
  if (!ref) return c.json({ error: 'term is required' }, 400);
  if (!body.question?.trim()) return c.json({ error: 'question is required' }, 400);

  try {
    const result = await askAboutWord(ref, body.question);
    return c.json(result);
  } catch (err) {
    if (err instanceof LlmUnavailable) {
      return c.json({ error: 'No AI provider configured', llm: llmStatus() }, 409);
    }
    return c.json({ error: err instanceof Error ? err.message : 'failed' }, 502);
  }
});

api.post('/words/:id/enroll', (c) => {
  const card = srs.enrollWord(Number(c.req.param('id')));
  if (!card) return c.json({ error: 'word not found' }, 404);
  return c.json({ card });
});

// --- dictionary & kana ------------------------------------------------------

api.get('/lookup', async (c) => {
  const term = c.req.query('term')?.trim();
  if (!term) return c.json({ error: 'term is required' }, 400);
  const entries = dict().entriesFor(term);
  const kanji = [...term]
    .map((ch) => dict().kanji(ch))
    .filter((k): k is NonNullable<typeof k> => !!k);
  // Whatever hooks exist already. Generating the missing ones costs a model
  // request, so that is its own endpoint and the caller's decision.
  const mnemonics = cachedKanjiMnemonics(kanji.map((k) => k.char));
  return c.json({
    entries,
    kanji: kanji.map((k) => ({ ...k, mnemonic: mnemonics[k.char] ?? null })),
  });
});

/**
 * Generates the memory hooks for the kanji of one word, and caches them.
 *
 * The characters are taken as given but their facts are read from KANJIDIC2
 * here, so a caller cannot have hooks written for meanings and readings the
 * character does not have.
 */
api.post('/kanji/mnemonics', async (c) => {
  const body = await c.req.json<{ chars?: string[]; force?: boolean }>();
  const chars = [...new Set((body.chars ?? []).flatMap((s) => [...String(s)]))].filter((ch) =>
    /[一-龯]/.test(ch),
  );
  if (chars.length === 0) return c.json({ error: 'chars is required' }, 400);
  if (chars.length > 8) return c.json({ error: 'too many characters in one request' }, 400);

  const facts: KanjiFacts[] = [];
  for (const char of chars) {
    const info = dict().kanji(char);
    if (info) facts.push({ char, meanings: info.meanings, on: info.on, kun: info.kun });
  }
  if (facts.length === 0) return c.json({ error: 'no such kanji in the dictionary' }, 404);

  try {
    const mnemonics = await generateKanjiMnemonics(facts, { force: body.force === true });
    return c.json({ mnemonics });
  } catch (err) {
    if (err instanceof LlmUnavailable) {
      return c.json({ error: 'No AI provider configured', llm: llmStatus() }, 409);
    }
    return c.json({ error: err instanceof Error ? err.message : 'failed' }, 502);
  }
});

/**
 * Ruby for Japanese quoted inside English prose — explanations, grammar notes,
 * model answers. The client asks for the strings it is about to show, in one
 * batch, and caches what comes back; the server caches the annotation itself,
 * so the same explanation is only ever parsed once.
 */
api.post('/furigana', async (c) => {
  const body = await c.req.json<{ texts?: unknown; songId?: number }>();
  const texts = Array.isArray(body.texts) ? body.texts.filter((t) => typeof t === 'string') : null;
  if (!texts) return c.json({ error: 'texts is required' }, 400);
  if (texts.length > 200) return c.json({ error: 'too many texts in one request' }, 400);

  // Quoting the song's Japanese has to agree with the reading shown in the lyrics
  // above, so when the caller says which song it is reading, that song's own
  // readings outrank the dictionary.
  let known: Map<string, string> | undefined;
  if (typeof body.songId === 'number' && Number.isFinite(body.songId)) {
    known = songReadings(body.songId);
    known.set(KNOWN_SCOPE, String(body.songId));
  }

  const segments: Record<string, FuriganaSegment[]> = {};
  for (const text of texts) {
    if (text.length > 2000) continue;
    segments[text] = await annotateText(text, known);
  }
  return c.json({ segments });
});

api.post('/analyze-line', async (c) => {
  const body = await c.req.json<{ text?: string }>();
  if (!body.text?.trim()) return c.json({ error: 'text is required' }, 400);
  const tokens = await tokenizeLine(body.text.trim());
  return c.json({ tokens });
});

api.post('/kana/seed', (c) => c.json(seedKatakanaDeck()));

// --- settings ---------------------------------------------------------------

const EXPOSED_SETTINGS = [
  'llm_provider',
  'gateway_model',
  'daily_new_limit',
  'reasoning_effort',
  'llm_concurrency',
  'auto_analyze',
  // 'ai' (default) shows no reading until the model has decided one; 'dictionary'
  // shows the offline guess in the meantime.
  'lyric_readings',
] as const;

api.get('/settings', (c) => {
  const out: Record<string, string | null> = {};
  for (const k of EXPOSED_SETTINGS) out[k] = getSetting(k);
  // Never send the key back to the client; report only whether one is set.
  out.gateway_api_key_set = getSetting('gateway_api_key') ? 'yes' : 'no';
  return c.json({ settings: out, llm: llmStatus() });
});

api.put('/settings', async (c) => {
  const body = await c.req.json<Record<string, string | null>>();
  for (const [k, v] of Object.entries(body)) {
    if (![...EXPOSED_SETTINGS, 'gateway_api_key'].includes(k)) continue;
    if (v === null || v === '') {
      getDb().prepare('DELETE FROM settings WHERE k = ?').run(k);
    } else {
      setSetting(k, v);
    }
  }
  return c.json({ ok: true, llm: llmStatus() });
});
