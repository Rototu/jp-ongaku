import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type ApiError, type KanjiInfo } from '../lib/api';
import { Furigana } from '../components/Furigana';
import { clock } from '../components/bits';
import type { PlayerHandle } from '../components/YouTubePlayer';
import type { AiChunk, SongLine } from '../../../shared/types';

/**
 * Stage mode — the chrome drops and one line fills the screen.
 *
 * Everything here serves singing along: the line is huge, the neighbours are
 * dimmed rather than gone, and loop keeps the same three seconds coming back
 * until the mouth catches up. Hovering a word pauses playback and opens its
 * meaning with the kanji behind it; moving off resumes, so looking something up
 * never costs you your place.
 *
 * The literal reading and the line's grammar notes stay on screen the whole
 * time, in a band along the bottom. They are the two things you would otherwise
 * have to leave the stage to read, and needing to hover for them would mean
 * stopping the song to learn why the line is shaped the way it is.
 *
 * Shadowing is a level meter and nothing else: the microphone is read in the
 * browser, never recorded and never sent anywhere. It exists to count the lines
 * you actually sang.
 */

const LOOP_TIMES = 3;

export function Stage({
  title,
  artist,
  lines,
  activeIdx,
  player,
  playing,
  positionMs,
  durationMs,
  hooksJob,
  onClose,
}: {
  title: string;
  artist: string;
  lines: SongLine[];
  activeIdx: number;
  player: PlayerHandle | null;
  playing: boolean;
  /** Live playback position, polled from the player. */
  positionMs: number;
  durationMs: number | null;
  /**
   * Progress of the song-wide mnemonic pass, when one is running. The stage
   * covers the page that would otherwise report it, so it has to say so itself.
   */
  hooksJob: { done: number; total: number } | null;
  onClose: () => void;
}) {
  /** Which line the stage is showing. Follows playback until the user steps. */
  const [manualIdx, setManualIdx] = useState<number | null>(null);
  const idx = manualIdx ?? Math.max(0, activeIdx);
  const line = lines[idx] ?? null;

  const [hovered, setHovered] = useState<number | null>(null);
  /** A clicked word stays open, hands-free, until playback resumes. */
  const [pinned, setPinned] = useState<number | null>(null);
  /** One switch for every word of English on the stage: translation, literal, notes. */
  const [showEnglish, setShowEnglish] = useState(true);
  const [looping, setLooping] = useState(false);
  const [loopsLeft, setLoopsLeft] = useState(LOOP_TIMES);
  const [kanji, setKanji] = useState<Record<string, KanjiInfo[]>>({});
  /** Characters whose hooks are being written right now, for the waiting note. */
  const [writing, setWriting] = useState<Set<string>>(new Set());
  /** True once the band has grown into the next-line preview's row. */
  const [bandOverflows, setBandOverflows] = useState(false);

  const resumeAfterHover = useRef(false);
  /** Set once the server says no model is configured, so we stop asking. */
  const noMnemonics = useRef(false);
  const bandRef = useRef<HTMLDivElement | null>(null);
  const nextLineRef = useRef<HTMLDivElement | null>(null);
  const nowRef = useRef<HTMLDivElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const transportRef = useRef<HTMLDivElement | null>(null);

  const start = line?.timeMs ?? null;
  const end = lines[idx + 1]?.timeMs ?? (durationMs ?? null);

  // --- hovering a word pauses, leaving resumes ------------------------------
  const hover = (chunkIdx: number | null) => {
    // A pinned word owns the popover: the mouse is free to go anywhere, which is
    // the point of having clicked it.
    if (pinned !== null) return;
    setHovered(chunkIdx);
    if (chunkIdx !== null) {
      if (playing) {
        resumeAfterHover.current = true;
        player?.pause();
      }
    } else if (resumeAfterHover.current) {
      resumeAfterHover.current = false;
      player?.play();
    }
  };

  /**
   * Click pins the word open; clicking it again lets go without resuming.
   *
   * Pinning also freezes the line on screen. The player takes a moment to
   * acknowledge the pause, and if playback crossed into the next line in that
   * gap the pin would be pointing at a word that is no longer there.
   */
  const pin = (chunkIdx: number) => {
    if (pinned === chunkIdx) {
      setPinned(null);
      setHovered(null);
      return;
    }
    resumeAfterHover.current = false;
    setManualIdx(idx);
    setPinned(chunkIdx);
    setHovered(chunkIdx);
    player?.pause();
  };

  /**
   * Resuming the song is what closes a pinned word — pressing play means you are
   * done reading and want the line back.
   *
   * The trigger is the transition into playing, not the state: clicking a word
   * while the song plays pins it and asks the player to pause, and the player
   * reports that a moment later. Reacting to `playing === true` would throw the
   * pin away in that gap.
   */
  const wasPlaying = useRef(playing);
  useEffect(() => {
    const resumed = playing && !wasPlaying.current;
    wasPlaying.current = playing;
    if (resumed) {
      setPinned(null);
      setHovered(null);
      // Hand the line back to playback.
      setManualIdx(null);
    }
  }, [playing]);

  // A pin belongs to one line's words, so moving line lets it go.
  useEffect(() => {
    setPinned(null);
    setHovered(null);
  }, [idx]);

  // --- loop the current line ------------------------------------------------
  useEffect(() => {
    if (!looping || start === null || end === null || !player) return;
    const timer = setInterval(() => {
      const now = player.currentMs();
      if (now >= end - 60) {
        if (loopsLeft <= 1) {
          setLooping(false);
          setLoopsLeft(LOOP_TIMES);
          return;
        }
        setLoopsLeft((n) => n - 1);
        player.seekMs(start);
      }
    }, 120);
    return () => clearInterval(timer);
  }, [looping, start, end, loopsLeft, player]);

  const step = useCallback(
    (delta: number) => {
      const next = Math.max(0, Math.min(lines.length - 1, idx + delta));
      setManualIdx(next);
      const at = lines[next]?.timeMs;
      if (at !== null && at !== undefined) player?.seekMs(at);
    },
    [idx, lines, player],
  );

  // Playback moving on its own hands control back to it.
  useEffect(() => {
    if (manualIdx !== null && activeIdx === manualIdx) setManualIdx(null);
  }, [activeIdx, manualIdx]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const isSpace = e.code === 'Space' || e.key === ' ';
      if (e.key === 'Escape') onClose();
      else if (isSpace) {
        e.preventDefault();
        player?.toggle();
      } else if (e.key.toLowerCase() === 'l') {
        setLooping((v) => !v);
        setLoopsLeft(LOOP_TIMES);
        if (start !== null) player?.seekMs(start);
      } else if (e.key === 'ArrowRight') step(1);
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key.toLowerCase() === 't') setShowEnglish((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, player, step, start]);

  const chunks = useMemo(() => renderable(line), [line]);
  const hoveredChunk = hovered !== null ? chunks[hovered] : null;

  /**
   * Every kanji in the shown word, from KANJIDIC2, with its memory hooks.
   *
   * `/lookup` already answers for each character of the term, so 目覚めたら costs
   * one request and comes back with both 目 and 覚 — a word is not explained by
   * its first character alone. Cached per word, so re-hovering is free.
   *
   * The hooks are written by the model the first time a character is met and
   * cached against the character itself, so the second word containing it is
   * free too. They arrive after the readings do, which is why they are merged in
   * separately rather than waited for: readings should never be held back behind
   * a model request.
   */
  useEffect(() => {
    const term = hoveredChunk?.text;
    if (!term || term in kanji || !/[一-龯]/.test(term)) return;
    let cancelled = false;
    void api
      .lookup(term)
      .then(async (res) => {
        if (!cancelled) setKanji((prev) => ({ ...prev, [term]: res.kanji }));

        const missing = res.kanji.filter((info) => !info.mnemonic).map((info) => info.char);
        if (missing.length === 0 || noMnemonics.current) return;
        // Marked per character rather than per hover, so the row itself can say
        // that its hook is on the way — and so it still says so if the mouse has
        // moved on and come back before the answer lands.
        setWriting((prev) => new Set([...prev, ...missing]));
        try {
          const { mnemonics } = await api.kanjiMnemonics(missing);
          // Merged whatever the mouse is doing by now: the hooks belong to the
          // characters, not to this hover, and the request has been paid for.
          setKanji((prev) => ({
            ...prev,
            [term]: (prev[term] ?? res.kanji).map((info) =>
              mnemonics[info.char] ? { ...info, mnemonic: mnemonics[info.char] } : info,
            ),
          }));
        } catch (err) {
          // 409 is "no AI provider configured". Nothing will change mid-session,
          // so stop asking rather than failing once per word.
          if ((err as ApiError).status === 409) noMnemonics.current = true;
        } finally {
          setWriting((prev) => {
            const next = new Set(prev);
            for (const char of missing) next.delete(char);
            return next;
          });
        }
      })
      .catch(() => {
        if (!cancelled) setKanji((prev) => ({ ...prev, [term]: [] }));
      });
    return () => {
      cancelled = true;
    };
  }, [hoveredChunk, kanji]);

  /**
   * Keeps the word popover clear of the transport.
   *
   * It hangs below the line, so how much room it has depends on where the line
   * ended up — a fixed `max-height` either wastes space or, once the kanji column
   * carries mnemonics, buries the Play button that a pinned word tells you to
   * press. Measured instead, and the popover scrolls inside whatever is left.
   */
  useLayoutEffect(() => {
    const pop = popRef.current;
    const transport = transportRef.current;
    if (!pop || !transport) return;
    const fit = () => {
      const room = transport.getBoundingClientRect().top - pop.getBoundingClientRect().top - 12;
      // Never squeeze it to nothing: below this it is better to overlap than to
      // show two scrolled lines of a definition.
      pop.style.maxHeight = `${Math.max(140, Math.round(room))}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [hoveredChunk, kanji, idx]);

  const literal = line?.analysis?.literal?.trim() ?? '';
  const notes = line?.analysis?.notes ?? [];
  const bandShown = showEnglish && (literal !== '' || notes.length > 0);

  /**
   * Whether the band has grown up into the line above it.
   *
   * Geometric rather than a height compared against the reserve, so it stays
   * right however the strip is sized: the question is only ever "is the band
   * touching something". It is answered against the lowest thing actually on
   * screen — the next-line preview normally, the line block itself once the
   * preview is gone at short viewport heights, where the preview keeps a DOM node
   * but no box.
   *
   * What this drives must not change what it measures, or the two would fight:
   * the preview is hidden with `visibility`, which keeps its box.
   */
  useEffect(() => {
    const band = bandRef.current;
    if (!band) {
      setBandOverflows(false);
      return;
    }
    const measure = () => {
      const boxes = [nextLineRef.current, nowRef.current]
        .map((el) => el?.getBoundingClientRect())
        .filter((box): box is DOMRect => !!box && box.height > 0);
      if (boxes.length === 0) {
        setBandOverflows(false);
        return;
      }
      const lowest = Math.max(...boxes.map((box) => box.bottom));
      // A few pixels of box overlap are invisible — a line box carries that much
      // slack under its glyphs. Only real contact costs the preview its place.
      const SLACK = 8;
      setBandOverflows(band.getBoundingClientRect().top < lowest - SLACK);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(band);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [idx, bandShown, literal, notes.length]);

  /**
   * Where the scrub sits: real playback, not the current line's timestamp.
   *
   * A line's timestamp only moves when the line does, so the bar used to sit
   * still for the length of a line and then jump. With no player attached there
   * is no playback to report, and the line's own time is the only thing the bar
   * can honestly mean.
   */
  const scrubMs = player ? Math.max(0, positionMs) : (start ?? 0);
  const total = durationMs ?? 0;

  return (
    <div className={`stage${bandOverflows ? ' band-over' : ''}`}>
      <div className="glow a" />
      <div className="glow b" />

      <div className="top">
        <span className="name">{title}</span>
        <span className="mono">
          {artist} · line {idx + 1} of {lines.length}
          {line ? ` · section ${line.verseIdx + 1}` : ''}
        </span>
        <span className="spacer" />
        {hooksJob && (
          <span
            className="working"
            title="Every kanji in this song is being given a hook for its meaning and one for its sound. Words still open normally while it runs."
          >
            <span className="blip" />
            kanji hooks {hooksJob.total > 0 ? `${hooksJob.done}/${hooksJob.total}` : ''}
          </span>
        )}
        <ShadowMeter activeLineIdx={idx} playing={playing} />
        <span className="cap" style={{ color: '#5f8a6f' }}>
          ESC TO LEAVE THE STAGE
        </span>
      </div>

      <div className="stack-lines">
        {idx > 0 && (
          <div className="neighbour">
            <Furigana segments={lineFurigana(lines[idx - 1])} />
          </div>
        )}

        <div className="now" ref={nowRef}>
          {/* The pill and the popover are overlays on purpose: hovering a word
              must not move the line the eye is already reading, so neither of
              them takes part in the layout. */}
          <div className="line-wrap">
            {hoveredChunk && (
              <div className="paused-pill">
                <span style={{ width: 7, height: 7, borderRadius: 1, background: 'var(--lime)' }} />
                {pinned !== null ? 'PINNED — PRESS PLAY WHEN YOU’RE DONE' : 'AUTO-PAUSED — HOVERING A WORD'}
              </div>
            )}

            <div className="big" onMouseLeave={() => hover(null)}>
              {chunks.map((chunk, i) => (
                <span
                  key={i}
                  className={`w${hovered === i ? ' on' : i % 2 === 1 ? ' alt' : ''}${
                    pinned === i ? ' pinned' : ''
                  }`}
                  onMouseEnter={() => hover(i)}
                  onClick={() => pin(i)}
                >
                  <Furigana segments={chunk.furigana} />
                </span>
              ))}
            </div>

            {hoveredChunk && (
              <div className="stage-pop" ref={popRef}>
              <div className="main-col">
                <div className="row" style={{ gap: 9, alignItems: 'baseline' }}>
                  <span className="term">
                    <Furigana segments={hoveredChunk.furigana} />
                  </span>
                  <span className="mono" style={{ fontSize: 11.5, color: 'var(--sage-dim)' }}>
                    {hoveredChunk.romaji}
                  </span>
                  {hoveredChunk.role && <span className="tag">{hoveredChunk.role}</span>}
                </div>
                {hoveredChunk.meaning && <div className="gloss">{hoveredChunk.meaning}</div>}
                {hoveredChunk.explanation && (
                  <div className="expl">{hoveredChunk.explanation}</div>
                )}
              </div>

              {(() => {
                const chars = kanji[hoveredChunk.text] ?? [];
                if (chars.length === 0) return null;
                return (
                  <>
                    <div className="rule" />
                    <div className="kanji-col">
                      {chars.map((info) => (
                        <div className="kanji-row" key={info.char}>
                          <span className="glyph">{info.char}</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="cap" style={{ color: '#5f8a6f' }}>
                              {info.meanings.slice(0, 3).join(' · ')}
                            </div>
                            {/* The readings are the content; "on" and "kun" only say
                                which is which, so they are labels and read like it. */}
                            <div className="yomi">
                              {info.on.length > 0 && (
                                <span>
                                  <span className="lbl">on</span>
                                  {info.on.slice(0, 3).join('、')}
                                </span>
                              )}
                              {info.kun.length > 0 && (
                                <span>
                                  <span className="lbl">kun</span>
                                  {info.kun.slice(0, 3).join('、')}
                                </span>
                              )}
                              {info.strokes ? (
                                <span className="lbl">{info.strokes} strokes</span>
                              ) : null}
                            </div>
                            {info.mnemonic && (
                              <div className="mnemo">
                                <div>
                                  <span className="lbl">means</span>
                                  {info.mnemonic.meaning}
                                </div>
                                <div>
                                  <span className="lbl">
                                    sounds
                                    {info.mnemonic.readingKey ? ` · ${info.mnemonic.readingKey}` : ''}
                                  </span>
                                  {info.mnemonic.reading}
                                </div>
                              </div>
                            )}
                            {!info.mnemonic && (writing.has(info.char) || hooksJob) && (
                              <div className="mnemo waiting">
                                <span className="blip" />
                                writing a hook for this one…
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                      <div className="cap" style={{ color: 'var(--sage-deep)' }}>
                        KANJIDIC2 ·{' '}
                        {pinned !== null
                          ? 'PINNED — PRESS PLAY TO CARRY ON'
                          : 'CLICK TO PIN · MOVE OFF TO RESUME'}
                      </div>
                    </div>
                  </>
                );
                })()}
              </div>
            )}
          </div>

          {line?.tokens && (
            <div className="romaji-line">
              {chunks.map((c) => c.romaji).filter(Boolean).join(' ')}
            </div>
          )}

          {showEnglish && line?.analysis?.translation && (
            <div className="en">{line.analysis.translation}</div>
          )}
        </div>

        {idx + 1 < lines.length && (
          <div className="neighbour" ref={nextLineRef}>
            <Furigana segments={lineFurigana(lines[idx + 1])} />
          </div>
        )}

        {bandShown && (
          <div ref={bandRef} className={`band${hoveredChunk ? ' dim' : ''}`}>
            {literal && (
              <div className="col">
                <span className="cap">literally</span>
                <div className="lit">{literal}</div>
              </div>
            )}
            {notes.length > 0 && (
              <div className="col">
                <span className="cap">grammar</span>
                {notes.map((note, i) => (
                  <div className="note" key={note.key || i}>
                    <b>{note.pattern}</b> {note.explanation}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="transport" ref={transportRef}>
        <div className="scrub">
          <span className="t">{clock(scrubMs)}</span>
          <div className="track" role="presentation">
            <div className="rail" />
            <div
              className="fill"
              style={{
                width: total > 0 ? `${Math.min(100, (scrubMs / total) * 100)}%` : '0%',
              }}
            />
            {looping && start !== null && end !== null && total > 0 && (
              <div
                className="loop-zone"
                style={{
                  left: `${(start / total) * 100}%`,
                  width: `${Math.max(1, ((end - start) / total) * 100)}%`,
                }}
              />
            )}
          </div>
          <span className="t">{clock(total)}</span>
        </div>

        <div className="buttons">
          <button className="stage-btn" onClick={() => step(-1)}>
            ◂◂ Line
          </button>
          <button className="big-btn" onClick={() => player?.toggle()}>
            {playing ? '❚❚ Pause' : '▶ Play'}
          </button>
          <button className="stage-btn" onClick={() => step(1)}>
            Line ▸▸
          </button>
          <span className="divider" />
          <button
            className={`stage-btn${looping ? ' on' : ''}`}
            onClick={() => {
              setLooping((v) => !v);
              setLoopsLeft(LOOP_TIMES);
              if (start !== null) player?.seekMs(start);
            }}
            disabled={start === null}
            title={start === null ? 'This song has no timings yet' : undefined}
          >
            ↻ Loop ×{looping ? loopsLeft : LOOP_TIMES} <span className="kbd">L</span>
          </button>
          <button className="stage-btn" onClick={() => setShowEnglish((v) => !v)}>
            {showEnglish ? 'Hide English' : 'Show English'} <span className="kbd">T</span>
          </button>
          <button className="stage-btn" onClick={onClose}>
            Leave the stage
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The microphone level, and how many lines you sang over.
 *
 * Off until asked for. When on, audio never leaves the AnalyserNode: no
 * recording is kept, nothing is uploaded, and the only thing derived from it is
 * "was there sound while this line was on screen".
 */
function ShadowMeter({ activeLineIdx, playing }: { activeLineIdx: number; playing: boolean }) {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [levels, setLevels] = useState<number[]>([0, 0, 0, 0, 0, 0]);
  const [sung, setSung] = useState<Set<number>>(new Set());
  const [heard, setHeard] = useState(0);
  const lineRef = useRef(activeLineIdx);
  lineRef.current = activeLineIdx;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    let cancelled = false;

    void navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((granted) => {
        if (cancelled) {
          granted.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = granted;
        ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(granted);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        const data = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          analyser.getByteFrequencyData(data);
          const band = Math.floor(data.length / 6);
          const next: number[] = [];
          let peak = 0;
          for (let b = 0; b < 6; b++) {
            let sum = 0;
            for (let i = b * band; i < (b + 1) * band; i++) sum += data[i];
            const value = sum / band / 255;
            peak = Math.max(peak, value);
            next.push(value);
          }
          setLevels(next);
          setHeard(peak);
          // A line counts as sung once there was real signal while it was up.
          if (peak > 0.16 && playingRef.current) {
            const at = lineRef.current;
            setSung((prev) => (prev.has(at) ? prev : new Set(prev).add(at)));
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => {
        if (!cancelled) {
          setError('No microphone — shadowing needs one.');
          setOn(false);
        }
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
    };
  }, [on]);

  if (!on) {
    return (
      <button className="stage-btn" onClick={() => setOn(true)} title={error ?? undefined}>
        🎤 {error ? 'Shadowing unavailable' : 'Shadow'}
      </button>
    );
  }

  return (
    <div className="shadow-meter" style={{ margin: 0 }}>
      <div className="inner">
        <span className="cap" style={{ color: 'var(--lime)' }}>
          Shadowing
        </span>
        <div className="eq">
          {levels.map((level, i) => (
            <span
              key={i}
              style={{
                height: `${Math.max(12, level * 100)}%`,
                background: level > 0.4 ? 'var(--lime)' : 'var(--leaf)',
              }}
            />
          ))}
        </div>
        <span style={{ fontSize: 13, color: 'var(--sage)' }}>
          {sung.size > 0
            ? `you sang ${sung.size} line${sung.size === 1 ? '' : 's'}${heard > 0.5 ? ' · loud' : ''}`
            : 'sing — nothing is recorded'}
        </span>
        <button className="stage-btn" onClick={() => setOn(false)}>
          Stop
        </button>
      </div>
    </div>
  );
}

/** One renderable piece of a line: AI chunks when they exist, tokens otherwise. */
interface StagePiece {
  text: string;
  romaji: string;
  furigana: { text: string; ruby: string }[];
  role: string;
  meaning: string;
  explanation: string;
}

function renderable(line: SongLine | null): StagePiece[] {
  if (!line) return [];
  const chunks = line.analysis?.chunks ?? [];
  if (chunks.length > 0) {
    return chunks.map((chunk: AiChunk) => ({
      text: chunk.text,
      romaji: chunk.romaji,
      furigana: chunk.furigana.length > 0 ? chunk.furigana : [{ text: chunk.text, ruby: '' }],
      role: chunk.role,
      meaning: chunk.meaning,
      explanation: chunk.explanation,
    }));
  }
  return line.tokens
    .filter((token) => !token.filler)
    .map((token) => ({
      text: token.surface,
      romaji: token.romaji,
      furigana: token.furigana.length > 0 ? token.furigana : [{ text: token.surface, ruby: '' }],
      role: token.pos,
      meaning: token.entry?.senses[0]?.glosses.slice(0, 2).join('; ') ?? '',
      explanation: '',
    }));
}

function lineFurigana(line: SongLine | undefined): { text: string; ruby: string }[] {
  if (!line) return [];
  const chunks = line.analysis?.chunks ?? [];
  if (chunks.length > 0) return chunks.flatMap((c) => c.furigana);
  return line.tokens.flatMap((t) =>
    t.furigana.length > 0 ? t.furigana : [{ text: t.surface, ruby: '' }],
  );
}

