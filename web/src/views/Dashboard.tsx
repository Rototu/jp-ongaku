import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useCommands, useRail } from '../lib/shell';
import { Furigana } from '../components/Furigana';
import { estimateMinutes, knowledgeClass } from '../components/bits';
import type { ReviewOptions } from './Review';
import type { SongMapRow, TroubleCluster } from '../../../shared/types';

/**
 * Progress — four numbers that matter, then the song map.
 *
 * The map is the point: one cell per line across the whole library, shaded by
 * how well its cards are known. Nine stat tiles used to say less than this does,
 * and clicking a cell plays the line it stands for.
 */
export function Dashboard({
  onReview,
  onOpenSong,
}: {
  onReview: (options: ReviewOptions) => void;
  onOpenSong: (songId: number) => void;
}) {
  const stats = useAsync(() => api.stats(), []);
  const map = useAsync(() => api.songMap(), []);
  const trouble = useAsync(() => api.trouble(), []);
  const health = useAsync(() => api.health(), []);

  const s = stats.data;
  const weeks = s?.weeklyReviews ?? [];
  const touched = weeks.filter((n) => n > 0).length;

  const rail = useRail(
    <div className="rail-card">
      <div className="cap">This year</div>
      <div className="year-grid">
        {weeks.map((n, i) => (
          <span
            key={i}
            className={n === 0 ? '' : n < 20 ? 'w1' : n < 60 ? 'w2' : 'w3'}
            title={`${n} review${n === 1 ? '' : 's'}`}
          />
        ))}
      </div>
      <div className="cap">
        {touched} of {weeks.length} weeks touched
      </div>
    </div>,
  );

  useCommands([
    {
      id: 'progress-drill',
      label: 'Drill the trouble cards',
      where: 'Progress',
      run: () => onReview({ leeches: true, title: 'Trouble drill' }),
    },
  ]);

  return (
    <>
      {rail}
      <div className="page-head">
        <div>
          <h1>
            {s?.wordsKnown ?? 0} words, {s?.songs ?? 0} song{s?.songs === 1 ? '' : 's'}, {touched}{' '}
            week{touched === 1 ? '' : 's'}.
          </h1>
          <p className="sub">
            Everything below lives in one file on this machine. Back it up by copying it.
          </p>
        </div>
        {s && s.dueNow > 0 && (
          <button className="primary" onClick={() => onReview({})}>
            Review {s.dueNow} due ▸
          </button>
        )}
      </div>

      {stats.error && <div className="error">{stats.error}</div>}

      {health.data && !health.data.dictionary.available && (
        <div className="error">
          The dictionary database is missing, so words cannot be glossed. Run{' '}
          <code className="mono">bun run dict</code> and restart.
        </div>
      )}

      {s && (
        <div className="stat-row">
          <div className="stat-tile forest">
            <div className="value">{s.dueNow}</div>
            <div className="label">due right now</div>
            <div className="hint">
              {s.dueNow > 0 ? `≈ ${estimateMinutes(s.dueNow)} minutes of your life` : 'all clear'}
            </div>
          </div>
          <div className="stat-tile">
            <div className="value">{s.mature}</div>
            <div className="label">memorised for good</div>
            <div className="bar">
              <div
                style={{
                  width: `${s.totalCards > 0 ? (s.mature / s.totalCards) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
          <div className="stat-tile">
            <div className="value">
              {s.accuracy7d === null ? '—' : Math.round(s.accuracy7d * 100)}
              <small>%</small>
            </div>
            <div className="label">7-day accuracy</div>
            <div className="hint">{accuracyTrend(s.accuracy7d, s.accuracyPrev7d)}</div>
          </div>
          <div className={`stat-tile${s.leeches > 0 ? ' bad' : ''}`}>
            <div className="value">{s.leeches}</div>
            <div className="label">troublemakers</div>
            <div className="hint">
              {s.leeches > 0
                ? 'cards that keep coming back wrong'
                : 'nothing has failed enough to count'}
            </div>
          </div>
        </div>
      )}

      <div className="songmap">
        <div className="legend">
          <h2>Song map</h2>
          <span style={{ fontSize: 13.5, color: 'var(--muted)' }}>
            One cell per line, across your whole library. Click a cell to open it in the song.
          </span>
          <span className="spacer" />
          <span className="cap">new</span>
          {['k0', 'k1', 'k2', 'k3', 'k4', 'k5'].map((k) => (
            <span key={k} className={`sw ${k}`} />
          ))}
          <span className="cap">known cold</span>
        </div>

        {map.loading && <p className="muted">Reading the library…</p>}
        {map.data && map.data.songs.length === 0 && (
          <p className="muted">No songs yet — the map fills in as you add them.</p>
        )}

        <div className="stack" style={{ gap: 9 }}>
          {map.data?.songs.map((row) => (
            <SongMapRowView key={row.songId} row={row} onOpenSong={onOpenSong} />
          ))}
        </div>
      </div>

      <div className="two-col">
        <div className="stack">
          <h3>What keeps tripping you up</h3>
          {trouble.data && (trouble.data.clusters?.length ?? 0) === 0 && (
            <p className="muted">
              Nothing yet — clusters show up once the same two things get swapped a few times.
            </p>
          )}
          {trouble.data?.clusters?.map((cluster, i) => (
            <ClusterRow
              key={cluster.key}
              cluster={cluster}
              lead={i === 0}
              onDrill={() => onReview({ leeches: true, title: 'Trouble drill' })}
            />
          ))}
        </div>

        <div className="stack">
          <h3>Lines worth replaying</h3>
          {trouble.data && trouble.data.lines.length === 0 && (
            <p className="muted">No problem lines yet.</p>
          )}
          {trouble.data?.lines.slice(0, 6).map((line, i) => (
            <div className={`replay${i === 0 ? '' : ' quiet'}`} key={line.lineId}>
              <div className="who">
                <div className="jp-line">
                  <Furigana segments={line.furigana} />
                </div>
                {line.romaji && <div className="romaji">{line.romaji}</div>}
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>
                  <span className="jps">{line.songTitle}</span> · failed {line.lapses}×
                </div>
              </div>
              <button className={i === 0 ? 'dark' : ''} onClick={() => onOpenSong(line.songId)}>
                ▶ Play it
              </button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function SongMapRowView({
  row,
  onOpenSong,
}: {
  row: SongMapRow;
  onOpenSong: (songId: number) => void;
}) {
  return (
    <div className="row-song">
      <div className="who">
        <div className="t">
          {row.titleFurigana && row.titleFurigana.length > 0 ? (
            <Furigana segments={row.titleFurigana} />
          ) : (
            row.title
          )}
        </div>
        <div className="mono faint" style={{ fontSize: 10.5 }}>
          {row.artist} · {row.lineCount} lines
        </div>
      </div>
      <div className="cells">
        {row.cells.map((cell) => (
          <button
            key={cell.lineId}
            className={knowledgeClass(cell.mastery, cell.trouble)}
            title={
              cell.mastery < 0
                ? 'not studied yet'
                : `mastery ${cell.mastery}${cell.trouble ? ' · keeps failing' : ''}`
            }
            onClick={() => onOpenSong(row.songId)}
          />
        ))}
      </div>
      <span
        className="pct"
        style={{ color: row.percent >= 50 ? 'var(--leaf-dark)' : 'var(--faint)' }}
      >
        {row.percent}%
      </span>
    </div>
  );
}

function ClusterRow({
  cluster,
  lead,
  onDrill,
}: {
  cluster: TroubleCluster;
  lead: boolean;
  onDrill: () => void;
}) {
  return (
    <div className={`cluster${lead ? ' bad' : ''}`}>
      <div className="pair">
        {cluster.items.map((item, i) => (
          <span key={i} style={{ display: 'inline-flex', gap: 10, alignItems: 'center' }}>
            {i > 0 && <small>vs</small>}
            {item}
          </span>
        ))}
      </div>
      <div className="what">
        <div style={{ fontWeight: 700, fontSize: 15 }}>{cluster.label}</div>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>{cluster.detail}</div>
        {cluster.reason && (
          <div style={{ fontSize: 13, color: 'var(--muted)', fontStyle: 'italic' }}>
            “{cluster.reason}”
          </div>
        )}
      </div>
      <button className={lead ? 'coral' : ''} onClick={onDrill}>
        Drill {cluster.cardIds.length} ▸
      </button>
    </div>
  );
}

function accuracyTrend(now: number | null, before: number | null): string {
  if (now === null) return 'no reviews in the last week';
  if (before === null) return 'first week of reviews';
  const delta = Math.round((now - before) * 100);
  if (delta === 0) return 'level with last week';
  return `${delta > 0 ? 'up' : 'down'} ${Math.abs(delta)} point${Math.abs(delta) === 1 ? '' : 's'} on last week`;
}
