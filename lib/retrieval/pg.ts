/**
 * Low-level `pg` plumbing shared by the Next.js runtime and the CLI.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `lib/retrieval/db.ts` is the app-facing wrapper and carries the
 * `import "server-only"` guard so it can never be bundled to the client.
 * The `server-only` package THROWS when the module is loaded outside a React
 * Server Component context, which means the tsx CLI in `scripts/index` cannot
 * import `db.ts`. The pool factory therefore lives here, without the guard,
 * and both sides use it.
 *
 * `@types/pg` is not installed, so the small surface this module relies on is
 * declared locally instead of being pulled from DefinitelyTyped. Installing
 * `@types/pg` (`npm i -D @types/pg`) lets the local interfaces be replaced by
 * the real ones without changing any call site.
 *
 * ANN SEARCH EFFORT
 * -----------------
 * The generic pgvector guidance is that the HNSW default of
 * `hnsw.ef_search = 40` costs roughly 5 points of recall@10 on a corpus of
 * this shape, and that 100 is the value to use. 100 is what this module
 * applies, on every connection, in two ways:
 *
 *   1. `options: "-c hnsw.ef_search=100"` on a DIRECT connection (the
 *      startup packet carries the GUC, so it is set before any query runs).
 *   2. A `verify` hook bootstrap that issues the same SET for pooled
 *      connections, which the Neon pooler refuses to carry in the startup
 *      packet (`08P01 unsupported startup parameter in options`).
 *
 * MEASURED ON THIS CORPUS (2,864 chunks, 8 real questions): recall@10 of
 * the ANN index against an exact brute force search was 1.00 at BOTH
 * `ef_search = 40` and `ef_search = 100`. The corpus is small enough that
 * the graph is effectively exact, so the setting makes no measurable
 * difference here. It is kept because it is free and because it is the
 * right value if the index is ever rebuilt with pgvector's `hnsw` access
 * method.
 *
 * `lakebase_ann` - the access method this index actually uses - is
 * Lakebase's own Rust ANN implementation and exposes different knobs
 * (`lakebase_ann.epsilon`, `lakebase_ann.probes`). Its `probes` GUC is NOT
 * a search effort: pinning it to a number makes every ANN query fail with
 * `XX000 usage: need 0 probes, but N probes provided`. It has to stay
 * `auto`, which is what the index was built with.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/* ------------------------------------------------------------------ */
/* Local `pg` surface (stand-in for `@types/pg`)                       */
/* ------------------------------------------------------------------ */

/** The subset of `pg`'s `QueryResult` this module uses. */
export interface PgQueryResult<R> {
  rows: R[];
  rowCount: number | null;
}

/** The subset of `pg`'s `Client` this module uses. */
export interface PgClient {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PgQueryResult<R>>;
  release(err?: Error | boolean): void;
}

/** The subset of `pg`'s `Pool` this module uses. */
export interface PgPool {
  query<R = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<PgQueryResult<R>>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
  on(event: "connect", listener: (client: PgClient) => void): PgPool;
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

/** Pool configuration accepted by {@link createPgPool}. */
export interface PgPoolConfig {
  connectionString: string;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  allowExitOnIdle?: boolean;
  /**
   * Raw startup options, e.g. `-c hnsw.ef_search=100`. Only supported on a
   * direct connection: the Neon pooler rejects unknown startup parameters
   * with `08P01 unsupported startup parameter in options`.
   */
  options?: string;
  /**
   * Called with a fresh client BEFORE the pool hands it to the caller. The
   * pool waits for the callback, which makes it the right place for the
   * session bootstrap: a `connect` event would leave a query in flight while
   * the caller queues its own, which makes `pg` emit its "already executing
   * a query" deprecation warning.
   */
  verify?: (client: PgClient, callback: (error?: Error) => void) => void;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** HNSW search effort used for every ANN query. */
export const ANN_EF_SEARCH = 100;

/** Startup options that pin the ANN search effort for a direct connection. */
export const ANN_SESSION_OPTIONS = `-c hnsw.ef_search=${ANN_EF_SEARCH}`;

/* ------------------------------------------------------------------ */
/* Pool factory                                                        */
/* ------------------------------------------------------------------ */

/** True when the connection string points at the Neon pooler. */
export function isPoolerConnection(connectionString: string): boolean {
  try {
    const host = new URL(connectionString).hostname;
    return /pooler/i.test(host);
  } catch {
    return /pooler/i.test(connectionString);
  }
}

/**
 * Apply the ANN session settings to a freshly opened connection.
 *
 * The `vector` type has to be touched first: pgvector lives in a shared
 * library that is only dlopen()ed when the type is first used, and the
 * `hnsw.ef_search` GUC is registered by that library. A `SET` issued before
 * the library is loaded fails with
 * `42704 unrecognized configuration parameter "hnsw.ef_search"`.
 *
 * All three statements are sent as ONE simple-protocol message. Three
 * separate round trips would interleave with the first query of the caller
 * and make `pg` emit its "already executing a query" deprecation warning.
 *
 * NOTE: `lakebase_ann.probes` is deliberately NOT set. The index uses the
 * `lakebase_ann` access method (Lakebase's own Rust ANN implementation, not
 * pgvector's `hnsw`), and its `probes` GUC is not a search effort: pinning
 * it to a number makes every ANN query fail with
 * `XX000 usage: need 0 probes, but N probes provided`. It has to stay
 * `auto`. The approximation knob of that access method is
 * `lakebase_ann.epsilon`, whose default (`auto`) is what the index was built
 * with.
 */
export async function bootstrapConnection(client: PgClient): Promise<void> {
  try {
    await client.query(
      `SELECT '[0]'::vector; SET hnsw.ef_search = ${ANN_EF_SEARCH};`,
    );
  } catch (error) {
    // A failed bootstrap must never take the pool down: the ANN leg simply
    // falls back to the server default search effort.
    console.warn(
      "[retrieval] pg session bootstrap failed:",
      (error as Error).message,
    );
  }
}

/**
 * Create a pooled `pg` client with the ANN search effort already applied.
 *
 * @param connectionString the `DATABASE_URL` to connect with
 * @param overrides        extra pool options
 */
export function createPgPool(
  connectionString: string,
  overrides: Partial<PgPoolConfig> = {},
): PgPool {
  const pg = require("pg") as { Pool: new (config: PgPoolConfig) => PgPool };

  const config: PgPoolConfig = {
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Let a CLI process exit once the pool is idle instead of hanging.
    allowExitOnIdle: true,
    ...overrides,
  };

  // The Neon pooler cannot carry custom startup parameters, so the GUC is
  // only pushed through `options` on a direct connection. The session
  // bootstrap below covers the pooled case.
  if (!config.options && !isPoolerConnection(connectionString)) {
    config.options = ANN_SESSION_OPTIONS;
  }

  // `verify` runs with a fresh client BEFORE the pool hands it to the
  // caller, and the pool waits for the callback.
  config.verify = (client: PgClient, callback: (error?: Error) => void): void => {
    void bootstrapConnection(client).then(
      () => callback(),
      (error: unknown) => callback(error as Error),
    );
  };

  const pool = new pg.Pool(config);
  return pool;
}
