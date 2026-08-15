import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

/**
 * The end of a session, and a reason to have got here.
 *
 * Stage mode unlocks for the song being studied once enough of it is known,
 * which is the point of the whole loop: the cards exist so the song becomes
 * singable.
 */
export function SessionComplete({
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
