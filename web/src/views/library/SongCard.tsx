import { useState } from 'react';
import { api, type LibrarySong } from '../../lib/api';
import { Art, Pips } from '../../components/bits';
import { Furigana } from '../../components/Furigana';
import type { SongMapRow } from '../../../../shared/types';

export function SongCard({
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
        <Art quiet={!started} size={64} youtubeId={song.youtubeId} seed={song.title} />
        <div className="who">
          <div className="title one-line" title={song.title}>
            {song.titleFurigana && song.titleFurigana.length > 0 ? (
              <Furigana segments={song.titleFurigana} />
            ) : (
              song.title
            )}
          </div>
          {song.titleRomaji && (
            <div className="mono faint one-line" style={{ fontSize: 11 }} title={song.titleRomaji}>
              {song.titleRomaji}
            </div>
          )}
          <div className="one-line" style={{ fontSize: 13, color: 'var(--muted)' }} title={song.artist}>
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
        {confirming ? (
          <span className="row" style={{ gap: 6, flexShrink: 0 }}>
            <button
              className="ghost small"
              onClick={async (e) => {
                e.stopPropagation();
                await api.deleteSong(song.id);
                onChanged();
              }}
            >
              Delete
            </button>
            <button
              className="ghost small"
              onClick={(e) => {
                e.stopPropagation();
                setConfirming(false);
              }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            className="ghost small"
            onClick={(e) => {
              e.stopPropagation();
              setConfirming(true);
            }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}
