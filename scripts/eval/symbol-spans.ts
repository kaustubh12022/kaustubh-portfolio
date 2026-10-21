#!/usr/bin/env node
/**
 * Print the FULL line span of every symbol in the index.
 *
 *   npx tsx scripts/eval/symbol-spans.ts [project]
 *
 * The chunker splits a long function into several chunks, so the span of a
 * symbol is the UNION of its chunks, not the first one.
 */

import { loadEnv } from "./env.js";

loadEnv();

const { query } = await import("@/lib/retrieval/db.js");

const filter = process.argv[2] ?? "";

const rows = await query<{
  project_id: string;
  path: string;
  symbol: string;
  lo: number;
  hi: number;
  n: number;
}>(
  `SELECT project_id, path, symbol,
          min(start_line)::int AS lo, max(end_line)::int AS hi,
          count(*)::int AS n
     FROM chunks
    WHERE symbol <> ''
      AND ($1 = '' OR project_id = $1)
    GROUP BY project_id, path, symbol
    ORDER BY project_id, path, lo`,
  [filter],
);

for (const row of rows.rows) {
  console.log(
    `${row.project_id}\t${row.path}\t${row.symbol}\t${row.lo}\t${row.hi}\t${row.n}`,
  );
}

process.exit(0);
