import Libsql from "libsql";

/**
 * The user database's driver: libSQL, behind the slice of the bun:sqlite API
 * the app was written against.
 *
 * libSQL is what lets the database live online. Opened with a `syncUrl`, the
 * file under data/ becomes an embedded replica of a hosted Turso database:
 * reads stay local and synchronous, writes go to the server, and `sync()`
 * pulls the server's state down. Opened without one it is a plain local
 * SQLite file, which is what the tests and an offline install use.
 *
 * The wrapper exists because libSQL's API is close to bun:sqlite's but not
 * close enough to swap blind. Each difference below was observed, not
 * guessed, and two of them fail silently or fatally:
 *
 * - `$name` keys in a params object bind NULL. bun:sqlite wants the prefix in
 *   the key; libSQL wants it stripped. Left alone, every named parameter in
 *   the queue query would quietly be NULL.
 * - A boolean parameter aborts the whole process from inside the native
 *   module. They become 1 and 0 here, which is what SQLite stores anyway.
 * - `get()` with no row is `undefined`, not `null`.
 * - Every row carries an extra `_metadata` key, which would ride along into
 *   API responses.
 * - Nested `transaction()` throws; bun:sqlite nests with savepoints, and so
 *   does this.
 */

type Binding = string | number | bigint | boolean | null | undefined | Uint8Array;
export type Bindings = Binding[] | Record<string, Binding>;

/** The arguments a statement takes: a tuple as-is, a named-params object alone. */
type Args<P> = P extends unknown[] ? P : [P];

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface RawStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): RunResult;
}

function bind(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

/** Positional args pass through bound; a named-params object loses its `$`s. */
function normalize(params: unknown[]): unknown[] {
  if (
    params.length === 1 &&
    params[0] !== null &&
    typeof params[0] === "object" &&
    !Array.isArray(params[0]) &&
    !(params[0] instanceof Uint8Array)
  ) {
    const named: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params[0] as Record<string, unknown>)) {
      named[key.replace(/^[$:@]/, "")] = bind(value);
    }
    return [named];
  }
  return params.map(bind);
}

function clean<R>(row: unknown): R {
  if (row && typeof row === "object" && "_metadata" in row) {
    delete (row as Record<string, unknown>)._metadata;
  }
  return row as R;
}

export class Statement<R = unknown, P extends Bindings = Binding[]> {
  constructor(private readonly raw: RawStatement) {}

  get(...params: Args<P>): R | null {
    const row = this.raw.get(...normalize(params));
    return row === undefined ? null : clean<R>(row);
  }

  all(...params: Args<P>): R[] {
    return this.raw.all(...normalize(params)).map((row) => clean<R>(row));
  }

  run(...params: Args<P>): RunResult {
    return this.raw.run(...normalize(params));
  }
}

export interface OpenOptions {
  /** Turso database URL. With it, the local file is an embedded replica. */
  syncUrl?: string;
  authToken?: string;
}

export class Db {
  private readonly conn: Libsql.Database;
  private readonly cache = new Map<string, RawStatement>();
  private depth = 0;
  /** Whether this is a replica of a hosted database rather than a local file. */
  readonly remote: boolean;

  constructor(path: string, opts: OpenOptions = {}) {
    this.remote = !!opts.syncUrl;
    // The runtime takes `authToken`; the bundled typings predate it.
    this.conn = opts.syncUrl
      ? new Libsql(path, {
          syncUrl: opts.syncUrl,
          authToken: opts.authToken,
        } as Libsql.Options)
      : new Libsql(path);
  }

  /** A statement compiled once and reused, as bun:sqlite's `query` does. */
  query<R = unknown, P extends Bindings = Binding[]>(sql: string): Statement<R, P> {
    let raw = this.cache.get(sql);
    if (!raw) {
      raw = this.conn.prepare(sql) as unknown as RawStatement;
      this.cache.set(sql, raw);
    }
    return new Statement<R, P>(raw);
  }

  prepare<R = unknown, P extends Bindings = Binding[]>(sql: string): Statement<R, P> {
    return new Statement<R, P>(this.conn.prepare(sql) as unknown as RawStatement);
  }

  exec(sql: string): void {
    this.conn.exec(sql);
  }

  /**
   * Wraps `fn` so it runs atomically. The outermost call is a transaction; a
   * call inside one is a savepoint, so an inner failure rolls back only its
   * own part and the outer caller decides what happens to the rest.
   */
  transaction<A extends unknown[], T>(fn: (...args: A) => T): (...args: A) => T {
    return (...args: A) => {
      const name = `sp${this.depth}`;
      const outer = this.depth === 0;
      this.conn.exec(outer ? "BEGIN" : `SAVEPOINT ${name}`);
      this.depth++;
      try {
        const result = fn(...args);
        this.depth--;
        this.conn.exec(outer ? "COMMIT" : `RELEASE ${name}`);
        return result;
      } catch (err) {
        this.depth--;
        this.conn.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${name}; RELEASE ${name}`);
        throw err;
      }
    };
  }

  /** Pulls the hosted database's state into the local replica. No-op locally. */
  sync(): void {
    if (this.remote) this.conn.sync();
  }

  close(): void {
    this.cache.clear();
    this.conn.close();
  }
}
