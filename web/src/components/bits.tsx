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
  suspended?: boolean;
}): number {
  // Retired means "I know this, stop asking" — a full bar, not a stalled one.
  if (srs.suspended) return 100;
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

/** Background pairs a generated cover is drawn from, all inside the app's palette. */
const COVER_TONES = [
  { bg: 'var(--forest)', fg: 'var(--lime)' },
  { bg: 'var(--lime)', fg: 'var(--ink)' },
  { bg: 'var(--leaf)', fg: 'var(--white)' },
  { bg: 'var(--mint)', fg: 'var(--forest)' },
  { bg: 'var(--amber)', fg: 'var(--amber-ink)' },
  { bg: 'var(--coral)', fg: 'var(--coral-ink)' },
  { bg: 'var(--forest-3)', fg: 'var(--lime-pale)' },
  { bg: 'var(--lime-pale)', fg: 'var(--forest)' },
];

/** Stable small integer for a string, so a song's cover never changes on reload. */
function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * The glyph a generated cover carries: the song's first real character.
 *
 * A kanji or kana reads as a cover; a latin letter is uppercased so "back shot"
 * gets a B rather than a lowercase b floating in the middle of a square.
 */
function coverGlyph(seed: string): string {
  const char = [...seed.trim()].find((c) => /[^\s\p{P}\p{S}]/u.test(c));
  return char ? char.toUpperCase() : '♪';
}

/**
 * Cover art for a song.
 *
 * A video gives the real thing: YouTube's thumbnail, cropped square. Without one
 * the cover is generated from the title — a palette tone and the song's first
 * character — because the diagonal-hatch placeholder was identical for every
 * song in the library and so told the user nothing about which row they were
 * looking at.
 */
export function Art({
  quiet = false,
  size,
  youtubeId,
  seed,
}: {
  quiet?: boolean;
  size?: number;
  youtubeId?: string | null;
  /** Usually the song title: what the generated cover is derived from. */
  seed?: string | null;
}) {
  const box = size ? { width: size, height: size } : undefined;

  if (youtubeId) {
    return (
      <div className={`art${quiet ? ' quiet' : ''} thumb`} style={box} aria-hidden>
        <img src={`https://i.ytimg.com/vi/${youtubeId}/mqdefault.jpg`} alt="" loading="lazy" />
      </div>
    );
  }

  if (seed?.trim()) {
    const tone = COVER_TONES[hash(seed) % COVER_TONES.length];
    return (
      <div
        className={`art${quiet ? ' quiet' : ''} generated`}
        style={{ ...box, background: tone.bg, color: tone.fg }}
        aria-hidden
      >
        <span className="glyph" style={{ fontSize: (size ?? 76) * 0.46 }}>
          {coverGlyph(seed)}
        </span>
      </div>
    );
  }

  return (
    <div className={`art${quiet ? ' quiet' : ''}`} style={box} aria-hidden>
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

/** Seconds a single card costs once you are warm. The unit both ways below. */
export const SECONDS_PER_CARD = 8;

/** Rough minutes a session will take: cards are ~8s each once you are warm. */
export function estimateMinutes(cards: number, lines = 0): number {
  return Math.max(1, Math.round((cards * SECONDS_PER_CARD + lines * 22) / 60));
}

/** How many cards fit in a stretch of time — the inverse of estimateMinutes. */
export function cardsInMinutes(minutes: number): number {
  return Math.max(1, Math.round((minutes * 60) / SECONDS_PER_CARD));
}
