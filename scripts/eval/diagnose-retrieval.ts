#!/usr/bin/env node
/**
 * WHY IS THE RETRIEVER MISSING?
 *
 *   npx tsx scripts/eval/diagnose-retrieval.ts [questionId]
 *
 * For every scorable question it reports where the EXPECTED chunk ended up
 * in each leg: the vector leg, the keyword leg and the fused list. A chunk
 * that is not in the index at all, or that has no embedding, is a different
 * failure from a chunk that was ranked 40th.
 *
 * It also re-embeds the content of the expected chunk and searches for it
 * with its own text. If the chunk cannot find ITSELF, the stored embedding
 * is stale or wrong - that is the bug.
 *
 * NO LLM CALL.
 */

import { loadEnv } from "./env.js";

loadEnv();

const { query, closePool } = await import("@/lib/retrieval/db.js");
const { embedQuery } = await import("@/lib/retrieval/embed.js");
const { searchChunks } = await import("@/lib/retrieval/search.js");
const { readGoldenSet, scorableQuestions } = await import("@/lib/eval/golden.js");

/* ------------------------------------------------------------------ */
/* The index health                                                    */
/* ------------------------------------------------------------------ */

const health = await query<{
  total: number;
  with_embedding: number;
  with_model: number;
  dims: string;
  short: number;
}>(`
  SELECT count(*)::int AS total,
         count(embedding)::int AS with_embedding,
         count(*) FILTER (WHERE embedding_model = 'Xenova/all-MiniLM-L6-v2')::int AS with_model,
         string_agg(DISTINCT embedding_dim::text, ',') AS dims,
         count(*) FILTER (WHERE length(content) < 120)::int AS short
    FROM chunks`);

console.log("=== INDEX HEALTH ===");
console.log(JSON.stringify(health.rows[0], null, 2));

const manifest = await query<{
  project_id: string;
  embedding_model: string;
  embedding_dim: number;
  chunk_count: number;
  live_chunk_count: number;
  indexed_at: Date;
}>(`
  SELECT m.project_id, m.embedding_model, m.embedding_dim, m.chunk_count,
         (SELECT count(*)::int FROM chunks c WHERE c.project_id = m.project_id)
           AS live_chunk_count,
         m.indexed_at
    FROM index_manifest m ORDER BY m.project_id`);
console.log("");
console.log("=== MANIFEST ===");
for (const row of manifest.rows) {
  console.log(
    `${row.project_id.padEnd(18)} model=${row.embedding_model} dim=${row.embedding_dim} ` +
      `manifest=${row.chunk_count} live=${row.live_chunk_count} at=${row.indexed_at}`,
  );
}

/* ------------------------------------------------------------------ */
/* Can a chunk find itself?                                           */
/* ------------------------------------------------------------------ */

console.log("");
console.log("=== SELF-SEARCH (can a chunk find itself?) ===");

const sample = await query<{
  id: string;
  project_id: string;
  path: string;
  symbol: string;
  start_line: number;
  end_line: number;
  content: string;
}>(`
  SELECT id, project_id, path, symbol, start_line, end_line, content
    FROM chunks
   WHERE embedding IS NOT NULL
     AND length(content) >= 200
   ORDER BY project_id, path, start_line
   LIMIT 4`);

for (const row of sample.rows) {
  const needle = row.symbol
    ? `${row.symbol} ${row.path.split("/").pop() ?? ""}`
    : (row.path.split("/").pop() ?? row.path);
  const embedding = await embedQuery(needle);
  const hits = await searchChunks(
    { query: needle, projectId: row.project_id, limit: 10 },
    embedding,
  );
  const rank =
    hits.findIndex((hit) => hit.id === row.id) + 1;
  console.log(
    `${row.project_id}/${row.path}:${row.start_line}-${row.end_line} (${row.symbol || "-"}) ` +
      `self-rank=${rank || "NOT IN TOP 10"} v=${hits.find((h) => h.id === row.id)?.vectorRank ?? "-"} ` +
      `k=${hits.find((h) => h.id === row.id)?.keywordRank ?? "-"}`,
  );
}

