#!/usr/bin/env node
/**
 * Probe 3: the line span of every indexed path.
 *
 *   npx tsx scripts/eval/probe3.ts
 */

import { loadEnv } from "./env.js";

loadEnv();

const { query } = await import("@/lib/retrieval/db.js");

const rows = await query<{
  project_id: string;
  path: string;
  lo: number;
  hi: number;
  n: number;
}>(
  `SELECT project_id, path, min(start_line)::int AS lo, max(end_line)::int AS hi,
          count(*)::int AS n
     FROM chunks
    GROUP BY project_id, path
    ORDER BY project_id, path`,
);

for (const row of rows.rows) {
  console.log(
    `${row.project_id.padEnd(15)} ${String(row.lo).padStart(4)}-${String(row.hi).padEnd(5)} [${String(row.n).padStart(3)}] ${row.path}`,
  );
}

process.exit(0);
