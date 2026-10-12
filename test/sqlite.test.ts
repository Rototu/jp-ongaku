import { beforeEach, describe, expect, test } from 'bun:test';
import { Db } from '../server/sqlite';

/**
 * The libSQL wrapper, held to the bun:sqlite behaviour the app was written
 * against. Each case is a difference that was observed in the raw driver.
 */

let db: Db;

beforeEach(() => {
  db = new Db(':memory:');
  db.exec('CREATE TABLE t (a, b)');
});

describe('the user-database driver', () => {
  test('$-prefixed named params bind their values, not NULL', () => {
    db.prepare<unknown, Record<string, number>>('INSERT INTO t VALUES ($a, $b)').run({
      $a: 1,
      $b: 2,
    });
    expect(db.query('SELECT a, b FROM t').get()).toEqual({ a: 1, b: 2 });
  });

  test('booleans bind as 1 and 0 instead of crashing', () => {
    db.prepare('INSERT INTO t VALUES (?, ?)').run(true, false);
    expect(db.query('SELECT a, b FROM t').get()).toEqual({ a: 1, b: 0 });
  });

  test('a missing row is null', () => {
    expect(db.query('SELECT * FROM t WHERE a = 99').get()).toBeNull();
  });

  test('rows carry no driver metadata', () => {
    db.prepare('INSERT INTO t VALUES (?, ?)').run(1, 2);
    expect(Object.keys(db.query('SELECT a, b FROM t').get() as object)).toEqual(['a', 'b']);
    expect(Object.keys(db.query('SELECT a, b FROM t').all()[0] as object)).toEqual(['a', 'b']);
  });

  test('transactions nest, and an inner failure rolls back only its own part', () => {
    const insert = db.prepare('INSERT INTO t VALUES (?, ?)');
    db.transaction(() => {
      insert.run(1, 1);
      try {
        db.transaction(() => {
          insert.run(2, 2);
          throw new Error('inner');
        })();
      } catch {
        /* the outer transaction carries on */
      }
      insert.run(3, 3);
    })();
    expect(db.query<{ a: number }>('SELECT a FROM t ORDER BY a').all().map((r) => r.a)).toEqual([
      1, 3,
    ]);
  });

  test('an outer failure rolls back everything', () => {
    expect(() =>
      db.transaction(() => {
        db.prepare('INSERT INTO t VALUES (?, ?)').run(1, 1);
        throw new Error('outer');
      })(),
    ).toThrow('outer');
    expect(db.query('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 });
  });

  test('RETURNING comes back through get', () => {
    const row = db.prepare<{ a: number }>('INSERT INTO t VALUES (?, ?) RETURNING a').get(7, 8);
    expect(row).toEqual({ a: 7 });
  });
});
