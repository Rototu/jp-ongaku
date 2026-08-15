import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { useAsync } from '../lib/useAsync';
import { useCommands, useRail } from '../lib/shell';
import type { SongMapRow } from '../../../shared/types';
import { SongCard } from './library/SongCard';
import { ImportCard } from './library/ImportCard';

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
 *
 * The import card and its paste pane live in ./library/ImportCard; one library
 * card in ./library/SongCard.
 */
export function Library({
  onOpen,
  onChanged,
  onNotice,
}: {
  onOpen: (songId: number) => void;
  onChanged?: () => void;
  /** Something the import had to correct, carried onto the song page. */
  onNotice?: (message: string) => void;
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
          if (res.notice) onNotice?.(res.notice);
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
