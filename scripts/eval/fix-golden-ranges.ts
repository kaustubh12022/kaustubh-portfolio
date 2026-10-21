#!/usr/bin/env node
/**
 * Rewrite the golden set's evidence ranges to the FULL span of the symbol.
 *
 *   npx tsx scripts/eval/fix-golden-ranges.ts
 *
 * WHY
 * ---
 * The indexer chunks by AST and SPLITS a long function into several chunks.
 * `handleGeminiLiveRelay` is eight chunks that together cover lines 64-631;
 * `score_jobs` is four chunks covering 333-586. A golden set that names only
 * the FIRST chunk of a function calls every other chunk of the same function
 * a miss - which is a measurement artifact, not a retrieval failure.
 *
 * The relevant passage for "where is X implemented" is the WHOLE function, so
 * the expected range has to be the union of the function's chunks. This
 * script reads the union straight out of the live index and rewrites the
 * YAML in place, keeping the comments.
 *
 * It is idempotent: running it twice changes nothing.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseDocument } from "yaml";

import { loadEnv } from "./env.js";

loadEnv();

const { query } = await import("@/lib/retrieval/db.js");

/* ------------------------------------------------------------------ */
/* The union span of every symbol in the index                         */
/* ------------------------------------------------------------------ */

const rows = await query<{
  project_id: string;
  path: string;
  symbol: string;
  lo: number;
  hi: number;
}>(
  `SELECT project_id, path, symbol,
          min(start_line)::int AS lo, max(end_line)::int AS hi
     FROM chunks
    WHERE symbol <> ''
    GROUP BY project_id, path, symbol`,
);

const SPAN = new Map<string, { lo: number; hi: number }>();
for (const row of rows.rows) {
  SPAN.set(`${row.project_id}::${row.path}::${row.symbol}`, {
    lo: row.lo,
    hi: row.hi,
  });
}

/* ------------------------------------------------------------------ */
/* Rewrite the YAML                                                    */
/* ------------------------------------------------------------------ */

const file = path.join(process.cwd(), "evals", "golden-set.yaml");
const doc = parseDocument(readFileSync(file, "utf8"));

let changed = 0;
const untouched: string[] = [];

/**
 * The golden set is a top-level YAML sequence.
 *
 * `doc.contents` is typed as a union of every node kind, so the items have
 * to be narrowed to the sequence shape before they can be iterated.
 */
const sequence = doc.contents;
if (
  !sequence ||
  !("items" in sequence) ||
  !Array.isArray(sequence.items)
) {
  throw new Error(
    "evals/golden-set.yaml must be a top-level sequence of questions.",
  );
}

for (const node of sequence.items) {
  const q = node as {
    get: (key: string, keepScalar?: boolean) => unknown;
  };
  const id = q.get("id") as string;
  const expect = q.get("expect") as {
    get: (key: string) => { items?: unknown[] };
  };
  const evidence = expect.get("evidence") as { items?: unknown[] };
  const items = evidence?.items ?? [];
  for (const item of items) {
    const entry = item as {
      get: (key: string) => unknown;
      set: (key: string, value: unknown) => void;
    };
    const symbol = entry.get("symbol") as string | undefined;
    const project = entry.get("project") as string | undefined;
    const filePath = entry.get("path") as string;
    if (!symbol || !project) continue;

    const span = SPAN.get(`${project}::${filePath}::${symbol}`);
    if (!span) {
      untouched.push(`${id} ${project}/${filePath} ${symbol}`);
      continue;
    }
    const currentStart = entry.get("startLine") as number | undefined;
    const currentEnd = entry.get("endLine") as number | undefined;
    if (currentStart === span.lo && currentEnd === span.hi) continue;
    entry.set("startLine", span.lo);
    entry.set("endLine", span.hi);
    changed += 1;
  }
}

writeFileSync(file, doc.toString({ lineWidth: 0 }), "utf8");

console.log(`[eval] rewrote ${changed} evidence range(s).`);
if (untouched.length > 0) {
  console.log("[eval] no symbol span found for:");
  for (const item of untouched) console.log(`         ${item}`);
}

process.exit(0);
