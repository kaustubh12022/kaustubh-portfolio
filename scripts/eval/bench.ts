#!/usr/bin/env node
/**
 * THE FAST RETRIEVAL BENCHMARK
 *
 *   npx tsx scripts/eval/bench.ts [options]
 *
 * WHY THIS EXISTS
 * ---------------
 * `scripts/eval/retrieval-eval.ts` is the authoritative benchmark: it scores
 * the golden set, prints the per-bucket and per-project tables and writes the
 * JSON report. It takes about four minutes per run, most of it spent
 * embedding the same 79 questions over and over again.
 *
 * This script is the ITERATION LOOP. It caches the query embeddings on disk
 * (`data/bench-embeddings.json`, which is gitignored), so a run costs the SQL
 * time only - about thirty seconds. Every change to the retriever is
 * measured with this script first, and the winner is then confirmed with the
 * authoritative benchmark.
 *
 * IT MEANS THE SAME THING AS THE AUTHORITATIVE BENCHMARK
 * ------------------------------------------------------
 * Same golden set, same scorable-question filter, same metric functions from
 * `lib/eval/metrics.ts`, same overlap semantics for "is this hit relevant".
 * The only difference is the embedding cache.
 *
 * NO LLM CALL. Local ONNX embeddings and the live Neon index only.
 *
 * OPTIONS
 * -------
 *   --tuning <json>   A JSON object overriding the search tuning.
 *                      Example:
 *                      --tuning '{"minVectorChars":40,"testDemotion":0.4}'
 *   --compare <json>  Run the baseline AND the tuned config, side by side.
 *   --out <file>      Write the full report as JSON.
 *   --refresh         Ignore the embedding cache and re-embed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { loadEnv } from "./env.js";

loadEnv();

const { query, closePool } = await import("@/lib/retrieval/db.js");
const { embedQuery } = await import("@/lib/retrieval/embed.js");
const { searchChunks, DEFAULT_TUNING } = await import("@/lib/retrieval/search.js");
const { readGoldenSet, scorableQuestions } = await import("@/lib/eval/golden.js");
const {
  recallAtK,
  hitRate,
  precisionAtK,
  mrrAtK,
  ndcgAtK,
  mean,
} = await import("@/lib/eval/metrics.js");

/* ------------------------------------------------------------------ */
/* Options                                                             */
/* ------------------------------------------------------------------ */

const args = process.argv.slice(2);

function optionValue(name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}

const tuningJson = optionValue("--tuning");
const compareJson = optionValue("--compare");
const tuningFile = optionValue("--tuning-file");
const outPath = optionValue("--out");
const refresh = args.includes("--refresh");
const skipReference = args.includes("--no-reference");

type Tuning = typeof DEFAULT_TUNING;

/**
 * The configuration the retriever had BEFORE Phase C. It is frozen here so
 * that every measurement is against the same reference and the improvement
 * is a number, not a memory.
 */
const REFERENCE_TUNING = {
  minVectorChars: 120,
  vectorWeight: 1,
  keywordWeight: 1,
  excludeTests: false,
  genericTokenDfRatio: 1,
  useIdf: false,
  rerank: false,
  rerankDepth: 20,
};

function parseTuning(raw: string | undefined): Partial<Tuning> {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Partial<Tuning>;
  return parsed;
}

function readTuningFile(path: string): Partial<Tuning> {
  // PowerShell writes a UTF-8 BOM by default; strip it or JSON.parse fails.
  const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  return JSON.parse(raw) as Partial<Tuning>;
}

/* ------------------------------------------------------------------ */
/* The embedding cache                                                 */
/* ------------------------------------------------------------------ */

const CACHE_PATH = join(process.cwd(), "data", "bench-embeddings.json");

type EmbeddingCache = Record<string, number[]>;

function readCache(): EmbeddingCache {
  if (!existsSync(CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as EmbeddingCache;
  } catch {
    return {};
  }
}

function writeCache(cache: EmbeddingCache): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache), "utf8");
}

const cache = refresh ? {} : readCache();
let cacheHits = 0;
let cacheMisses = 0;

async function embeddingFor(key: string, text: string): Promise<Float32Array> {
  const cached = cache[key];
  if (cached) {
    cacheHits += 1;
    return Float32Array.from(cached);
  }
  cacheMisses += 1;
  const vector = await embedQuery(text);
  cache[key] = Array.from(vector);
  return vector;
}

/* ------------------------------------------------------------------ */
/* The corpus size, needed for the IDF thresholds                      */
/* ------------------------------------------------------------------ */

const corpus = await query<{ total: number }>(`SELECT count(*)::int AS total FROM chunks`);
const CORPUS_SIZE = corpus.rows[0]?.total ?? 0;

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

interface Scored {
  id: string;
  bucket: string;
  project?: string;
  recallAt5: number;
  recallAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
  hitRateAt10: number;
  precisionAt10: number;
  fileRecallAt5: number;
  fileRecallAt10: number;
  topPath: string;
}

