#!/usr/bin/env node
/**
 * Probe 2: the SOURCE symbols (no tests) of every indexed project.
 *
 *   npx tsx scripts/eval/probe2.ts [projectId]
 */

import { loadEnv } from "./env.js";

loadEnv();

const { query } = await import("@/lib/retrieval/db.js");

const filter = process.argv[2] ?? "";

const rows = await query<{
  project_id: string;
  symbol: string;
  path: string;
  start_line: number;
  end_line: number;
  kind: string;
}>(
  `SELECT DISTINCT ON (project_id, symbol)
          project_id, symbol, path, start_line, end_line, kind
     FROM chunks
    WHERE symbol <> ''
      AND path NOT LIKE 'tests/%'
      AND path NOT LIKE '%/tests/%'
      AND path NOT LIKE 'frontend/src/pages/%'
      AND path NOT LIKE 'src/pages/%'
      AND path NOT LIKE 'src/components/%'
      AND path NOT LIKE 'lib/features/%'
      AND ($1 = '' OR project_id = $1)
    ORDER BY project_id, symbol, start_line`,
  [filter],
);

for (const row of rows.rows) {
  console.log(
    `${row.project_id.padEnd(15)} ${row.kind.padEnd(10)} ${row.symbol.padEnd(46)} ${row.path}:${row.start_line}-${row.end_line}`,
  );
}

process.exit(0);
