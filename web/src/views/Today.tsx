import { useMemo, useState } from 'react';
import { api, type LibrarySong } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useCommands, useRail } from '../lib/shell';
import { StreakCard } from '../components/StreakCard';
import { Art, Pips, duration, estimateMinutes } from '../components/bits';
import { Furigana } from '../components/Furigana';
import type { ReviewOptions } from './Review';
import type { SongMapRow, Stats, TroubleCluster } from '../../../shared/types';

/**
 * Today — the answer to "what now".
 *
 * The app composes one session out of what the database already knows: a
 * warm-up of whatever kana is due, the mixed pile that is actually due, and the
 * next unfinished section of the song you care most about. One button starts it,
 * so no decision is required before studying.
 */
export function Today({
  onReview,
  onOpenSong,
  onNewSong,
  onSearch,
}: {
  onReview: (options: ReviewOptions) => void;
  onOpenSong: (songId: number) => void;
  onNewSong: () => void;
  onSearch: () => void;
}) {
  const stats = useAsync(() => api.stats(), []);
  const songs = useAsync(() => api.songs(), []);
  const map = useAsync(() => api.songMap(), []);
  const trouble = useAsync(() => api.trouble(), []);
  const health = useAsync(() => api.health(), []);
  const [shuffled, setShuffled] = useState(false);
  const [skipped, setSkipped] = useState(false);

  const library = songs.data?.songs ?? [];
  const cells = useMemo(() => {
    const byId = new Map<number, SongMapRow>();
    for (const row of map.data?.songs ?? []) byId.set(row.songId, row);
    return byId;
  }, [map.data]);

  /**
   * The song the setlist ends on: a favourite with work left, else whatever has
   * the most due cards, else the newest thing in the library.
   */
  const focus = useMemo(() => {
    const withWork = [...library].sort(
      (a, b) =>
        Number(b.favourite) - Number(a.favourite) ||
        b.dueCards - a.dueCards ||
        b.id - a.id,
    );
    return shuffled ? withWork[Math.floor(Math.random() * withWork.length)] : withWork[0];
  }, [library, shuffled]);

  const focusDetail = useAsync(
    () => (focus ? api.song(focus.id) : Promise.resolve(null)),
    [focus?.id],
  );

  const nextSection = useMemo(() => {
    const progress = focusDetail.data?.progress ?? [];
    const pending = progress.find((v) => v.state !== 'done');
    if (!pending) return null;
    return {
      number: pending.verseIdx + 1,
      lines: pending.lineCount,
      done: progress.filter((v) => v.state === 'done').length,
      total: progress.length,
    };
  }, [focusDetail.data]);

  const s = stats.data;
  const kana = s?.dueByKind?.kana ?? 0;
  const mixed = Math.max(0, (s?.dueNow ?? 0) - kana);
  const cluster = trouble.data?.clusters?.[0] ?? null;

  const minutes = estimateMinutes((s?.dueNow ?? 0), nextSection?.lines ?? 0);

  const rail = useRail(<StreakCard stats={s} />);

  useCommands([
    { id: 'today-start', label: 'Start today’s setlist', where: 'Today', run: () => onReview({ title: 'Today’s setlist' }) },
    { id: 'today-shuffle', label: 'Shuffle the setlist', where: 'Today', run: () => setShuffled((v) => !v) },
    { id: 'today-new-song', label: 'Add a song', where: 'Today', run: onNewSong },
  ]);

  return (
    <>
      {rail}
      <div className="page-head">
        <div>
          <h1>{greeting()}</h1>
          <p className="sub">{blurb(s, focus, nextSection?.lines ?? 0)}</p>
        </div>
        <button className="cmdk-hint" onClick={onSearch}>
          <span className="mono faint">⌘K</span>
          Search songs, words, anything…
        </button>
      </div>

      {stats.error && <div className="error">{stats.error}</div>}

      <div className="setlist">
        <div className="orb a" />
        <div className="orb b" />

        <div className="body">
          <div className="row" style={{ gap: 10 }}>
            <span className="cap">Today’s setlist</span>
            <span className="pill">≈ {minutes} MIN</span>
            {focus?.favourite && <span className="pill star">★ FAVOURITES FIRST</span>}
          </div>
          <h2>{headline(s?.dueNow ?? 0, nextSection !== null)}</h2>

          <div className="tracks">
            <TrackCard
              cap="TRACK 1 · WARM-UP"
              what="Katakana look-alikes"
              how={
                kana > 0
                  ? `${kana} card${kana === 1 ? '' : 's'} due`
                  : health.data?.katakanaDeck === 0
                    ? 'deck not seeded yet'
                    : 'nothing due — skipped'
              }
              fill={kana > 0 ? 100 : 0}
            />
            <TrackCard
              cap="TRACK 2 · DUE NOW"
              what="Mixed review"
              how={
                mixed > 0
                  ? `${mixed} card${mixed === 1 ? '' : 's'}${
                      (s?.leeches ?? 0) > 0 ? ` · ${s?.leeches} are trouble` : ''
                    }`
                  : 'clear — nothing waiting'
              }
              fill={mixed > 0 ? 42 : 100}
              highlight={mixed > 0}
            />
            <TrackCard
              cap={focus?.favourite ? 'TRACK 3 · ★ FROM YOUR FAVOURITES' : 'TRACK 3 · SOMETHING NEW'}
              star={focus?.favourite}
              what={
                nextSection && focus ? (
                  <>
                    Section {nextSection.number} of{' '}
                    <span className="jps">{focus.title}</span>
                  </>
                ) : (
                  'Nothing queued'
                )
              }
              how={
                nextSection
                  ? `${nextSection.lines} lines · ${nextSection.done} of ${nextSection.total} sections done`
                  : library.length === 0
                    ? 'add a song and this fills in'
                    : 'every section is finished'
              }
              fill={
                nextSection && nextSection.total > 0
                  ? (nextSection.done / nextSection.total) * 100
                  : 0
              }
            />
          </div>
        </div>

        <div className="go">
          <button
            className="start"
            disabled={skipped}
            onClick={() => onReview({ title: 'Today’s setlist' })}
          >
            <span className="disp">{skipped ? 'Skipped today' : 'Start the set'}</span>
            <small>PRESS ⏎ · {minutes} MIN</small>
          </button>
          <div className="row" style={{ gap: 8 }}>
            <button className="forest" style={{ flex: 1 }} onClick={() => setShuffled((v) => !v)}>
              {shuffled ? 'Shuffled' : 'Shuffle it'}
            </button>
            <button
              className="forest quiet"
              style={{ flex: 1 }}
              onClick={() => setSkipped((v) => !v)}
            >
              {skipped ? 'Un-skip' : 'Skip today'}
            </button>
          </div>
        </div>
      </div>

      <div className="today-cols">
        <div className="stack">
          <div className="page-head" style={{ alignItems: 'baseline' }}>
            <h3>Back to it</h3>
            <span className="faint" style={{ fontSize: 13 }}>
              {library.length} song{library.length === 1 ? '' : 's'} in the library
            </span>
          </div>

          {library.slice(0, 3).map((song, i) => (
            <ContinueRow
              key={song.id}
              song={song}
              map={cells.get(song.id) ?? null}
              lead={i === 0}
              onOpen={() => onOpenSong(song.id)}
              onToggleFavourite={async () => {
                await api.updateSong(song.id, { favourite: !song.favourite });
                songs.reload();
              }}
            />
          ))}

          {health.data?.katakanaDeck === 0 && (
            <div className="seed-banner">
              <span className="emoji">カ</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700 }}>The katakana deck is empty.</div>
                <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                  Katakana is the shaky half for most people. Seeding it is worth five minutes a day.
                </div>
              </div>
              <button
                className="dark"
                onClick={async () => {
                  await api.seedKana();
                  health.reload();
                  stats.reload();
                }}
              >
                Seed it
              </button>
            </div>
          )}

          <div className="seed-banner">
            <span className="emoji">🌱</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700 }}>
                Add a song and it becomes a lesson in about a minute.
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>
                Type a title — we’ll find the lyrics and the timings ourselves.
              </div>
            </div>
            <button className="dark" onClick={onNewSong}>
              New song
            </button>
          </div>
        </div>

        <div className="stack">
          <h3>Where you are</h3>
          <div className="stat-tiles">
            <div className="stat-tile">
              <div className="value">{s?.wordsKnown ?? 0}</div>
              <div className="label">words you know</div>
              <div className="bar">
                <div
                  style={{
                    width: `${s && s.totalCards > 0 ? Math.min(100, (s.learned / s.totalCards) * 100) : 0}%`,
                  }}
                />
              </div>
            </div>
            <div className="stat-tile">
              <div className="value">
                {s?.accuracy7d === null || s?.accuracy7d === undefined
                  ? '—'
                  : Math.round(s.accuracy7d * 100)}
                <small>%</small>
              </div>
              <div className="label">7-day accuracy</div>
              <div className="bar">
                <div
                  style={{
                    width: `${s?.accuracy7d ? s.accuracy7d * 100 : 0}%`,
                    background: 'var(--lime)',
                  }}
                />
              </div>
            </div>
          </div>

          <ListeningCard days={s?.dailyListenSec ?? []} />

          {cluster ? (
            <TroubleCardView
              cluster={cluster}
              onDrill={() => onReview({ leeches: true, title: 'Trouble drill' })}
            />
          ) : (
            <div className="card flat">
              <div className="cap">no troublemakers</div>
              <div style={{ marginTop: 4 }}>
                Nothing has failed enough times to need its own drill. That is the good outcome.
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function TrackCard({
  cap,
  what,
  how,
  fill,
  highlight = false,
  star = false,
}: {
  cap: string;
  what: React.ReactNode;
  how: string;
  fill: number;
  highlight?: boolean;
  star?: boolean;
}) {
  return (
    <div className={`track-card${highlight ? ' on' : ''}`}>
      <div className={`cap${star ? ' star' : ''}`}>{cap}</div>
      <div className="what">{what}</div>
      <div className="how">{how}</div>
      <div className="bar">
        <div style={{ width: `${Math.max(0, Math.min(100, fill))}%` }} />
      </div>
    </div>
  );
}

function ContinueRow({
  song,
  map,
  lead,
  onOpen,
  onToggleFavourite,
}: {
  song: LibrarySong;
  map: SongMapRow | null;
  lead: boolean;
  onOpen: () => void;
  onToggleFavourite: () => void;
}) {
  const known = map?.cells.filter((c) => c.mastery > 0).length ?? 0;
  return (
    <div className={`continue-row${lead ? '' : ' quiet'}`}>
      <Art quiet={!lead} />
      <div className="who">
        <div className="title">
          {song.titleFurigana && song.titleFurigana.length > 0 ? (
            <Furigana segments={song.titleFurigana} />
          ) : (
            song.title
          )}
        </div>
        <div className="row" style={{ gap: 9 }}>
          <span className="mono faint" style={{ fontSize: 12 }}>
            {song.titleRomaji ? `${song.titleRomaji} · ` : ''}
            {song.artist}
          </span>
          {song.favourite && <span className="tag loan">★ FAVOURITE</span>}
        </div>
        {map && (
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            <Pips cells={map.cells} slim buckets={10} />
            <span className="mono faint" style={{ fontSize: 10 }}>
              {known} / {map.lineCount} LINES STARTED
            </span>
          </div>
        )}
      </div>
      <div className="row" style={{ gap: 10 }}>
        <button
          className={`icon-star${song.favourite ? ' on' : ''}`}
          onClick={onToggleFavourite}
          title={
            song.favourite
              ? 'Favourited — its sections lead your setlist'
              : 'Favourite this song'
          }
        >
          ★
        </button>
        {song.dueCards > 0 && <span className="tag new">{song.dueCards} DUE</span>}
        <button className={lead ? 'dark' : ''} onClick={onOpen}>
          {lead ? 'Resume ▸' : 'Open ▸'}
        </button>
      </div>
    </div>
  );
}

function ListeningCard({ days }: { days: number[] }) {
  const total = days.reduce((a, b) => a + b, 0);
  const peak = Math.max(1, ...days);
  return (
    <div className="week-chart">
      <div className="cap" style={{ color: 'var(--sage-dim)' }}>
        Listening this week
      </div>
      <div className="bars">
        {days.map((sec, i) => (
          <div
            key={i}
            className={i === days.length - 1 ? 'today' : ''}
            style={{ height: `${Math.max(4, (sec / peak) * 100)}%` }}
            title={`${duration(sec)} on this day`}
          />
        ))}
      </div>
      <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
        <span className="total">{total > 0 ? duration(total) : '0m'}</span>
        <span style={{ fontSize: 12, color: 'var(--sage-dim)' }}>
          {total > 0 ? 'sung along, mostly badly' : 'play a song and this fills in'}
        </span>
      </div>
    </div>
  );
}

function TroubleCardView({
  cluster,
  onDrill,
}: {
  cluster: TroubleCluster;
  onDrill: () => void;
}) {
  return (
    <div className="trouble-card">
      <div>
        <span className="tag leech">
          {cluster.lapses} MISS{cluster.lapses === 1 ? '' : 'ES'}
        </span>
      </div>
      <div className="pair">
        {cluster.items.map((item, i) => (
          <span key={i} style={{ display: 'inline-flex', gap: 12, alignItems: 'center' }}>
            {i > 0 && (
              <span style={{ fontSize: 13, color: 'var(--faint)', fontWeight: 400 }}>vs</span>
            )}
            {item}
          </span>
        ))}
      </div>
      <div style={{ fontSize: 13, color: 'var(--muted)' }}>{cluster.detail}</div>
      {cluster.reason && (
        <>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>You told us why:</div>
          <div className="quote">“{cluster.reason}”</div>
          <div className="fix">
            <span>💡</span>
            <div>
              So the drill pairs them up instead of asking one at a time — the difference is the
              thing to learn, not either half.
            </div>
          </div>
        </>
      )}
      <button className="coral" style={{ alignSelf: 'flex-start' }} onClick={onDrill}>
        {cluster.items.length > 1 ? 'Drill the pair ▸' : 'Drill it ▸'}
      </button>
    </div>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return 'Still up?';
  if (h < 12) return 'Morning.';
  if (h < 18) return 'Afternoon.';
  return 'Evening.';
}

function headline(due: number, hasSection: boolean): string {
  if (due === 0 && !hasSection) return 'Nothing due. Go and listen to something.';
  if (due === 0) return 'Nothing due — so let’s learn something new.';
  if (!hasSection) return `${due} card${due === 1 ? '' : 's'}, then you’re done.`;
  return 'Two tracks, then you’re done.';
}

function blurb(
  s: Stats | null,
  focus: LibrarySong | undefined,
  linesLeft: number,
): string {
  if (!s) return 'Working out what you should do next…';
  const parts: string[] = [];
  parts.push(
    s.dueNow > 0
      ? `${s.dueNow} card${s.dueNow === 1 ? '' : 's'} ${s.dueNow === 1 ? 'is' : 'are'} pretending they’ve never met you.`
      : 'Nothing is due, which means the schedule is working.',
  );
  if (focus && linesLeft > 0) {
    parts.push(`Also: you’re ${linesLeft} line${linesLeft === 1 ? '' : 's'} from finishing a section of ${focus.title}.`);
  }
  return parts.join(' ');
}