async function runPass(tuning: Partial<Tuning>): Promise<{
  scored: Scored[];
  summary: Record<string, number>;
  elapsedMs: number;
}> {
  const questions = scorableQuestions(readGoldenSet());
  const scored: Scored[] = [];
  const started = Date.now();

  for (const question of questions) {
    // The embedding depends only on the question text, so the reference pass
    // and the candidate pass share one cache entry.
    const embedding = await embeddingFor(question.id, question.question);

    const hits = await searchChunks(
      {
        query: question.question,
        projectId: question.project,
        limit: 10,
      },
      embedding,
      tuning,
    );

    const expected = question.expect.evidence.map((evidence) => ({
      path: evidence.path,
      startLine: evidence.startLine,
      endLine: evidence.endLine,
      symbol: evidence.symbol,
    }));
    const expectedPaths = expected.map((range) => ({ path: range.path }));

    const hitsForMetrics = hits.map((hit) => ({
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      symbol: hit.symbol,
    }));

    scored.push({
      id: question.id,
      bucket: question.bucket,
      project: question.project,
      recallAt5: recallAtK(hitsForMetrics, expected, 5),
      recallAt10: recallAtK(hitsForMetrics, expected, 10),
      mrrAt10: mrrAtK(hitsForMetrics, expected, 10),
      ndcgAt10: ndcgAtK(hitsForMetrics, expected, 10),
      hitRateAt10: hitRate(hitsForMetrics, expected, 10),
      precisionAt10: precisionAtK(hitsForMetrics, expected, 10),
      fileRecallAt5: recallAtK(hitsForMetrics, expectedPaths, 5),
      fileRecallAt10: recallAtK(hitsForMetrics, expectedPaths, 10),
      topPath: hits[0] ? `${hits[0].path}:${hits[0].startLine}-${hits[0].endLine}` : "-",
    });
  }

  const summary = {
    count: scored.length,
    recallAt5: mean(scored.map((item) => item.recallAt5)),
    recallAt10: mean(scored.map((item) => item.recallAt10)),
    mrrAt10: mean(scored.map((item) => item.mrrAt10)),
    ndcgAt10: mean(scored.map((item) => item.ndcgAt10)),
    hitRateAt10: mean(scored.map((item) => item.hitRateAt10)),
    precisionAt10: mean(scored.map((item) => item.precisionAt10)),
    fileRecallAt5: mean(scored.map((item) => item.fileRecallAt5)),
    fileRecallAt10: mean(scored.map((item) => item.fileRecallAt10)),
  };

  return { scored, summary, elapsedMs: Date.now() - started };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function printSummary(
  label: string,
  summary: Record<string, number>,
  elapsedMs = 0,
): void {
  console.log("");
  console.log(
    `--- ${label} --- (${(elapsedMs / 1000).toFixed(1)}s for ` +
      `${String(summary.count ?? 0)} questions)`,
  );
  console.log(`  chunk recall@5   ${pct(summary.recallAt5).padStart(7)}`);
  console.log(`  chunk recall@10  ${pct(summary.recallAt10).padStart(7)}`);
  console.log(`  MRR@10           ${pct(summary.mrrAt10).padStart(7)}`);
  console.log(`  nDCG@10          ${pct(summary.ndcgAt10).padStart(7)}`);
  console.log(`  hit-rate@10      ${pct(summary.hitRateAt10).padStart(7)}`);
  console.log(`  precision@10     ${pct(summary.precisionAt10).padStart(7)}`);
  console.log(`  FILE  recall@5   ${pct(summary.fileRecallAt5).padStart(7)}`);
  console.log(`  FILE  recall@10  ${pct(summary.fileRecallAt10).padStart(7)}`);
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

console.log(`corpus: ${CORPUS_SIZE} chunks`);

const results: Record<string, unknown> = {
  corpusSize: CORPUS_SIZE,
  referenceTuning: REFERENCE_TUNING,
};

let referenceSummary: Record<string, number> | null = null;

if (!skipReference) {
  const reference = await runPass(REFERENCE_TUNING);
  printSummary(
    "REFERENCE (the pre-Phase-C configuration)",
    reference.summary,
    reference.elapsedMs,
  );
  referenceSummary = reference.summary;
  results.reference = reference.summary;
}

const candidate = tuningFile
  ? readTuningFile(tuningFile)
  : compareJson
    ? parseTuning(compareJson)
    : tuningJson
      ? parseTuning(tuningJson)
      : DEFAULT_TUNING;

const candidatePass = await runPass(candidate);
printSummary("CANDIDATE", candidatePass.summary, candidatePass.elapsedMs);
results.candidate = candidatePass.summary;
results.candidateTuning = candidate;

const delta = referenceSummary
  ? {
      chunkRecallAt5:
        candidatePass.summary.recallAt5 - referenceSummary.recallAt5,
      chunkRecallAt10:
        candidatePass.summary.recallAt10 - referenceSummary.recallAt10,
      mrrAt10: candidatePass.summary.mrrAt10 - referenceSummary.mrrAt10,
      fileRecallAt5:
        candidatePass.summary.fileRecallAt5 - referenceSummary.fileRecallAt5,
      fileRecallAt10:
        candidatePass.summary.fileRecallAt10 - referenceSummary.fileRecallAt10,
    }
  : null;
if (delta) {
  console.log("");
  console.log("--- DELTA (candidate - reference) ---");
  for (const [key, value] of Object.entries(delta)) {
    const sign = value >= 0 ? "+" : "";
    console.log(`  ${key.padEnd(20)} ${sign}${(value * 100).toFixed(1)}pp`);
  }
}
results.delta = delta;

results.candidateWorst = candidatePass.scored
  .filter((item) => item.recallAt5 < 0.5)
  .map((item) => ({
    id: item.id,
    bucket: item.bucket,
    recallAt5: item.recallAt5,
    top: item.topPath,
  }));

results.embeddingCache = { hits: cacheHits, misses: cacheMisses };
console.log(
  `\nembedding cache: ${cacheHits} hits, ${cacheMisses} misses (${CACHE_PATH})`,
);

if (outPath) {
  writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`report written to ${outPath}`);
}

writeCache(cache);
await closePool();
process.exit(0);


