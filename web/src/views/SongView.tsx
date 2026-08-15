import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AnalysisJob, type TroubleLine } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useCommands, useRail } from '../lib/shell';
import { Furigana } from '../components/Furigana';
import { SongReadings } from '../components/RubyText';
import { YouTubePlayer, type PlayerHandle } from '../components/YouTubePlayer';
import { clock } from '../components/bits';
import { Stage } from './Stage';
import type { SongLine, VerseProgress } from '../../../shared/types';
import { ROLE_CATEGORIES } from '../../../shared/roles';
import { useSongWords } from './song/useSongWords';
import { ReadingEditor, ContextEditor, OffsetEditor } from './song/editors';
import { LyricLine } from './song/LyricLine';
import { WordGarden } from './song/WordGarden';

/**
 * A song's lesson page.
 *
 * Two controls stay on screen — play and study — and everything else moved into
 * ⌘K and the section spine in the rail. The lyrics keep their two channels
 * (colour for grammatical role, a bar underneath for how well the word is
 * stuck), and the vocabulary table became a garden of cards with mastery rings.
 *
 * The pieces live in ./song: the word index and mastery lookup (useSongWords),
 * one lyric line (LyricLine), the vocabulary garden (WordGarden), and the
 * metadata editors (editors). What stays here is the shape of the page and the
 * playback state everything hangs off.
 */
