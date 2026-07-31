import { describe, expect, test } from 'bun:test';
import { schedule, freshState, LEECH_THRESHOLD } from '../server/srs/sm2';

const base = { ease: 2.5, intervalDays: 0, reps: 0, lapses: 0 };
const NOW = new Date('2026-01-01T12:00:00Z');

describe('sm2 scheduling', () => {
  test('a new card answered well comes back tomorrow', () => {
    const r = schedule(base, 5, NOW);
    expect(r.reps).toBe(1);
    expect(r.intervalDays).toBe(1);
    expect(r.dueAt.getTime()).toBe(NOW.getTime() + 86_400_000);
  });

  test('second success jumps to six days', () => {
    const r = schedule({ ...base, reps: 1, intervalDays: 1 }, 5, NOW);
    expect(r.intervalDays).toBe(6);
  });

  test('later successes multiply by ease', () => {
    const r = schedule({ ease: 2.5, intervalDays: 6, reps: 2, lapses: 0 }, 4, NOW);
    expect(r.intervalDays).toBeCloseTo(6 * r.ease, 5);
    expect(r.intervalDays).toBeGreaterThan(6);
  });

  test('a barely-correct answer grows more slowly than an easy one', () => {
    const hard = schedule({ ease: 2.5, intervalDays: 10, reps: 3, lapses: 0 }, 3, NOW);
    const easy = schedule({ ease: 2.5, intervalDays: 10, reps: 3, lapses: 0 }, 5, NOW);
    expect(hard.intervalDays).toBeLessThan(easy.intervalDays);
  });

  test('failing resets the interval and returns the card immediately', () => {
    const r = schedule({ ease: 2.5, intervalDays: 30, reps: 5, lapses: 0 }, 1, NOW);
    expect(r.reps).toBe(0);
    expect(r.lapses).toBe(1);
    expect(r.intervalDays).toBeLessThan(0.02); // ~10 minutes
    expect(r.dueAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  test('ease falls on failure and rises on easy answers', () => {
    expect(schedule(base, 0, NOW).ease).toBeLessThan(base.ease);
    expect(schedule(base, 5, NOW).ease).toBeGreaterThan(base.ease);
  });

  test('ease is clamped to a sane floor', () => {
    let state = { ...base };
    for (let i = 0; i < 25; i++) {
      const r = schedule(state, 0, NOW);
      state = { ease: r.ease, intervalDays: r.intervalDays, reps: r.reps, lapses: r.lapses };
    }
    expect(state.ease).toBeGreaterThanOrEqual(1.3);
  });

  test('cards flag as leeches at the lapse threshold', () => {
    const r = schedule({ ...base, lapses: LEECH_THRESHOLD - 1 }, 0, NOW);
    expect(r.leech).toBe(true);
  });

  test('cards below the threshold are not leeches', () => {
    const r = schedule({ ...base, lapses: 0 }, 0, NOW);
    expect(r.leech).toBe(false);
  });

  test('intervals are capped so cards never vanish for years', () => {
    const r = schedule({ ease: 3.0, intervalDays: 5000, reps: 20, lapses: 0 }, 5, NOW);
    expect(r.intervalDays).toBeLessThanOrEqual(730);
  });

  test('quality is clamped to the 0..5 range', () => {
    expect(schedule(base, 99, NOW).reps).toBe(1);
    expect(schedule(base, -5, NOW).lapses).toBe(1);
  });

  test('fresh cards are due immediately', () => {
    const s = freshState(NOW);
    expect(new Date(s.dueAt).getTime()).toBe(NOW.getTime());
    expect(s.reps).toBe(0);
    expect(s.leech).toBe(false);
  });
});