/* ------------------------------------------------------------------ */
/* Where the expected chunk ended up                                   */
/* ------------------------------------------------------------------ */

const only = process.argv[2];
const questions = scorableQuestions(readGoldenSet()).filter(
  (question) => !only || question.id === only,
);

console.log("");
console.log("=== WHERE THE EXPECTED CHUNK ENDED UP ===");

interface Row {
  id: string;
  bucket: string;
  question: string;
  project: string;
  expected: string;
  inIndex: boolean;
  hasEmbedding: boolean;
  vectorRank: number | null;
  keywordRank: number | null;
  fusedRank: number | null;
  topPath: string;
}

const rows: Row[] = [];

for (const question of questions) {
  const embedding = await embedQuery(question.question);
  const hits = await searchChunks(
    {
      query: question.question,
      projectId: question.project,
      limit: 40,
    },
    embedding,
  );

  for (const evidence of question.expect.evidence) {
    const project = evidence.project ?? question.project ?? "";
    const start = evidence.startLine;
    const end = evidence.endLine;

    const expectedRow = await query<{
      id: string;
      has_embedding: boolean;
      content: string;
      symbol: string;
    }>(
      `SELECT id, (embedding IS NOT NULL) AS has_embedding, left(content, 160) AS content, symbol
         FROM chunks
        WHERE project_id = $1 AND path = $2
          AND ($3::int IS NULL OR (start_line <= $3 AND end_line >= $4))`,
      [project, evidence.path, start ?? null, end ?? null],
    );
    const found = expectedRow.rows[0];

    const fusedRank =
      hits.findIndex(
        (hit) =>
          hit.path === evidence.path &&
          (start === undefined ||
            end === undefined ||
            (hit.startLine <= end && hit.endLine >= start)),
      ) + 1;
    const hit = hits.find((h) => h.id === found?.id);

    rows.push({
      id: question.id,
      bucket: question.bucket,
      question: question.question,
      project,
      expected: `${evidence.path}${start ? `:${start}-${end}` : ""}${evidence.symbol ? ` (${evidence.symbol})` : ""}`,
      inIndex: Boolean(found),
      hasEmbedding: Boolean(found?.has_embedding),
      vectorRank: hit?.vectorRank ?? null,
      keywordRank: hit?.keywordRank ?? null,
      fusedRank: fusedRank || null,
      topPath: hits[0] ? `${hits[0].path}:${hits[0].startLine}-${hits[0].endLine}` : "-",
    });
  }
}

const missing = rows.filter((row) => !row.inIndex);
const noVector = rows.filter((row) => row.inIndex && !row.hasEmbedding);
const neverKeyword = rows.filter(
  (row) => row.inIndex && row.keywordRank === null && row.fusedRank === null,
);
const neverVector = rows.filter(
  (row) => row.inIndex && row.vectorRank === null && row.fusedRank === null,
);
const foundLate = rows.filter(
  (row) => row.fusedRank !== null && row.fusedRank > 10,
);

console.log(`evidence entries            : ${rows.length}`);
console.log(`not in the index at all      : ${missing.length}`);
console.log(`in the index, no embedding  : ${noVector.length}`);
console.log(`found by NO leg (rank null)  : ${neverKeyword.length}`);
console.log(`  of those, absent from the vector leg : ${neverVector.length}`);
console.log(`found, but below rank 10    : ${foundLate.length}`);
console.log("");
console.log("found below rank 10 (the misses):");
for (const row of foundLate.slice(0, 40)) {
  console.log(
    `  ${row.id} ${row.expected} -> fused rank ${row.fusedRank} ` +
      `(v=${row.vectorRank ?? "-"} k=${row.keywordRank ?? "-"}) | top: ${row.topPath}`,
  );
}

await closePool();
process.exit(0);