export function SongView({
  songId,
  onStudy,
  onBack,
  notice,
  onNoticeSeen,
}: {
  songId: number;
  onStudy: (songId: number) => void;
  onBack: () => void;
  /** Carried over from an import that had to correct the source metadata. */
  notice?: string | null;
  onNoticeSeen?: () => void;
}) {
  const song = useAsync(() => api.song(songId), [songId]);
  const words = useAsync(() => api.songWords(songId), [songId]);
  const trouble = useAsync(() => api.trouble(songId), [songId]);
  const settings = useAsync(() => api.settings(), []);

  const [selectedToken, setSelectedToken] = useState<{ lineId: number; idx: number } | null>(null);
  const [player, setPlayer] = useState<PlayerHandle | null>(null);
  const [positionMs, setPositionMs] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncIdx, setSyncIdx] = useState(0);
  const [pendingTimings, setPendingTimings] = useState<{ idx: number; timeMs: number }[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisJob | null>(null);
  const [segmented, setSegmented] = useState(0);
  const [analyzeMsg, setAnalyzeMsg] = useState<string | null>(notice ?? null);
  const [showRomaji, setShowRomaji] = useState(true);
  const [videoInput, setVideoInput] = useState('');
  const [editing, setEditing] = useState<'reading' | 'context' | 'video' | 'offset' | null>(null);
  const [selectedChunk, setSelectedChunk] = useState<{ lineId: number; idx: number } | null>(null);
  const [stage, setStage] = useState(false);
  const [focusVerse, setFocusVerse] = useState<number | null>(null);
  const activeLineRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  // The import message is a one-shot: it belongs to the page it opened, and
  // should not come back when the same song is opened again later.
  useEffect(() => {
    if (notice) onNoticeSeen?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { masteryOf, enrich } = useSongWords(words.data?.words);

  const troubleLineIds = useMemo(
    () => new Set((trouble.data?.lines ?? []).map((l: TroubleLine) => l.lineId)),
    [trouble.data],
  );

  const lines = song.data?.lines ?? [];

  /**
   * Whether a line the model has not read yet may show the offline parse's ruby.
   *
   * Off by default. The local parse commits to one reading per word and is wrong
   * exactly where songs are interesting — a stylised reading, a name, a compound
   * whose reading depends on the line — and a confident wrong reading is worse than
   * none, because it is the thing the learner memorises.
   */
  const offlineReadings = (settings.data?.settings.lyric_readings ?? 'ai') === 'dictionary';

  /** Index of the lyric line that should be highlighted right now. */
  const activeIdx = useMemo(() => {
    if (!song.data?.synced) return -1;
    let found = -1;
    for (let i = 0; i < lines.length; i++) {
      const t = lines[i].timeMs;
      if (t !== null && t <= positionMs + 250) found = i;
      else if (t !== null) break;
    }
    return found;
  }, [lines, positionMs, song.data?.synced]);

  /**
   * Scrolls the active line clear of the sticky stage bar.
   *
   * Aligning tops and offsetting by the bar's measured height keeps the
   * Japanese visible whatever is expanded underneath it; centring would put the
   * text itself behind the video.
   */
  useEffect(() => {
    if (activeIdx < 0 || stage) return;
    const el = activeLineRef.current;
    if (!el) return;
    const rect = barRef.current?.getBoundingClientRect();
    const offset = rect ? Math.max(0, Math.min(rect.bottom, rect.height)) : 0;
    const delta = el.getBoundingClientRect().top - offset - 12;
    if (Math.abs(delta) < 2) return;
    window.scrollBy({ top: delta, behavior: 'smooth' });
  }, [activeIdx, stage]);

  // Playback accounting for "listening this week", in coarse ticks so it costs
  // one row a day rather than one per second.
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      void api.logListening(15).catch(() => {
        /* accounting is not worth an error */
      });
    }, 15_000);
    return () => clearInterval(timer);
  }, [playing]);

  const runAnalysis = async (force = false) => {
    setAnalyzeMsg(null);
    try {
      setAnalysis(await api.analyzeSong(songId, force));
    } catch (err) {
      setAnalyzeMsg(err instanceof Error ? err.message : 'Analysis failed');
    }
  };

  // Poll while analysis is running, then refresh the lines once new ones land.
  useEffect(() => {
    if (!analysis || analysis.state !== 'running') return;
    let cancelled = false;

    const tick = async () => {
      try {
        const res = await api.analysisStatus(songId);
        if (cancelled) return;
        if (res.job) setAnalysis(res.job);

        setSegmented((prev) => {
          if (res.linesSegmented !== prev) song.reload();
          return res.linesSegmented;
        });

        if (res.job && res.job.state !== 'running') {
          if (res.job.state === 'failed') setAnalyzeMsg(res.job.error);
          else if (res.job.rejected > 0) {
            setAnalyzeMsg(
              `${res.job.rejected} line${res.job.rejected === 1 ? '' : 's'} could not be segmented reliably and kept the offline parse.`,
            );
          }
        }
      } catch {
        // A failed poll is not worth surfacing; the next one may succeed.
      }
    };

    const timer = setInterval(tick, 2500);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis?.state, songId]);

  /** Picks up a job this page did not start: auto-analysis from import, say. */
  useEffect(() => {
    let cancelled = false;

    const check = () => {
      void api
        .analysisStatus(songId)
        .then((res) => {
          if (cancelled) return;
          setSegmented(res.linesSegmented);
          if (res.job) setAnalysis(res.job);
        })
        .catch(() => {
          /* status is optional context */
        });
    };

    check();
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [songId]);

  // --- tap-to-sync ----------------------------------------------------------

  const startSync = () => {
    setSyncing(true);
    setSyncIdx(0);
    setPendingTimings([]);
    player?.seekMs(0);
    player?.play();
  };

  const tapSync = useCallback(() => {
    if (!syncing || !player) return;
    const ms = Math.max(0, player.currentMs());
    setPendingTimings((prev) => [...prev, { idx: syncIdx, timeMs: ms }]);
    setSyncIdx((i) => i + 1);
  }, [syncing, player, syncIdx]);

  const finishSync = async () => {
    setSyncing(false);
    player?.pause();
    if (pendingTimings.length > 0) {
      await api.updateSong(songId, { timings: pendingTimings });
      song.reload();
    }
    setPendingTimings([]);
  };

  // Space taps the current line while syncing, so eyes stay on the lyrics.
  useEffect(() => {
    if (!syncing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (syncIdx >= lines.length) void finishSync();
        else tapSync();
      } else if (e.key === 'Escape') {
        setSyncing(false);
        setPendingTimings([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing, syncIdx, lines.length, tapSync]);

  // ⇧S takes the stage from anywhere on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.shiftKey && e.key.toLowerCase() === 's' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setStage((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /**
   * Opens the video field with the current link already in it, so changing a
   * video is an edit rather than typing an id out again from memory.
   */
  const openVideoEditor = () => {
    setVideoInput(song.data?.youtubeId ?? '');
    setEditing('video');
  };

  const attachVideo = async () => {
    if (!videoInput.trim()) return;
    try {
      await api.updateSong(songId, { youtubeId: videoInput.trim() });
      setVideoInput('');
      setEditing(null);
      song.reload();
    } catch (err) {
      setAnalyzeMsg(err instanceof Error ? err.message : 'Could not change the video');
    }
  };

  /** Moves every line by one offset, for lyrics timed against a different cut. */
  const shiftTimings = async (ms: number) => {
    try {
      await api.updateSong(songId, { shiftMs: ms });
      song.reload();
    } catch (err) {
      setAnalyzeMsg(err instanceof Error ? err.message : 'Could not move the timings');
    }
  };

  const markVerse = async (verse: VerseProgress, state: 'in_progress' | 'done') => {
    await api.saveProgress(
      songId,
      verse.verseIdx,
      state === 'done' ? verse.lineCount : verse.linesDone,
      state,
    );
    song.reload();
  };

  const detail = song.data;
  const verses = detail?.progress ?? [];
  const versesDone = verses.filter((v) => v.state === 'done').length;
  const troubleVerses = useMemo(() => {
    const set = new Set<number>();
    for (const line of lines) if (troubleLineIds.has(line.id)) set.add(line.verseIdx);
    return set;
  }, [lines, troubleLineIds]);

  const activeVerse = activeIdx >= 0 ? lines[activeIdx]?.verseIdx : undefined;

  const jumpToVerse = (verseIdx: number) => {
    setFocusVerse(verseIdx);
    const first = lines.find((l) => l.verseIdx === verseIdx);
    if (first?.timeMs !== null && first?.timeMs !== undefined) {
      player?.seekMs(first.timeMs);
      player?.play();
    } else {
      document
        .getElementById(`verse-${verseIdx}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const rail = useRail(
    <div className="rail-card">
      <div className="cap">
        Sections · {versesDone}/{verses.length} done
      </div>
      <div className="spine">
        {verses.map((verse) => (
          <button
            key={verse.verseIdx}
            className={verse.verseIdx === (focusVerse ?? activeVerse) ? 'on' : ''}
            onClick={() => jumpToVerse(verse.verseIdx)}
          >
            <span className={`n${verse.state === 'done' ? ' done' : ''}`}>
              {verse.state === 'done' ? '✓' : verse.verseIdx + 1}
            </span>
            <span>Section {verse.verseIdx + 1}</span>
            {verse.verseIdx === activeVerse && (
              <span style={{ marginLeft: 'auto', fontSize: 10 }}>▶ now</span>
            )}
            {verse.verseIdx !== activeVerse && troubleVerses.has(verse.verseIdx) && (
              <span className="flag" />
            )}
          </button>
        ))}
      </div>
      <button className="forest" onClick={() => setStage(true)} disabled={!detail?.youtubeId}>
        ◱ Stage mode <span className="kbd">⇧S</span>
      </button>
    </div>,
  );

  useCommands([
    { id: 'song-study', label: 'Study this song', where: 'Song', run: () => onStudy(songId) },
    {
      id: 'song-stage',
      label: 'Stage mode',
      hint: '⇧S',
      where: 'Song',
      run: () => setStage(true),
    },
    {
      id: 'song-romaji',
      label: showRomaji ? 'Hide romaji' : 'Show romaji',
      where: 'Song',
      run: () => setShowRomaji((v) => !v),
    },
    {
      id: 'song-explain',
      label:
        segmented >= (detail?.lineCount ?? 0) && (detail?.lineCount ?? 0) > 0
          ? 'Re-explain every line with AI'
          : 'Explain the lines with AI',
      where: 'Song',
      run: () => void runAnalysis(segmented >= (detail?.lineCount ?? 0)),
    },
    {
      id: 'song-retime',
      label: detail?.synced ? 'Re-time the lines by tapping' : 'Tap to time the lines',
      where: 'Song',
      run: startSync,
    },
    {
      id: 'song-offset',
      label: 'Move all the timings earlier or later',
      hint: 'lyrics from another cut',
      where: 'Song',
      run: () => setEditing('offset'),
    },
    {
      id: 'song-reading',
      label: 'Fix the title reading',
      where: 'Song',
      run: () => setEditing('reading'),
    },
    {
      id: 'song-context',
      label: 'Edit the notes the AI gets',
      where: 'Song',
      run: () => setEditing('context'),
    },
    {
      id: 'song-video',
      label: detail?.youtubeId ? 'Change the video link' : 'Attach a video link',
      where: 'Song',
      run: openVideoEditor,
    },
    { id: 'song-back', label: 'Back to the library', where: 'Song', run: onBack },
  ]);

  // Only the very first load may take over the page: a background refresh keeps
  // the lesson on screen, video player included.
  if (song.loading && !detail) return <p className="muted">Loading lesson…</p>;
  if (song.error && !detail) return <div className="error">{song.error}</div>;
  if (!detail) return null;

  const shownLines = focusVerse === null ? lines : lines.filter((l) => l.verseIdx === focusVerse);
  const durationMs = detail.durationMs ?? (lines.at(-1)?.timeMs ?? 0) + 8000;

  return (
    // Everything on this page that quotes the song's Japanese — grammar notes,
    // explanations, generated examples — is annotated with the song's own readings
    // rather than the dictionary's, so a note can never contradict the line above it.
    <SongReadings songId={songId}>
    <div className="song-page">
      {rail}
      <div className="stage-bar" ref={barRef}>
        {detail.youtubeId ? (
          <div className="screen">
            <YouTubePlayer
              videoId={detail.youtubeId}
              onReady={setPlayer}
              onTime={setPositionMs}
              onPlayingChange={setPlaying}
              scrub={false}
            />
          </div>
        ) : (
          <div className="screen" style={{ padding: 14, width: 240 }}>
            <div className="cap" style={{ color: 'var(--sage-dim)' }}>
              no video yet
            </div>
            <button className="forest small" onClick={openVideoEditor}>
              Attach one
            </button>
          </div>
        )}

        <div className="meta">
          <div className="row" style={{ gap: 10, alignItems: 'baseline' }}>
            <span className="title">
              {detail.titleFurigana && detail.titleFurigana.length > 0 ? (
                <Furigana segments={detail.titleFurigana} />
              ) : (
                detail.title
              )}
            </span>
            <span className="mono" style={{ fontSize: 12 }}>
              {detail.titleRomaji ? `${detail.titleRomaji} · ` : ''}
              {detail.artist} · {detail.lineCount} lines
            </span>
            {detail.synced && <span className="tag">TIMED</span>}
            {detail.analyzed && <span className="tag">EXPLAINED</span>}
            {/* The palette carries this too, but a wrong video is something you
                notice while looking at it, so the control lives next to it. */}
            {detail.youtubeId && (
              <button
                className="forest small"
                onClick={openVideoEditor}
                title="Point this song at a different YouTube video"
              >
                ↺ Change video
              </button>
            )}
            {detail.synced && (
              <button
                className="forest small"
                onClick={() => setEditing('offset')}
                title="Lines arriving early or late against this video? Move them all at once."
              >
                ◷ Timings
              </button>
            )}
          </div>

          <div className="scrub">
            <span className="t">{clock(positionMs)}</span>
            <button
              className="track"
              disabled={!player}
              onClick={(e) => {
                if (!player || durationMs <= 0) return;
                const box = e.currentTarget.getBoundingClientRect();
                player.seekMs(((e.clientX - box.left) / box.width) * durationMs);
              }}
            >
              <div className="rail" />
              <div
                className="fill"
                style={{ width: durationMs > 0 ? `${(positionMs / durationMs) * 100}%` : '0%' }}
              />
              <div
                className="knob"
                style={{ left: durationMs > 0 ? `${(positionMs / durationMs) * 100}%` : '0%' }}
              />
              {verses.map((verse) => {
                const first = lines.find((l) => l.verseIdx === verse.verseIdx);
                if (!first?.timeMs || durationMs <= 0) return null;
                return (
                  <div
                    key={verse.verseIdx}
                    className="mark"
                    style={{ left: `${(first.timeMs / durationMs) * 100}%` }}
                  />
                );
              })}
            </button>
            <span className="t">{clock(durationMs)}</span>
          </div>

          {syncing ? (
            <div className="sync-hint">
              <b>Tap along:</b>
              <span>
                press <span className="kbd">space</span> the moment line{' '}
                <b>{Math.min(syncIdx + 1, lines.length)}</b> of {lines.length} starts
              </span>
              <button className="forest" onClick={tapSync} disabled={syncIdx >= lines.length}>
                Tap
              </button>
              <button className="forest" onClick={finishSync}>
                Save {pendingTimings.length} timings
              </button>
              <button
                className="forest quiet"
                onClick={() => {
                  setSyncing(false);
                  setPendingTimings([]);
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <div className="controls">
              <button className="lime" onClick={() => player?.toggle()} disabled={!player}>
                {playing ? '❚❚ Pause' : '▶ Play'}
              </button>
              <button
                className="forest"
                onClick={() => setStage(true)}
                disabled={!detail.youtubeId}
                title={detail.youtubeId ? undefined : 'Stage mode needs a video'}
              >
                ◱ Stage <span className="kbd">⇧S</span>
              </button>
              <span className="spacer" />
              <span className="cap" style={{ color: 'var(--sage-deep)' }}>
                ⌘K for everything else
              </span>
              <button className="study" onClick={() => onStudy(songId)}>
                Study this song ▸
              </button>
            </div>
          )}
        </div>
      </div>

      {analysis?.state === 'running' &&
        (() => {
          // The two phases have their own counters, so the bar reports whichever
          // one is running rather than a total that would jump when they swap.
          const kanji = analysis.phase === 'kanji';
          const done = Math.min(
            kanji ? analysis.kanjiDone : analysis.done,
            kanji ? analysis.kanjiTotal : analysis.total,
          );
          const total = kanji ? analysis.kanjiTotal : analysis.total;
          return (
            <div className="analysis-bar" style={{ margin: '14px 26px 0' }}>
              <span className="spinner" />
              <span>
                {kanji ? 'Writing kanji mnemonics' : 'Explaining line by line'} — {done}/{total}
              </span>
              <div className="track">
                <div style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }} />
              </div>
              <span className="faint" style={{ fontSize: 13 }}>
                {kanji
                  ? 'The lines are done. Each character gets a hook for its meaning and one for its sound.'
                  : 'Lines appear as they finish. Readings are checked against the dictionary.'}
              </span>
            </div>
          );
        })()}

      {analyzeMsg && (
        <div className="notice" style={{ margin: '14px 26px 0' }}>
          {analyzeMsg}
        </div>
      )}

      {editing && (
        <div style={{ margin: '14px 26px 0' }}>
          {editing === 'reading' && (
            <ReadingEditor
              title={detail.title}
              current={detail.titleRomaji ?? ''}
              onSave={async (reading) => {
                await api.updateSong(songId, { titleReading: reading });
                setEditing(null);
                song.reload();
              }}
              onCancel={() => setEditing(null)}
            />
          )}
          {editing === 'context' && (
            <ContextEditor
              value={detail.context}
              onSave={async (text) => {
                await api.updateSong(songId, { context: text });
                song.reload();
              }}
              onClose={() => setEditing(null)}
            />
          )}
          {editing === 'video' && (
            <div className="card stack">
              <div className="cap">
                {detail.youtubeId
                  ? `currently playing youtube.com/watch?v=${detail.youtubeId} — paste another link or id`
                  : 'paste a youtube link — unlocks sing-along, stage mode and listening cards'}
              </div>
              <div className="row">
                <input
                  placeholder="https://youtube.com/watch?v=… or the 11-character id"
                  value={videoInput}
                  onChange={(e) => setVideoInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void attachVideo();
                    if (e.key === 'Escape') setEditing(null);
                  }}
                  style={{ flex: 1, minWidth: 240 }}
                  autoFocus
                />
                <button
                  className="primary"
                  onClick={attachVideo}
                  disabled={!videoInput.trim() || videoInput.trim() === detail.youtubeId}
                >
                  {detail.youtubeId ? 'Change video' : 'Attach'}
                </button>
                <button className="ghost" onClick={() => setEditing(null)}>
                  Cancel
                </button>
              </div>
              {detail.synced && (
                <span className="faint" style={{ fontSize: 13 }}>
                  The line timings stay as they are — if the new video starts at a different point,
                  move them all with ◷ Timings.
                </span>
              )}
            </div>
          )}
          {editing === 'offset' && (
            <OffsetEditor
              firstLineMs={lines.find((l) => l.timeMs !== null)?.timeMs ?? null}
              positionMs={positionMs}
              onShift={shiftTimings}
              onClose={() => setEditing(null)}
            />
          )}
        </div>
      )}

      <div className="song-body">
        <div className="lyrics-pane">
          <div className="legend">
            <span className="cap">
              {focusVerse === null
                ? 'every section'
                : `section ${focusVerse + 1} only`}
            </span>
            {focusVerse !== null && (
              <button className="ghost small" onClick={() => setFocusVerse(null)}>
                Show the whole song
              </button>
            )}
            <span className="spacer" />
            <span className="cap">colour = what it does</span>
            {ROLE_CATEGORIES.map((cat) => (
              <span
                key={cat.key}
                className={`mono c${cat.colorIdx}`}
                style={{ fontSize: 10, fontWeight: 700 }}
              >
                {cat.label}
              </span>
            ))}
          </div>

          <div className="legend" style={{ marginBottom: 8 }}>
            <span className="cap">bar underneath = how well you know it</span>
            <span className="swatch">
              <span className="b" />
              <span className="cap">new</span>
            </span>
            <span className="swatch">
              <span className="b">
                <span style={{ width: '45%' }} />
              </span>
              <span className="cap">shaky</span>
            </span>
            <span className="swatch">
              <span className="b">
                <span style={{ width: '100%' }} />
              </span>
              <span className="cap">solid</span>
            </span>
            <span className="swatch">
              <span className="b" style={{ background: 'var(--coral)' }} />
              <span className="cap" style={{ color: 'var(--coral-text)' }}>
                trouble
              </span>
            </span>
          </div>

          {verses
            .filter((verse) => focusVerse === null || verse.verseIdx === focusVerse)
            .map((verse) => (
              <div key={verse.verseIdx} id={`verse-${verse.verseIdx}`}>
                <div className="verse-head">
                  <span className="cap">
                    Section {verse.verseIdx + 1} · {verse.lineCount} lines
                  </span>
                  {verse.state === 'done' && <span className="tag new">DONE</span>}
                  <button
                    className="ghost small"
                    onClick={() =>
                      markVerse(verse, verse.state === 'done' ? 'in_progress' : 'done')
                    }
                  >
                    {verse.state === 'done' ? 'Mark unfinished' : 'Mark section done'}
                  </button>
                </div>

                {shownLines
                  .filter((line) => line.verseIdx === verse.verseIdx)
                  .map((line) => {
                    const at = lines.indexOf(line);
                    return (
                      <LyricLine
                        key={line.id}
                        line={line}
                        lineNumber={at + 1}
                        songId={songId}
                        active={at === activeIdx}
                        past={activeIdx >= 0 && at < activeIdx}
                        nextToTap={syncing && at === syncIdx}
                        trouble={troubleLineIds.has(line.id)}
                        lapses={
                          trouble.data?.lines.find((l) => l.lineId === line.id)?.lapses ?? 0
                        }
                        showRomaji={showRomaji}
                        offlineReadings={offlineReadings}
                        masteryOf={masteryOf}
                        selectedChunk={selectedChunk?.lineId === line.id ? selectedChunk.idx : null}
                        onSelectChunk={(idx) =>
                          setSelectedChunk(idx === null ? null : { lineId: line.id, idx })
                        }
                        selectedToken={
                          selectedToken?.lineId === line.id ? selectedToken.idx : null
                        }
                        onSelectToken={(idx) =>
                          setSelectedToken(idx === null ? null : { lineId: line.id, idx })
                        }
                        enrich={enrich}
                        onEnrolled={words.reload}
                        onSeek={
                          line.timeMs !== null && player
                            ? () => {
                                player.seekMs(line.timeMs as number);
                                player.play();
                              }
                            : undefined
                        }
                        innerRef={at === activeIdx ? activeLineRef : undefined}
                      />
                    );
                  })}
              </div>
            ))}
        </div>

        <WordGarden
          words={words.data?.words ?? []}
          onChanged={words.reload}
        />
      </div>

      {stage && (
        <Stage
          title={detail.title}
          artist={detail.artist}
          lines={lines}
          activeIdx={activeIdx}
          player={player}
          playing={playing}
          positionMs={positionMs}
          durationMs={durationMs}
          hooksJob={
            analysis?.state === 'running' && analysis.phase === 'kanji'
              ? { done: analysis.kanjiDone, total: analysis.kanjiTotal }
              : null
          }
          onClose={() => setStage(false)}
        />
      )}
    </div>
    </SongReadings>
  );
}
