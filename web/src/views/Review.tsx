import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type GradePreview } from '../lib/api';
import { Furigana } from '../components/Furigana';
import { RubyText } from '../components/RubyText';
import { YouTubePlayer, type PlayerHandle } from '../components/YouTubePlayer';
import { Ring, interval, masteryOf } from '../components/bits';
import type { Card, CardKind, CardReasonKind, ClozeChoice } from '../../../shared/types';

/**
 * The review runner: one card on screen, nothing else.
 *
 * Keyboard-first — space reveals, 1-4 grade — because a mouse trip per card is
 * what makes a session feel like a chore. Each grade button says what it will do
 * to the schedule, so the choice is informed. After a third miss the card stops
 * asking for an answer and asks what is going wrong instead; that answer shows
 * up on Today, next to the drill it changed.
 */

interface Session {
  cards: Card[];
  /** Cloze options, keyed by card id, each carrying its own reading. */
  cloze: Record<number, ClozeChoice[]>;
  /** Listening options: the meanings a heard line might carry, in English. */
  listening: Record<number, string[]>;
  previews: Record<number, GradePreview>;
}

export interface ReviewOptions {
  songId?: number;
  kinds?: CardKind[];
  leeches?: boolean;
  title?: string;
  /** How many cards the session may serve. Today derives it from the time asked for. */
  limit?: number;
}

/** Cards a session asks for when the caller has no opinion — about four minutes. */
const DEFAULT_LIMIT = 30;

const REASONS: { key: CardReasonKind; label: string }[] = [
  { key: 'looks-like-another', label: 'Looks like another word' },
  { key: 'cannot-hear', label: 'Can’t hear the difference' },
  { key: 'meaning', label: 'Meaning won’t stick' },
  { key: 'reading', label: 'Reading won’t stick' },
];

