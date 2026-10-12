import Libsql from "libsql";

/**
 * The user database's driver: libSQL, behind the slice of the bun:sqlite API
 * the app was written against.
 *
 * libSQL is what lets the database live online. Opened with a `syncUrl`, the
 * file under data/ becomes a replica of a hosted Turso database in offline
 * mode: reads and writes both happen locally, at local speed, and `sync()`
 * pushes new writes up and pulls the server's state down. A push is scheduled
 * a couple of seconds after each burst of writes, so the server is never far
 * behind, and nothing waits on the network. Opened without a `syncUrl` it is a
 * plain local SQLite file, which is what the tests and an offline install use.
 *
 * Offline mode rather than the default replica because the default sends
 * every write to the server and waits: measured against Turso in Dublin, one
 * insert took ~470 ms and a 200-insert transaction 37 s — a song import would
 * take minutes and every grade a second. Offline, the same 200 inserts take
 * 1 ms and the push ~0.3 s. The cost is that two machines writing at once
 * would conflict; this is a single-user app, used from one machine at a time.
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

/**
 * Whether a statement can only read. Anything else counts as a write and
 * schedules a push — including `get()` on an `INSERT … RETURNING`, which is how
 * most rows here are created. A false "write" costs one needless push; a
 * false "read" would leave a change sitting unpushed, so the test is strict.
 */
export function readOnly(sql: string): boolean {
  return /^\s*(SELECT|PRAGMA\s+\w+\s*(\(|$)|EXPLAIN)/i.test(sql) && !/\bRETURNING\b/i.test(sql);
}

export class Statement<R = unknown, P extends Bindings = Binding[]> {
  constructor(
    private readonly raw: RawStatement,
    private readonly onWrite: (() => void) | null,
  ) {}

  get(...params: Args<P>): R | null {
    const row = this.raw.get(...normalize(params));
    this.onWrite?.();
    return row === undefined ? null : clean<R>(row);
  }

  all(...params: Args<P>): R[] {
    const rows = this.raw.all(...normalize(params)).map((row) => clean<R>(row));
    this.onWrite?.();
    return rows;
  }

  run(...params: Args<P>): RunResult {
    const result = this.raw.run(...normalize(params));
    this.onWrite?.();
    return result;
  }
}

/** How long after the last write the push waits, so a burst goes up as one. */
const PUSH_DELAY_MS = 2_000;
/** After a failed push — no network, say — when to try again. */
const RETRY_DELAY_MS = 30_000;

export interface OpenOptions {
  /** Turso database URL. With it, the local file is an embedded replica. */
  syncUrl?: string;
  authToken?: string;
}

export class Db {
  private readonly conn: Libsql.Database;
  private readonly cache = new Map<string, RawStatement>();
  private depth = 0;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether this is a replica of a hosted database rather than a local file. */
  readonly remote: boolean;

  constructor(path: string, opts: OpenOptions = {}) {
    this.remote = !!opts.syncUrl;
    // The runtime takes `authToken`; the bundled typings predate it.
    this.conn = opts.syncUrl
      ? new Libsql(path, {
          syncUrl: opts.syncUrl,
          authToken: opts.authToken,
          offline: true,
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
    return new Statement<R, P>(raw, this.writeHook(sql));
  }

  prepare<R = unknown, P extends Bindings = Binding[]>(sql: string): Statement<R, P> {
    return new Statement<R, P>(
      this.conn.prepare(sql) as unknown as RawStatement,
      this.writeHook(sql),
    );
  }

  exec(sql: string): void {
    this.conn.exec(sql);
    if (this.remote && !readOnly(sql)) this.schedulePush();
  }

  private writeHook(sql: string): (() => void) | null {
    return this.remote && !readOnly(sql) ? () => this.schedulePush() : null;
  }

  /**
   * Pushes local writes up once they stop coming. Inside a transaction the
   * timer only moves; the push itself always runs from the event loop, which
   * can never be mid-transaction, since transactions here are synchronous.
   */
  private schedulePush(delay = PUSH_DELAY_MS): void {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      if (!this.trySync()) this.schedulePush(RETRY_DELAY_MS);
    }, delay);
    // A pending push must never be what keeps a process alive.
    this.pushTimer.unref?.();
  }

  /** Syncs, reporting rather than throwing: the app works without a network. */
  trySync(): boolean {
    try {
      this.sync();
      return true;
    } catch (err) {
      console.error(`[db] sync with the online database failed: ${String(err)}`);
      return false;
    }
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

  /**
   * Pushes local writes to the hosted database and pulls its state down.
   * No-op for a local file. Throws on failure; see trySync.
   */
  sync(): void {
    if (this.remote) this.conn.sync();
  }

  /** Closes the connection, pushing anything still waiting first. */
  close(): void {
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    if (this.remote) this.trySync();
    this.cache.clear();
    this.conn.close();
  }
}
