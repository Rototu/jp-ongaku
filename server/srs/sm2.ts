import type { SrsState } from '../../shared/types';

/**
 * SM-2 spaced repetition, as used by SuperMemo and Anki's classic scheduler.
 *
 * Quality scale (what the UI maps its buttons onto):
 *   0 blackout · 1 wrong · 2 wrong but familiar · 3 correct with effort ·
 *   4 correct · 5 instant
 * Anything below 3 is a lapse: the interval resets and the card comes back
 * today.
 */

/** Lapses at or above this mark a card as a leech and route it to drills. */
export const LEECH_THRESHOLD = 3;

const MIN_EASE = 1.3;
const MAX_EASE = 3.0;
/** First two successful intervals, in days. */
const FIRST_INTERVAL = 1;
const SECOND_INTERVAL = 6;
/** How soon a lapsed card returns, in days (10 minutes). */
const RELEARN_INTERVAL = 10 / (60 * 24);

export interface ScheduleInput {
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
}

export interface ScheduleResult {
  ease: number;
  intervalDays: number;
  reps: number;
  lapses: number;
  dueAt: Date;
  leech: boolean;
}

export function freshState(now: Date = new Date()): SrsState {
  return {
    ease: 2.5,
    intervalDays: 0,
    reps: 0,
    lapses: 0,
    dueAt: now.toISOString(),
    leech: false,
    suspended: false,
  };
}

export function schedule(
  state: ScheduleInput,
  quality: number,
  now: Date = new Date(),
): ScheduleResult {
  const q = Math.max(0, Math.min(5, Math.round(quality)));

  // SM-2's ease adjustment. Applied on every answer, including lapses.
  let ease = state.ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
  ease = Math.min(MAX_EASE, Math.max(MIN_EASE, ease));

  let reps = state.reps;
  let lapses = state.lapses;
  let intervalDays: number;

  if (q < 3) {
    lapses += 1;
    reps = 0;
    intervalDays = RELEARN_INTERVAL;
  } else {
    reps += 1;
    if (reps === 1) intervalDays = FIRST_INTERVAL;
    else if (reps === 2) intervalDays = SECOND_INTERVAL;
    else intervalDays = state.intervalDays * ease;

    // A merely-correct answer shouldn't stretch as far as an instant one.
    if (q === 3) intervalDays *= 0.8;
    intervalDays = Math.max(FIRST_INTERVAL, intervalDays);
    // Cap so an easy card doesn't vanish for years.
    intervalDays = Math.min(intervalDays, 365 * 2);
  }

  const dueAt = new Date(now.getTime() + intervalDays * 86_400_000);

  return { ease, intervalDays, reps, lapses, dueAt, leech: lapses >= LEECH_THRESHOLD };
}

/** Days until due; negative means overdue. */
export function daysUntil(dueAt: string, now: Date = new Date()): number {
  return (new Date(dueAt).getTime() - now.getTime()) / 86_400_000;
}

/** Cards with an interval past this are "mature" in the stats panel. */
export const MATURE_DAYS = 21;
