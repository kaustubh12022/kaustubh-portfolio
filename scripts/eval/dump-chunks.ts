#!/usr/bin/env node
/** Print the chunk spans of every file of a project. Free, no LLM. */
import { loadEnv } from "./env.js";

loadEnv();
const { query, closePool } = await import("@/lib/retrieval/db.js");

const filter = process.argv[2] ?? "";
const rows = await query<{
  project_id: string;
  path: string;
  symbol: string;
  kind: string;
  start_line: number;
  end_line: number;
}>(
  `SELECT project_id, path, symbol, kind, start_line, end_line
     FROM chunks
    WHERE ($1 = '' OR path ILIKE '%' || $1 || '%' OR project_id = $1)
    ORDER BY project_id, path, start_line`,
  [filter],
);

for (const row of rows.rows) {
  console.log(
    [
      row.project_id,
      row.path,
      row.symbol || "-",
      row.kind,
      `${row.start_line}-${row.end_line}`,
    ].join(" | "),
  );
}

await closePool();
process.exit(0);
