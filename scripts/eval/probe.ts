#!/usr/bin/env node
/**
 * Probe the live index.
 *
 *   npx tsx scripts/eval/probe.ts
 *
 * Prints the shape of the index: the projects, the chunk counts, the paths
 * and the symbols. It is the tool that turns the golden set from a guess into
 * a set of questions that point at REAL files.
 *
 * NOTE: `lib/retrieval/db.ts` carries `import "server-only"`, which throws
 * outside a React Server Component context. The scripts therefore run with
 * `NODE_OPTIONS=--conditions=react-server`.
 */

import { loadEnv } from "./env.js";

loadEnv();

const { query } = await import("@/lib/retrieval/db.js");

const projects = await query<{
  project_id: string;
  file_count: number;
  chunk_count: number;
  live_chunk_count: number;
}>(
  `SELECT m.project_id, m.file_count, m.chunk_count,
          (SELECT count(*)::int FROM chunks c WHERE c.project_id = m.project_id)
            AS live_chunk_count
     FROM index_manifest m
    ORDER BY m.project_id`,
);

console.log("=== PROJECTS ===");
for (const row of projects.rows) {
  console.log(
    `${row.project_id.padEnd(16)} files=${String(row.file_count).padStart(4)} ` +
      `chunks=${String(row.live_chunk_count).padStart(5)}`,
  );
}

const total = await query<{ n: number }>(
  "SELECT count(*)::int AS n FROM chunks",
);
console.log(`TOTAL CHUNKS: ${total.rows[0]?.n}`);

const paths = await query<{ project_id: string; path: string; n: number }>(
  `SELECT project_id, path, count(*)::int AS n
     FROM chunks
    GROUP BY project_id, path
    ORDER BY project_id, path`,
);
console.log(`\n=== PATHS (${paths.rows.length}) ===`);
for (const row of paths.rows) {
  console.log(`${row.project_id.padEnd(16)} ${row.path}  [${row.n}]`);
}

const symbols = await query<{
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
    ORDER BY project_id, symbol, start_line`,
);
console.log(`\n=== SYMBOLS (${symbols.rows.length}) ===`);
for (const row of symbols.rows) {
  console.log(
    `${row.project_id.padEnd(16)} ${row.kind.padEnd(12)} ${row.symbol.padEnd(42)} ${row.path}:${row.start_line}-${row.end_line}`,
  );
}

process.exit(0);
