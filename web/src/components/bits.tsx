import type { ReactNode } from 'react';

/**
 * Small pieces the screens share: the mastery ring, the section pips, the art
 * placeholder and the two number formatters. They exist here so "how well you
 * know it" looks identical on Today, in a song and on Progress.
 */

/** Six steps from untouched to known cold, matching the song-map legend. */
export function knowledgeClass(mastery: number, trouble = false): string {
  if (trouble) return 'kbad';
  if (mastery < 0) return 'k0';
  if (mastery === 0) return 'k0';
  if (mastery < 25) return 'k1';
  if (mastery < 45) return 'k2';
  if (mastery < 65) return 'k3';
  if (mastery < 85) return 'k4';
  return 'k5';
}

/**
 * Mastery of a card in hand, 0..100 — the same shape the server computes for
 * word lists, kept in step with `mastery()` in server/srs/store.ts. A card
 * already on screen has its SRS state, so asking the server again would only add
 * a round trip.
 */
export function masteryOf(srs: {
  intervalDays: number;
  reps: number;
  lapses: number;
  leech: boolean;
}): number {
  if (srs.reps === 0) return 0;
  const raw = Math.min(1, srs.intervalDays / 21);
  let score = Math.round(raw * 100);
  if (srs.leech) score = Math.min(score, 40);
  else if (srs.lapses > 0) score = Math.min(score, 88);
  return Math.max(1, score);
}

/** A conic-gradient ring: the fill is the mastery, the middle is the number. */
export function Ring({
  value,
  big = false,
  label,
}: {
  value: number;
  big?: boolean;
  label?: ReactNode;
}) {
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  const tone = pct === 0 ? 'low' : pct < 40 ? 'bad' : '';
  const color = pct === 0 ? 'var(--lime)' : pct < 40 ? 'var(--coral)' : 'var(--leaf)';
  return (
    <span
      className={`ring${big ? ' big' : ''}${tone ? ` ${tone}` : ''}`}
      style={{ background: `conic-gradient(${color} 0 ${pct}%, var(--canvas) ${pct}% 100%)` }}
      title={`Mastery ${pct} of 100`}
    >
      <span>{label ?? pct}</span>
    </span>
  );
}

/**
 * One bar per section of a song, darker where the lines are better known.
 *
 * Bars are sampled from the line-level map rather than counted from progress
 * flags: a section is not "done" because it was ticked, it is known because its
 * cards keep coming back right.
 */
export function Pips({
  cells,
  buckets = 10,
  slim = false,
}: {
  cells: { mastery: number; trouble: boolean }[];
  buckets?: number;
  slim?: boolean;
}) {
  if (cells.length === 0) return null;
  const size = Math.max(1, Math.ceil(cells.length / buckets));
  const groups: { mastery: number; trouble: boolean }[] = [];
  for (let i = 0; i < cells.length; i += size) {
    const slice = cells.slice(i, i + size);
    const known = slice.filter((c) => c.mastery > 0);
    groups.push({
      mastery: known.length === 0 ? 0 : known.reduce((s, c) => s + c.mastery, 0) / slice.length,
      trouble: slice.some((c) => c.trouble),
    });
  }
  return (
    <div className={`pips${slim ? ' slim' : ''}`}>
      {groups.map((g, i) => (
        <span key={i} className={knowledgeClass(g.mastery, g.trouble)} />
      ))}
    </div>
  );
}

/** Cover slot. Songs have no artwork locally, so this is an honest placeholder. */
export function Art({ quiet = false, size }: { quiet?: boolean; size?: number }) {
  return (
    <div
      className={`art${quiet ? ' quiet' : ''}`}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden
    >
      <span className="cap">ART</span>
    </div>
  );
}

/** mm:ss */
export function clock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0:00';
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** "10 min", "2 days", "3 weeks" — an interval a person can read. */
export function interval(days: number): string {
  if (days < 1) {
    const mins = Math.max(1, Math.round(days * 24 * 60));
    return mins >= 60 ? `${Math.round(mins / 60)} h` : `${mins} min`;
  }
  if (days < 30) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'}`;
  if (days < 365) return `${Math.round(days / 30)} mo`;
  return `${(days / 365).toFixed(1)} yr`;
}

/** "due today", "due in 9d", "overdue" — how the word garden labels a card. */
export function dueLabel(dueAt: string | null): string | null {
  if (!dueAt) return null;
  const days = (new Date(dueAt).getTime() - Date.now()) / 86_400_000;
  if (days < -1) return 'overdue';
  if (days < 1) return 'due today';
  return `due in ${Math.round(days)}d`;
}

/** "1h 46m" from seconds, for the listening total. */
export function duration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Rough minutes a session will take: cards are ~8s each once you are warm. */
export function estimateMinutes(cards: number, lines = 0): number {
  return Math.max(1, Math.round((cards * 8 + lines * 22) / 60));
}
