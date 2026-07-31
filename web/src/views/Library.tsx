import { useMemo, useState } from 'react';
import { api, type ImportResult, type LibrarySong, type SearchHit } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useCommands, useRail } from '../lib/shell';
import { Art, Pips } from '../components/bits';
import { Furigana, TitleText } from '../components/Furigana';
import type { SongMapRow } from '../../../shared/types';

type Sort = 'favourites' | 'due' | 'recent' | 'easiest' | 'unfinished';

const SORTS: { key: Sort; label: string }[] = [
  { key: 'favourites', label: '★ FAVOURITES' },
  { key: 'due', label: 'DUE' },
  { key: 'recent', label: 'RECENT' },
  { key: 'easiest', label: 'EASIEST' },
  { key: 'unfinished', label: 'UNFINISHED' },
];

/**
 * Songs — one field to add anything, then the library as cards.
 *
 * Import collapsed to a single question: what are you listening to? The video
 * link, the notes for the model and the paste-the-lyrics-yourself escape hatch
 * are all still here, behind “＋” chips, because most imports need none of them.
 */
export function Library({
  onOpen,
  onChanged,
}: {
  onOpen: (songId: number) => void;
  onChanged?: () => void;
}) {
  const songs = useAsync(() => api.songs(), []);
  const map = useAsync(() => api.songMap(), []);
  const [sort, setSort] = useState<Sort>('favourites');

  const cells = useMemo(() => {
    const byId = new Map<number, SongMapRow>();
    for (const row of map.data?.songs ?? []) byId.set(row.songId, row);
    return byId;
  }, [map.data]);

  const library = useMemo(() => {
    const list = [...(songs.data?.songs ?? [])];
    const percent = (id: number) => cells.get(id)?.percent ?? 0;
    switch (sort) {
      case 'due':
        return list.sort((a, b) => b.dueCards - a.dueCards);
      case 'recent':
        return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      case 'easiest':
        return list.sort((a, b) => percent(b.id) - percent(a.id));
      case 'unfinished':
        return list.sort((a, b) => percent(a.id) - percent(b.id));
      default:
        return list.sort(
          (a, b) => Number(b.favourite) - Number(a.favourite) || b.dueCards - a.dueCards,
        );
    }
  }, [songs.data, sort, cells]);

  const totals = useMemo(() => {
    const list = songs.data?.songs ?? [];
    return {
      songs: list.length,
      cards: list.reduce((n, s) => n + s.totalCards, 0),
      due: list.reduce((n, s) => n + s.dueCards, 0),
    };
  }, [songs.data]);

  const rail = useRail(
    <div className="rail-card">
      <div className="cap">Sort library by</div>
      <div className="chips">
        {SORTS.map((option) => (
          <button
            key={option.key}
            className={`chip mono${option.key === 'favourites' ? ' star' : option.key === 'due' ? ' lime' : ''}${
              sort === option.key ? ' on' : ''
            }`}
            onClick={() => setSort(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>,
  );

  useCommands(
    SORTS.map((option) => ({
      id: `sort-${option.key}`,
      label: `Sort library by ${option.label.replace('★ ', '').toLowerCase()}`,
      where: 'Songs',
      run: () => setSort(option.key),
    })),
  );

  return (
    <>
      {rail}
      <ImportCard
        onImported={(res) => {
          songs.reload();
          map.reload();
          onChanged?.();
          onOpen(res.songId);
        }}
      />

      <div className="page-head" style={{ alignItems: 'baseline' }}>
        <h2>
          Your library{' '}
          <span style={{ fontWeight: 500, fontSize: 15, color: 'var(--faint)' }}>
            {totals.songs} song{totals.songs === 1 ? '' : 's'} · {totals.cards} cards · {totals.due} due
          </span>
        </h2>
        <span className="cap">each bar = one stretch of lines, darker = better known</span>
      </div>

      {songs.error && <div className="error">{songs.error}</div>}
      {songs.data && songs.data.songs.length === 0 && (
        <div className="empty">
          <div className="big">♪</div>
          <p>No songs yet. Type a title above and it becomes a full lesson.</p>
        </div>
      )}

      <div className="song-grid">
        {library.map((song) => (
          <SongCard
            key={song.id}
            song={song}
            map={cells.get(song.id) ?? null}
            onOpen={() => onOpen(song.id)}
            onChanged={() => {
              songs.reload();
              onChanged?.();
            }}
          />
        ))}
      </div>
    </>
  );
}

function SongCard({
  song,
  map,
  onOpen,
  onChanged,
}: {
  song: LibrarySong;
  map: SongMapRow | null;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const started = map?.cells.some((c) => c.mastery > 0) ?? false;

  return (
    <div className={`song-card${started || song.favourite ? '' : ' quiet'}`} onClick={onOpen}>
      <div className="top">
        <Art quiet={!started} size={64} />
        <div className="who">
          <div className="title">
            {song.titleFurigana && song.titleFurigana.length > 0 ? (
              <Furigana segments={song.titleFurigana} />
            ) : (
              song.title
            )}
          </div>
          {song.titleRomaji && (
            <div className="mono faint" style={{ fontSize: 11 }}>
              {song.titleRomaji}
            </div>
          )}
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            {song.artistFurigana && song.artistFurigana.length > 0 ? (
              <Furigana segments={song.artistFurigana} />
            ) : (
              song.artist
            )}
          </div>
        </div>
        <div className="row" style={{ gap: 8 }} onClick={(e) => e.stopPropagation()}>
          <button
            className={`icon-star${song.favourite ? ' on' : ''}`}
            style={{ fontSize: 22 }}
            title={song.favourite ? 'Favourited' : 'Favourite this song'}
            onClick={async () => {
              await api.updateSong(song.id, { favourite: !song.favourite });
              onChanged();
            }}
          >
            ★
          </button>
          {song.dueCards > 0 ? (
            <span className="tag new">{song.dueCards}</span>
          ) : (
            <span className="tag">{started ? 'CLEAR' : 'NEW'}</span>
          )}
        </div>
      </div>

      {map && map.cells.length > 0 && <Pips cells={map.cells} buckets={Math.min(12, map.lineCount)} />}

      <div className="foot">
        <span className="cap">
          {song.lineCount} LINES · {song.totalCards} CARDS
          {song.synced ? ' · TIMED' : ''}
          {song.analyzed ? ' · EXPLAINED' : ' · NOT EXPLAINED YET'}
        </span>
        <button
          className="ghost small"
          onClick={async (e) => {
            e.stopPropagation();
            if (!confirming) {
              setConfirming(true);
              return;
            }
            await api.deleteSong(song.id);
            onChanged();
          }}
        >
          {confirming ? 'Really delete?' : '✕'}
        </button>
      </div>
    </div>
  );
}

/**
 * The one-field import.
 *
 * A title is enough: LRCLIB is searched for it, Japanese results with timings
 * rank first, and everything else — video, notes, hand-pasted lyrics — is a chip
 * away and editable later.
 */
function ImportCard({ onImported }: { onImported: (r: ImportResult) => void }) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<number | null>(null);

  const [showVideo, setShowVideo] = useState(false);
  const [showContext, setShowContext] = useState(false);
  const [showPaste, setShowPaste] = useState(false);
  const [youtube, setYoutube] = useState('');
  const [context, setContext] = useState('');

  const search = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setBusy(true);
    setError(null);
    setHits(null);
    try {
      const res = await api.search(query.trim());
      setHits(res.hits);
      if (res.hits.length === 0) {
        setError('Nothing found. Try the Japanese title, or paste the lyrics instead.');
        setShowPaste(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setBusy(false);
    }
  };

  const importHit = async (hit: SearchHit) => {
    setImportingId(hit.id);
    setError(null);
    try {
      const res = await api.importFromLrclib(
        hit.id,
        youtube.trim() || undefined,
        context.trim() || undefined,
      );
      onImported(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setImportingId(null);
    }
  };

  return (
    <div className="import-card">
      <div className="row" style={{ alignItems: 'baseline', gap: 12 }}>
        <h2 style={{ fontSize: 28 }}>What are you listening to?</h2>
        <span className="faint" style={{ fontSize: 13 }}>
          Japanese or romaji. One field is all we need.
        </span>
      </div>

      <form className="one-field" onSubmit={search}>
        <div className="field">
          <span style={{ fontSize: 18, color: 'var(--faint)' }}>⌕</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="紅蓮華 / Gurenge"
            autoFocus
          />
          {hits && (
            <span className="cap" style={{ whiteSpace: 'nowrap' }}>
              {hits.length} MATCHES
            </span>
          )}
        </div>
        <button className="primary find" disabled={busy || !query.trim()}>
          {busy ? <span className="spinner" /> : 'Find it'}
        </button>
      </form>

      <div className="chips">
        <button
          className={`chip${showVideo ? ' on' : ''}`}
          onClick={() => setShowVideo((v) => !v)}
        >
          ＋ Add a video link
        </button>
        <button
          className={`chip${showContext ? ' on' : ''}`}
          onClick={() => setShowContext((v) => !v)}
        >
          ＋ Tell the AI about the song
        </button>
        <button
          className={`chip${showPaste ? ' on' : ''}`}
          onClick={() => setShowPaste((v) => !v)}
        >
          ＋ Paste lyrics instead
        </button>
        <span className="faint" style={{ fontSize: 12.5 }}>
          — all optional, all editable later
        </span>
      </div>

      {showVideo && (
        <label>
          <div className="cap" style={{ marginBottom: 4 }}>
            youtube link — enables sing-along, stage mode and listening cards
          </div>
          <input
            value={youtube}
            onChange={(e) => setYoutube(e.target.value)}
            placeholder="https://youtube.com/watch?v=…"
          />
        </label>
      )}

      {showContext && (
        <label>
          <div className="cap" style={{ marginBottom: 4 }}>
            what the model should know
          </div>
          <textarea
            value={context}
            onChange={(e) => setContext(e.target.value)}
            rows={4}
            placeholder="e.g. Ending theme of the second season — the singer is the character who dies in episode 9."
          />
        </label>
      )}

      {error && <div className="error">{error}</div>}

      {hits && hits.length > 0 && (
        <div className="hit-list">
          {hits.map((hit, i) => (
            <div
              className={`hit${i === 0 && hit.japanese ? ' best' : ''}${hit.japanese ? '' : ' dim'}`}
              key={hit.id}
            >
              <Art quiet={!hit.japanese} size={52} />
              <div className="who">
                <div className="title">
                  <TitleText
                    text={hit.trackName}
                    furigana={hit.titleFurigana}
                    romaji={null}
                  />
                </div>
                <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                  {hit.titleRomaji ? `${hit.titleRomaji} · ` : ''}
                  {hit.artistName}
                  {hit.duration ? ` · ${formatDuration(hit.duration)}` : ''}
                </div>
              </div>
              {hit.japanese ? (
                <span className="tag new">日本語</span>
              ) : (
                <span className="tag">NOT JAPANESE</span>
              )}
              {hit.hasSynced && <span className="tag ink">TIMED</span>}
              {youtube.trim() && i === 0 && <span className="tag outline">VIDEO ATTACHED</span>}
              <button
                className={i === 0 && hit.japanese ? 'dark' : ''}
                disabled={importingId !== null}
                onClick={() => importHit(hit)}
              >
                {importingId === hit.id ? 'Building lesson…' : 'Make lesson ▸'}
              </button>
            </div>
          ))}
        </div>
      )}

      {showPaste && (
        <PastePane
          youtube={youtube}
          context={context}
          onImported={onImported}
        />
      )}
    </div>
  );
}

/** The escape hatch: LRCLIB has never heard of it, so type it in yourself. */
function PastePane({
  youtube,
  context,
  onImported,
}: {
  youtube: string;
  context: string;
  onImported: (r: ImportResult) => void;
}) {
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = title.trim() && artist.trim() && lyrics.trim();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.importPasted({
        title: title.trim(),
        artist: artist.trim(),
        lyrics,
        youtubeId: youtube.trim() || undefined,
        context: context.trim() || undefined,
      });
      setLyrics('');
      onImported(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card flat stack" onSubmit={submit}>
      <div className="cap">paste the lyrics yourself</div>
      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <label>
          <div className="cap" style={{ marginBottom: 4 }}>
            title
          </div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          <div className="cap" style={{ marginBottom: 4 }}>
            artist
          </div>
          <input value={artist} onChange={(e) => setArtist(e.target.value)} />
        </label>
      </div>
      <label>
        <div className="cap" style={{ marginBottom: 4 }}>
          one line per line · blank lines separate sections · LRC timestamps are kept
        </div>
        <textarea
          value={lyrics}
          onChange={(e) => setLyrics(e.target.value)}
          spellCheck={false}
          rows={8}
        />
      </label>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="primary" disabled={busy || !ready}>
          {busy ? 'Building lesson…' : 'Build lesson'}
        </button>
        <span className="faint" style={{ fontSize: 13 }}>
          Everything stays on this machine.
        </span>
      </div>
    </form>
  );
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