export function Review({
  options,
  onDone,
  onChanged,
  onOpenSong,
}: {
  options: ReviewOptions;
  onDone: () => void;
  onChanged?: () => void;
  onOpenSong?: (songId: number) => void;
}) {
  const [session, setSession] = useState<Session | null>(null);
  const [pos, setPos] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState({ correct: 0, total: 0 });
  const [learned, setLearned] = useState(0);
  const [chosen, setChosen] = useState<string | null>(null);
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [mnemonicBusy, setMnemonicBusy] = useState(false);
  const [reason, setReason] = useState<CardReasonKind | null>(null);
  const [player, setPlayer] = useState<PlayerHandle | null>(null);
  const shownAt = useRef<number>(Date.now());
  // Set while a grade or a retire is in flight. Both advance the position when
  // they land, so letting a second one start would grade one card twice and step
  // past the next card without ever showing it.
  const busy = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.queue({
        limit: options.limit ?? DEFAULT_LIMIT,
        songId: options.songId,
        kinds: options.kinds,
        leeches: options.leeches,
        // A song-specific or leech drill should still run when nothing is
        // technically due — the user asked for those cards on purpose.
        ahead: !!options.songId || !!options.leeches,
      });
      setSession(res);
      setPos(0);
      setRevealed(false);
      setChosen(null);
      setAnswered({ correct: 0, total: 0 });
      setLearned(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load cards');
    } finally {
      setLoading(false);
    }
  }, [options.songId, options.leeches, options.limit, JSON.stringify(options.kinds ?? [])]);

  useEffect(() => {
    void load();
  }, [load]);

  const card = session?.cards[pos] ?? null;
  const preview = card ? session?.previews[card.id] : undefined;

  useEffect(() => {
    shownAt.current = Date.now();
    setMnemonic(null);
    setReason(null);
  }, [card?.id]);

  // Listening cards play their clip as soon as they appear.
  useEffect(() => {
    if (card?.kind === 'listening' && card.front.audio && player) {
      player.playClip(card.front.audio.startMs, card.front.audio.endMs);
    }
  }, [card?.id, card?.kind, player]);

  /**
   * Moves to the next card. Every per-card piece of state resets here — a card
   * arriving with the previous one's `revealed` still set would show its answer
   * and the grade buttons before the user had a chance to think.
   */
  const advance = useCallback(() => {
    setRevealed(false);
    setChosen(null);
    setPos((p) => p + 1);
  }, []);

  const grade = useCallback(
    async (quality: number, given?: string) => {
      if (!card || busy.current) return;
      busy.current = true;
      const ms = Date.now() - shownAt.current;
      setAnswered((prev) => ({
        correct: prev.correct + (quality >= 3 ? 1 : 0),
        total: prev.total + 1,
      }));
      if (quality >= 3 && card.srs.reps === 0) setLearned((n) => n + 1);
      try {
        await api.grade(card.id, quality, ms, given);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save that answer');
        return;
      } finally {
        busy.current = false;
      }
      onChanged?.();
      advance();
    },
    [card, onChanged, advance],
  );

  const playClip = useCallback(() => {
    if (card?.front.audio && player) {
      player.playClip(card.front.audio.startMs, card.front.audio.endMs);
    }
  }, [card, player]);

  const fetchMnemonic = async () => {
    if (!card) return;
    setMnemonicBusy(true);
    try {
      const res = await api.mnemonic(card.id);
      setMnemonic(res.mnemonic);
    } catch (err) {
      setMnemonic(
        err instanceof Error ? `Could not generate one: ${err.message}` : 'Could not generate one',
      );
    } finally {
      setMnemonicBusy(false);
    }
  };

  const choices = useMemo(
    () => (card && session ? (session.cloze[card.id] ?? []) : []),
    [card, session],
  );

  /**
   * A listening card's four meanings, and which of them is right.
   *
   * The card asks what the line said, not whether the user feels they followed
   * it — so the answer here is the line's translation, and a pick is checkable
   * against it. Older sessions, and lines the analysis pass has not reached, come
   * back with no options; those fall through to a plain reveal.
   */
  const heardChoices = useMemo(
    () => (card?.kind === 'listening' && session ? (session.listening[card.id] ?? []) : []),
    [card, session],
  );
  const heardAnswer = card?.back.lineTranslation ?? '';

  /**
   * A multiple-choice card the user got wrong, which grades itself.
   *
   * Where an option was picked the card already knows the answer, so leaving all
   * four grade buttons up invites "Good" on a card that was just missed — and a
   * card graded Good is a card the schedule stops showing for weeks. Self-grading
   * is for cards where only the user can tell how close they were; it is not a
   * negotiation over an answer the card already marked wrong.
   */
  const isMultipleChoice =
    (card?.kind === 'cloze' && choices.length > 0) ||
    (card?.kind === 'listening' && heardChoices.length > 0);
  const correctChoice = card?.kind === 'listening' ? heardAnswer : (card?.back.answer ?? '');
  const missed = isMultipleChoice && chosen !== null && chosen !== correctChoice;

  /** Takes an answer on a multiple-choice card, which also reveals it. */
  const pick = useCallback((option: string) => {
    setChosen((current) => current ?? option);
    setRevealed(true);
  }, []);

  // --- keyboard -------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!card) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      // Accept both `code` and `key`: some input sources (and non-US layouts)
      // report only one of the two for the space bar.
      const isSpace = e.code === 'Space' || e.key === ' ' || e.key === 'Spacebar';

      // A multiple-choice card is answered, never revealed: 1-4 take the pick.
      // Space would otherwise open the answer with nothing staked on it, and the
      // full grade row then accepts "Easy" on a card that was never attempted.
      if (!revealed && isMultipleChoice) {
        const options = card.kind === 'listening' ? heardChoices : choices.map((c) => c.text);
        const idx = ['1', '2', '3', '4'].indexOf(e.key);
        if (idx >= 0 && options[idx] !== undefined) {
          e.preventDefault();
          pick(options[idx]);
          return;
        }
        if (isSpace || e.key === 'Enter') {
          e.preventDefault();
          return;
        }
      }

      if (!revealed && (isSpace || e.key === 'Enter')) {
        e.preventDefault();
        setRevealed(true);
        return;
      }
      // A missed multiple-choice card has one button, so every key that means
      // "continue" lands on it — and 2, 3 and 4 grade nothing, rather than
      // quietly awarding a pass the card on screen contradicts.
      if (revealed && missed) {
        if (e.key === '1' || isSpace || e.key === 'Enter') {
          e.preventDefault();
          void grade(0, chosen ?? undefined);
        }
      } else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
        e.preventDefault();
        const quality = { '1': 0, '2': 2, '3': 4, '4': 5 }[e.key] as number;
        void grade(quality, chosen ?? undefined);
      }
      if (e.key.toLowerCase() === 'h' || e.key === 'r') playClip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    card,
    revealed,
    grade,
    chosen,
    playClip,
    missed,
    isMultipleChoice,
    choices,
    heardChoices,
    pick,
  ]);

  /**
   * Meanings worth printing under the answer.
   *
   * A vocab card's answer already *is* its glosses joined together, so repeating
   * them is noise. A cloze card's answer is Japanese, so its meanings are the
   * only translation on the card — and dropping them when there is just one, as
   * this used to, left cards like 聞いて with no meaning shown at all.
   */
  const extraGlosses = useMemo(() => {
    const glosses = card?.back.glosses ?? [];
    const answer = card?.back.answer ?? '';
    return glosses.filter((g) => !answer.includes(g));
  }, [card]);

  if (loading) return <p className="muted">Shuffling cards…</p>;

  if (error) {
    return (
      <div className="stack">
        <div className="error">{error}</div>
        <button onClick={() => void load()}>Try again</button>
      </div>
    );
  }

  if (!session || session.cards.length === 0) {
    return (
      <div className="empty">
        <div className="big">✓</div>
        <p>
          {options.leeches
            ? 'No trouble cards right now — nothing has failed enough times to need drilling.'
            : 'Nothing due. Come back later, or open a song and study it directly.'}
        </p>
        <button style={{ marginTop: 16 }} onClick={onDone}>
          Back
        </button>
      </div>
    );
  }

  if (!card) {
    return (
      <SessionComplete
        answered={answered}
        learned={learned}
        songId={options.songId}
        onAgain={() => void load()}
        onDone={onDone}
        onOpenSong={onOpenSong}
      />
    );
  }

  const done = (pos / session.cards.length) * 100;
  const step = (1 / session.cards.length) * 100;
  const cardMastery = masteryOf(card.srs);
  const askReason = revealed && card.srs.lapses >= 2;

  return (
    <div className="review-page">
      <div className="review-head">
        <span className="note">♪</span>
        <div className="body">
          <div className="row" style={{ gap: 9 }}>
            <span className="cap">{options.title ?? sessionLabel(options)}</span>
            <span className="mono">
              {pos + 1} / {session.cards.length}
            </span>
            {card.songTitle && <span className="tag jps">{card.songTitle}</span>}
            <span className="spacer" />
            <span className="mono">{kindLabel(card.kind)}</span>
          </div>
          <div className="progress-bar">
            <span className="done" style={{ width: `${done}%` }} />
            <span className="now" style={{ width: `${step}%` }} />
          </div>
        </div>
        <button className="forest quiet" onClick={onDone}>
          Quit
        </button>
      </div>

      <div className="review-body">
        {card.kind === 'listening' && card.front.audio && (
          <div className="card" style={{ maxWidth: 420, margin: '0 auto', width: '100%' }}>
            <YouTubePlayer videoId={card.front.audio.youtubeId} onReady={setPlayer} scrub={false} />
            <div className="row" style={{ marginTop: 8 }}>
              <button className="small" onClick={playClip}>
                ▶ Replay clip <span className="kbd">H</span>
              </button>
              <span className="faint" style={{ fontSize: 13 }}>
                {heardChoices.length > 0
                  ? 'Play it as often as you need, then pick what it means.'
                  : 'Listen first, then reveal the line.'}
              </span>
            </div>
          </div>
        )}

        <div className="flashcard">
          <div className="flags">
            <span>{kindLabel(card.kind).toUpperCase()}</span>
            {card.srs.leech && <span className="bad">TROUBLE CARD</span>}
            {card.srs.reps === 0 && <span className="new">FIRST TIME</span>}
          </div>

          <div className="prompt">{card.front.prompt}</div>

          {card.front.jp && (
            <div className={`big-jp${card.front.jp.length > 8 ? ' line' : ''}`}>
              {card.front.furigana ? <Furigana segments={card.front.furigana} /> : card.front.jp}
            </div>
          )}

          {card.front.romaji && card.kind !== 'kana' && (
            <div className="romaji">{card.front.romaji}</div>
          )}

          {card.kind === 'cloze' && choices.length > 0 && (
            <div className="choice-grid">
              {choices.map((choice, i) => (
                <button
                  key={choice.text}
                  className={
                    chosen
                      ? choice.text === card.back.answer
                        ? 'correct'
                        : choice.text === chosen
                          ? 'wrong'
                          : ''
                      : ''
                  }
                  onClick={() => pick(choice.text)}
                  disabled={!!chosen}
                >
                  {!chosen && <span className="kbd">{i + 1}</span>}
                  <span className="jp-line">
                    <Furigana segments={choice.furigana} />
                  </span>
                  {choice.romaji && (
                    <small className="romaji">
                      {choice.romaji}
                      {chosen
                        ? choice.text === card.back.answer
                          ? ' ✓'
                          : choice.text === chosen
                            ? ' ✗'
                            : ''
                        : ''}
                    </small>
                  )}
                </button>
              ))}
            </div>
          )}

          {card.kind === 'listening' && heardChoices.length > 0 && (
            <div className="meaning-grid">
              {heardChoices.map((option, i) => (
                <button
                  key={option}
                  className={
                    chosen
                      ? option === heardAnswer
                        ? 'correct'
                        : option === chosen
                          ? 'wrong'
                          : ''
                      : ''
                  }
                  onClick={() => pick(option)}
                  disabled={!!chosen}
                >
                  {!chosen && <span className="kbd">{i + 1}</span>}
                  {option}
                  {chosen && option === heardAnswer && <span className="mark">✓</span>}
                  {chosen && option === chosen && option !== heardAnswer && (
                    <span className="mark">✗</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {revealed && (
            <>
              <div className="rule" />
              <div className="answer-row">
                <div className="who">
                  {card.back.furigana?.length ? (
                    <div className="answer jp-line">
                      <Furigana segments={card.back.furigana} />
                    </div>
                  ) : (
                    <div className="answer">{card.back.answer}</div>
                  )}
                  {(card.back.reading || card.back.romaji) && card.kind !== 'kana' && (
                    <div className="glosses">
                      <span className="jp">{card.back.reading}</span>
                      {card.back.romaji ? (
                        <>
                          {' · '}
                          <span className="mono">{card.back.romaji}</span>
                        </>
                      ) : null}
                    </div>
                  )}
                  {extraGlosses.length > 0 && (
                    <div className="glosses">
                      <RubyText text={extraGlosses.join(' · ')} />
                    </div>
                  )}
                  {card.back.note && (
                    <div className="note">
                      <RubyText text={card.back.note} />
                    </div>
                  )}
                  {/* Already on screen with a tick next to it when the card was
                      the question about it. */}
                  {card.back.lineTranslation && heardChoices.length === 0 && (
                    <div className="note">
                      <RubyText text={card.back.lineTranslation} />
                    </div>
                  )}
                  {(mnemonic ?? card.back.mnemonic) && (
                    <div className="mnemonic">
                      💡 <RubyText text={mnemonic ?? card.back.mnemonic} />
                    </div>
                  )}
                </div>
                <div className="mastery-col">
                  <Ring value={cardMastery} big />
                  <span className="cap" style={{ textAlign: 'center' }}>
                    MASTERY
                    <br />
                    {card.srs.lapses > 0
                      ? `${card.srs.lapses} LAPSE${card.srs.lapses === 1 ? '' : 'S'}`
                      : `${card.srs.reps} REP${card.srs.reps === 1 ? '' : 'S'}`}
                  </span>
                </div>
              </div>
            </>
          )}
        </div>

        {!revealed ? (
          // A multiple-choice card has no reveal button: the options are how it
          // is answered, and a peek followed by a self-awarded "Easy" is exactly
          // the grade the options exist to replace.
          isMultipleChoice ? (
            <p className="muted" style={{ textAlign: 'center' }}>
              Pick one — <span className="kbd">1</span>-<span className="kbd">4</span>.
            </p>
          ) : (
            <div className="row" style={{ justifyContent: 'center' }}>
              <button
                className="primary"
                style={{ minWidth: 220 }}
                onClick={() => setRevealed(true)}
              >
                Show answer <span className="kbd">space</span>
              </button>
            </div>
          )
        ) : (
          <>
            {missed ? (
              <div className="grade-row locked">
                <p className="why">
                  Wrong pick — this one comes back as <b>Again</b>.
                </p>
                <GradeButton
                  tone="again"
                  label="Again"
                  days={preview?.again}
                  n={1}
                  onClick={() => void grade(0, chosen ?? undefined)}
                />
              </div>
            ) : (
              <div className="grade-row">
                <GradeButton
                  tone="again"
                  label="Again"
                  days={preview?.again}
                  n={1}
                  onClick={() => void grade(0, chosen ?? undefined)}
                />
                <GradeButton
                  tone="hard"
                  label="Hard"
                  days={preview?.hard}
                  n={2}
                  onClick={() => void grade(2, chosen ?? undefined)}
                />
                <GradeButton
                  tone="good"
                  label="Good"
                  days={preview?.good}
                  n={3}
                  onClick={() => void grade(4, chosen ?? undefined)}
                />
                <GradeButton
                  tone="easy"
                  label="Easy"
                  days={preview?.easy}
                  n={4}
                  onClick={() => void grade(5, chosen ?? undefined)}
                />
              </div>
            )}

            {askReason && (
              <div className="reason-row">
                <div style={{ minWidth: 190 }}>
                  <div style={{ fontWeight: 800, fontSize: 14.5 }}>
                    {card.srs.lapses + 1}
                    {ordinal(card.srs.lapses + 1)} miss. What’s going wrong?
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
                    One tap. It changes how this card comes back.
                  </div>
                </div>
                <div className="chips">
                  {REASONS.map((option) => (
                    <button
                      key={option.key}
                      className={`chip${reason === option.key ? ' on' : ''}`}
                      onClick={async () => {
                        setReason(option.key);
                        await api.cardReason(card.id, option.key).catch(() => {
                          /* a reason is a nicety, not a blocker */
                        });
                      }}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="row" style={{ justifyContent: 'center' }}>
              {card.front.audio && (
                <button className="ghost small" onClick={playClip}>
                  🎧 Hear it in the song <span className="kbd">H</span>
                </button>
              )}
              {!(mnemonic ?? card.back.mnemonic) && (
                <button className="ghost small" onClick={fetchMnemonic} disabled={mnemonicBusy}>
                  {mnemonicBusy ? 'Thinking…' : '💡 Another memory hook'}
                </button>
              )}
              <button
                className="ghost small"
                onClick={async () => {
                  if (busy.current) return;
                  busy.current = true;
                  try {
                    await api.suspend(card.id, true);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Could not retire that card');
                    return;
                  } finally {
                    busy.current = false;
                  }
                  onChanged?.();
                  advance();
                }}
              >
                Retire this card
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function GradeButton({
  tone,
  label,
  days,
  n,
  onClick,
}: {
  tone: 'again' | 'hard' | 'good' | 'easy';
  label: string;
  days: number | undefined;
  n: number;
  onClick: () => void;
}) {
  return (
    <button className={tone} onClick={onClick}>
      <b>{label}</b>
      <small>{days === undefined ? '—' : interval(days)}</small>
      <span className="n">{n}</span>
    </button>
  );
}

/**
 * The end of a session, and a reason to have got here.
 *
 * Stage mode unlocks for the song being studied once enough of it is known,
 * which is the point of the whole loop: the cards exist so the song becomes
 * singable.
 */
function SessionComplete({
  answered,
  learned,
  songId,
  onAgain,
  onDone,
  onOpenSong,
}: {
  answered: { correct: number; total: number };
  learned: number;
  songId?: number;
  onAgain: () => void;
  onDone: () => void;
  onOpenSong?: (songId: number) => void;
}) {
  const accuracy =
    answered.total > 0 ? Math.round((answered.correct / answered.total) * 100) : 0;
  // Read back after the session so the streak reflects the reviews just done.
  const [streak, setStreak] = useState<number | null>(null);

  useEffect(() => {
    void api
      .stats()
      .then((s) => setStreak(s.streakDays))
      .catch(() => setStreak(null));
  }, []);

  return (
    <div className="done-card">
      <div className="glow" />
      <div className="leaf">🌿</div>
      <h2>Set finished.</h2>
      <p>
        {answered.total} card{answered.total === 1 ? '' : 's'}, {accuracy}% right
        {learned > 0 ? `, and ${learned} you had never answered before finally landed.` : '.'}
      </p>

      <div className="tiles">
        <div>
          <div className="value">{streak ?? '—'}</div>
          <div className="label">DAY STREAK</div>
        </div>
        <div>
          <div className="value plain">＋{learned}</div>
          <div className="label">NEWLY MEMORISED</div>
        </div>
      </div>

      {songId && accuracy >= 70 && (
        <div className="unlocked">
          <div className="cap" style={{ color: 'var(--sage-dim)' }}>
            Unlocked
          </div>
          <div className="row" style={{ gap: 12 }}>
            <span className="icon">🎤</span>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--white)', fontSize: 15 }}>
                Stage mode for this song
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--sage)' }}>
                You know enough of it to sing it now.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="actions">
        {songId && onOpenSong ? (
          <button className="take" onClick={() => onOpenSong(songId)}>
            Take the stage ▸
          </button>
        ) : (
          <button className="take" onClick={onAgain}>
            Another round ▸
          </button>
        )}
        <div className="row" style={{ gap: 9 }}>
          <button className="forest" style={{ flex: 1 }} onClick={onAgain}>
            Another round
          </button>
          <button className="forest quiet" style={{ flex: 1 }} onClick={onDone}>
            That’s enough
          </button>
        </div>
      </div>
    </div>
  );
}

function sessionLabel(options: ReviewOptions): string {
  if (options.leeches) return 'TROUBLE DRILL';
  if (options.songId) return 'THIS SONG';
  if (options.kinds?.length) return options.kinds.join(' + ').toUpperCase();
  return 'MIXED REVIEW';
}

function ordinal(n: number): string {
  if (n % 10 === 1 && n % 100 !== 11) return 'st';
  if (n % 10 === 2 && n % 100 !== 12) return 'nd';
  if (n % 10 === 3 && n % 100 !== 13) return 'rd';
  return 'th';
}

function kindLabel(kind: CardKind): string {
  const labels: Record<CardKind, string> = {
    vocab: 'vocabulary',
    grammar: 'grammar',
    cloze: 'fill the blank',
    listening: 'listening',
    kana: 'katakana',
    kanji: 'kanji',
  };
  return labels[kind] ?? kind;
}
