import type { Stats } from '../../../shared/types';

/**
 * Today's sidebar block: the streak, and one bar per day of the last week.
 * Today's bar is outlined whether or not it has reviews in it yet, because the
 * gap is the point.
 */
export function StreakCard({ stats }: { stats: Stats | null }) {
  if (!stats) return <div className="rail-card" />;
  const days = stats.dailyReviews;
  const total = days.reduce((a, b) => a + b, 0);

  return (
    <div className="rail-card">
      <div className="streak-head">
        <span style={{ fontSize: 20 }}>🔥</span>
        <span className="n">{stats.streakDays}</span>
        <small>
          day
          <br />
          streak
        </small>
      </div>
      <div className="streak-bars">
        {days.map((n, i) => {
          const isToday = i === days.length - 1;
          const cls = isToday ? 'today' : n === 0 ? '' : n < 10 ? 'dim' : 'on';
          return <span key={i} className={cls} title={`${n} review${n === 1 ? '' : 's'}`} />;
        })}
      </div>
      <div className="cap">
        LAST 7 DAYS · {total} REVIEW{total === 1 ? '' : 'S'}
      </div>
    </div>
  );
}
