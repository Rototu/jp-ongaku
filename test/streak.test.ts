import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { _setDbForTests, getDb } from '../server/db';
import * as srs from '../server/srs/store';

/**
 * Streak counting must use one definition of "day".
 *
 * The bug this guards against: bucketing review timestamps with SQLite's
 * `localtime` (operating-system zone) while comparing against JavaScript's
 * local date (TZ environment variable). When the two zones disagree the streak
 * silently reads zero.
 */

beforeEach(() => {
  _setDbForTests(new Database(':memory:'));
  const db = getDb();
  db.prepare(
    `INSERT INTO cards (kind, dedupe_key, front, back, created_at)
     VALUES ('vocab', 'k', '{}', '{"answer":"x"}', datetime('now'))`,
  ).run();
  db.prepare('INSERT INTO srs (card_id, due_at) VALUES (1, datetime(\'now\'))').run();
});

afterEach(() => {
  _setDbForTests(null);
});

/** Records a review `daysAgo` local days back, at local midday. */
function reviewDaysAgo(daysAgo: number) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(12, 0, 0, 0);
  getDb()
    .prepare('INSERT INTO reviews (card_id, ts, quality, ms) VALUES (1, ?, 5, 0)')
    .run(d.toISOString());
}

describe('streak', () => {
  test('is zero with no reviews', () => {
    expect(srs.stats().streakDays).toBe(0);
  });

  test('counts a review made today', () => {
    reviewDaysAgo(0);
    expect(srs.stats().streakDays).toBe(1);
  });

  test('counts consecutive days', () => {
    reviewDaysAgo(0);
    reviewDaysAgo(1);
    reviewDaysAgo(2);
    expect(srs.stats().streakDays).toBe(3);
  });

  test('several reviews in one day count once', () => {
    reviewDaysAgo(0);
    reviewDaysAgo(0);
    reviewDaysAgo(1);
    expect(srs.stats().streakDays).toBe(2);
  });

  test('survives a missed today when yesterday was done', () => {
    reviewDaysAgo(1);
    reviewDaysAgo(2);
    expect(srs.stats().streakDays).toBe(2);
  });

  test('breaks on a gap', () => {
    reviewDaysAgo(0);
    reviewDaysAgo(1);
    reviewDaysAgo(3); // day 2 missed
    expect(srs.stats().streakDays).toBe(2);
  });

  test('is zero when the last review is older than yesterday', () => {
    reviewDaysAgo(5);
    expect(srs.stats().streakDays).toBe(0);
  });

  test('a review late tonight still counts as today', () => {
    // Late-evening local time is already tomorrow in UTC for zones ahead of it.
    // The streak must follow the user's calendar, not UTC's.
    const d = new Date();
    d.setHours(23, 50, 0, 0);
    getDb()
      .prepare('INSERT INTO reviews (card_id, ts, quality, ms) VALUES (1, ?, 5, 0)')
      .run(d.toISOString());
    expect(srs.stats().streakDays).toBe(1);
  });

  test('an early-morning review still counts as today', () => {
    const d = new Date();
    d.setHours(0, 10, 0, 0);
    getDb()
      .prepare('INSERT INTO reviews (card_id, ts, quality, ms) VALUES (1, ?, 5, 0)')
      .run(d.toISOString());
    expect(srs.stats().streakDays).toBe(1);
  });

  test('reviewsToday agrees with the streak about what today is', () => {
    reviewDaysAgo(0);
    const s = srs.stats();
    expect(s.reviewsToday).toBe(1);
    expect(s.streakDays).toBe(1);
  });

  test('a long run counts correctly across a month boundary', () => {
    for (let i = 0; i < 40; i++) reviewDaysAgo(i);
    expect(srs.stats().streakDays).toBe(40);
  });
});
