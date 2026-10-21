#!/usr/bin/env node
/**
 * Is the VECTOR leg telling the truth?
 *
 *   npx tsx scripts/eval/check-embeddings.ts [sampleSize]
 *
 * THE DECISIVE TEST
 * -----------------
 * A chunk is embedded as `header + "\n" + content` (see
 * `scripts/index/persist.ts`). So the chunk's own text, embedded with the
 * same model, MUST retrieve that chunk first: the nearest neighbour of a
 * vector is the vector itself.
 *
 * If it does not, the stored vectors do not correspond to the stored
 * content, and EVERY vector-leg ranking in the system is noise. That is
 * the difference between "the retriever is weak" and "the index is broken",
 * and it is worth exactly one free experiment to find out which.
 *
 * It also measures the leg in isolation: recall@5 of the vector leg alone
 * against the golden set, with no keyword leg to rescue it.
 *
 * NO LLM CALL. Embeddings are local.
 */

import { loadEnv } from "./env.js";

loadEnv();

const { query, closePool } = await import("@/lib/retrieval/db.js");
const { embedQuery } = await import("@/lib/retrieval/embed.js");
const { readGoldenSet, scorableQuestions } = await import("@/lib/eval/golden.js");

const SAMPLE = Number(process.argv[2] ?? 40);

/* ------------------------------------------------------------------ */
/* 1. Self-retrieval                                                   */
/* ------------------------------------------------------------------ */

interface ChunkRow {
  id: string;
  project_id: string;
  path: string;
  symbol: string;
  start_line: number;
  end_line: number;
  header: string;
  content: string;
  content_hash: string;
}

const sample = await query<ChunkRow>(
  `SELECT id, project_id, path, symbol, start_line, end_line, header, content, content_hash
     FROM chunks
    WHERE embedding IS NOT NULL
      AND length(content) >= 200
      AND symbol <> ''
    ORDER BY md5(content_hash)
    LIMIT $1`,
  [SAMPLE],
);

console.log("=== SELF-RETRIEVAL: does a chunk find ITSELF? ===");
console.log(
  "the chunk's own text is embedded and searched; the chunk must come back first",
);

let selfFirst = 0;
let selfTop3 = 0;
let selfTop10 = 0;
const selfMisses: string[] = [];

for (const row of sample.rows) {
  const text = `${row.header}\n${row.content}`;
  const embedding = await embedQuery(text);
  // The raw vector leg, no keyword leg, no fusion.
  const hits = await query<{ id: string; path: string }>(
    `SELECT c.id, c.path
       FROM chunks c
      WHERE c.embedding IS NOT NULL
        AND length(c.content) >= 120
        AND ($1::text IS NULL OR c.project_id = $1)
      ORDER BY c.embedding <=> $2::vector
      LIMIT 10`,
    [row.project_id, vectorLiteral(embedding)],
  );
  const rank = hits.rows.findIndex((hit) => hit.id === row.id) + 1;
  if (rank === 1) selfFirst += 1;
  if (rank > 0 && rank <= 3) selfTop3 += 1;
  if (rank > 0 && rank <= 10) selfTop10 += 1;
  if (rank === 0 || rank > 3) {
    selfMisses.push(
      `${row.project_id}/${row.path}:${row.start_line}-${row.end_line} (${row.symbol}) -> rank ${rank || "NOT IN TOP 10"}`,
    );
  }
}

console.log("");
console.log(`sample size   : ${sample.rows.length}`);
console.log(`rank 1        : ${selfFirst} (${pct(selfFirst, sample.rows.length)})`);
console.log(`rank <= 3     : ${selfTop3} (${pct(selfTop3, sample.rows.length)})`);
console.log(`rank <= 10    : ${selfTop10} (${pct(selfTop10, sample.rows.length)})`);
if (selfMisses.length > 0) {
  console.log("");
  console.log("the chunks that did NOT come back first:");
  for (const miss of selfMisses.slice(0, 15)) console.log(`  ${miss}`);
}

/* ------------------------------------------------------------------ */
/* 2. The vector leg on its own                                        */
/* ------------------------------------------------------------------ */

console.log("");
console.log("=== THE VECTOR LEG ALONE, against the golden set ===");

const questions = scorableQuestions(readGoldenSet());
let legFirst = 0;
let legTop5 = 0;
let legTop10 = 0;

for (const question of questions) {
  const embedding = await embedQuery(question.question);
  const hits = await query<{
    path: string;
    start_line: number;
    end_line: number;
    symbol: string;
  }>(
    `SELECT c.path, c.start_line, c.end_line, c.symbol
       FROM chunks c
      WHERE c.embedding IS NOT NULL
        AND length(c.content) >= 120
        AND ($1::text IS NULL OR c.project_id = $1)
      ORDER BY c.embedding <=> $2::vector
      LIMIT 10`,
    [question.project ?? null, vectorLiteral(embedding)],
  );

  const matched = (hit: { path: string; start_line: number; end_line: number }): boolean =>
    question.expect.evidence.some((want) => {
      if (want.path !== hit.path) return false;
      if (typeof want.startLine === "number" && typeof want.endLine === "number") {
        return hit.start_line <= want.endLine && hit.end_line >= want.startLine;
      }
      return true;
    });

  const rows = hits.rows;
  const first = rows.findIndex(matched) + 1;
  if (first === 1) legFirst += 1;
  if (first > 0 && first <= 5) legTop5 += 1;
  if (first > 0 && first <= 10) legTop10 += 1;
}

console.log(`questions     : ${questions.length}`);
console.log(`hit@1         : ${legFirst} (${pct(legFirst, questions.length)})`);
console.log(`hit@5         : ${legTop5} (${pct(legTop5, questions.length)})`);
console.log(`hit@10        : ${legTop10} (${pct(legTop10, questions.length)})`);

await closePool();
process.exit(0);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function pct(value: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

/** The same literal format the retrieval layer uses. */
function vectorLiteral(embedding: Float32Array): string {
  const values = Array.from(embedding, (value) => value.toFixed(8));
  return `[${values.join(",")}]`;
}
