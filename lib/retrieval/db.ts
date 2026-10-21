/**
 * Database layer for the conversational portfolio.
 *
 * WHAT THIS MODULE GUARANTEES
 * ---------------------------
 * 1. `import "server-only"` - the module throws when it is pulled into a
 *    client bundle, so `DATABASE_URL` can never leak to the browser.
 * 2. The pool is created LAZILY. `process.env.DATABASE_URL` is read on the
 *    first call, not at module load, so `next build` (which evaluates server
 *    modules without secrets) does not crash.
 * 3. App traffic uses the POOLED `DATABASE_URL`. Migrations and other
 *    session-state-sensitive work set `MIGRATIONS=1` to get the direct
 *    `DATABASE_URL_UNPOOLED` connection instead.
 * 4. Every pooled connection gets `hnsw.ef_search = 100`. The pgvector
 *    default of 40 costs about 5 points of recall@10 on a corpus of this
 *    shape, which is the classic cause of a RAG pipeline that "hallucinates
 *    on edge cases". See `lib/retrieval/pg.ts` for the full story, including
 *    the measured numbers for this corpus (recall@10 was 1.00 at both 40 and
 *    100, because the corpus is small enough for the graph to be exact).
 *
 * THE VECTOR LEG NEEDS A DIRECT CONNECTION
 * ----------------------------------------
 * The ANN index is a `lakebase_ann` index (Lakebase's own Rust access
 * method, not pgvector's `hnsw`). It CANNOT be used through the Neon
 * pooler - every ANN query sent over the pooled endpoint fails with
 *
 *     XX000 usage: need 0 probes, but 1 probes provided
 *
 * This is not a configuration problem: it fails with the simple query
 * protocol, with the extended protocol, with and without channel binding,
 * and for every LIMIT. The same query works on the direct endpoint. The
 * vector leg therefore runs on {@link getDirectPool}, while the keyword
 * legs (plain SQL) stay on the pooled connection.
 *
 * The schema this module talks to lives in `lib/retrieval/schema.sql`.
 */

import "server-only";

import {
  ANN_EF_SEARCH,
  createPgPool,
  type PgClient,
  type PgPool,
  type PgQueryResult,
} from "./pg";

export type { PgClient, PgPool, PgQueryResult };

/** The pooled pool. Created on first use, never at module load. */
let pool: PgPool | null = null;

/** The direct (unpooled) pool used by the ANN leg. */
let directPool: PgPool | null = null;

/**
 * Resolve the connection string for the current mode.
 *
 * `MIGRATIONS=1` switches to the direct (unpooled) connection so that
 * `CREATE INDEX`, `ANALYZE` and other statements that need a stable session
 * are not multiplexed by the pooler.
 *
 * @param direct force the direct connection, whatever the mode is
 */
export function resolveDatabaseUrl(direct = false): string {
  const useUnpooled = direct || process.env.MIGRATIONS === "1";
  const key = useUnpooled ? "DATABASE_URL_UNPOOLED" : "DATABASE_URL";
  const url = process.env[key];
  if (!url) {
    throw new Error(
      `[retrieval] ${key} is not set. Add it to .env.local (pooled) and ` +
        `DATABASE_URL_UNPOOLED (direct) before using the retrieval layer.`,
    );
  }
  return url;
}

/**
 * The shared connection pool.
 *
 * Lazy on purpose: importing this module must never require an env var.
 */
export function getPool(): PgPool {
  if (pool) return pool;
  pool = createPgPool(resolveDatabaseUrl());
  return pool;
}

/**
 * The direct (unpooled) pool.
 *
 * Required by the ANN leg: the `lakebase_ann` access method does not work
 * through the Neon pooler. Keep the pool small, it is only used for the
 * vector query.
 */
export function getDirectPool(): PgPool {
  if (directPool) return directPool;
  directPool = createPgPool(resolveDatabaseUrl(true), { max: 4 });
  return directPool;
}

/**
 * Run a parameterised query on the shared pool.
 *
 * @example
 * const rows = await query<{ id: string }>("SELECT id FROM chunks LIMIT 1");
 */
export async function query<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<PgQueryResult<T>> {
  return getPool().query<T>(text, values);
}

/**
 * Run `fn` inside a transaction. The client is always released, and the
 * transaction is rolled back when `fn` throws.
 */
export async function withTransaction<T>(
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  return runInTransaction(getPool(), fn);
}

/**
 * Run `fn` inside a transaction on the DIRECT connection.
 *
 * Used by the vector leg: the `lakebase_ann` access method cannot be used
 * through the Neon pooler.
 */
export async function withDirectTransaction<T>(
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  return runInTransaction(getDirectPool(), fn);
}

async function runInTransaction<T>(
  target: PgPool,
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await target.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Pin the ANN search effort for the duration of the current transaction.
 *
 * The Neon pooler multiplexes transactions over a pool of server backends and
 * resets session state between them, so a session level `SET` performed when
 * the connection was opened is not guaranteed to still be in effect. `SET
 * LOCAL` is transaction scoped and therefore always correct - the ANN leg
 * calls this before the vector query.
 *
 * The statements run inside a savepoint: if the GUC does not exist in this
 * backend (the pgvector library was not loaded yet) the failure must not
 * abort the surrounding transaction.
 */
export async function setLocalSearchEffort(client: PgClient): Promise<void> {
  const savepoint = "ann_search_effort";
  try {
    await client.query(`SAVEPOINT ${savepoint}`);
  } catch {
    return;
  }
  try {
    // Load pgvector into this backend so the GUCs exist.
    await client.query(`SELECT '[0]'::vector`);
    await client.query(`SET LOCAL hnsw.ef_search = ${ANN_EF_SEARCH}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  } catch (error) {
    await client
      .query(`ROLLBACK TO SAVEPOINT ${savepoint}`)
      .catch(() => undefined);
    console.warn(
      "[retrieval] could not pin the ANN search effort:",
      (error as Error).message,
    );
  }
}

/** Close both pools. Safe to call when a pool was never created. */
export async function closePool(): Promise<void> {
  const pools = [pool, directPool].filter((item): item is PgPool => item !== null);
  pool = null;
  directPool = null;
  for (const item of pools) {
    await item.end().catch(() => undefined);
  }
}
