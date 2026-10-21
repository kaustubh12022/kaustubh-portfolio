#!/usr/bin/env node
/**
 * WHICH LEG IS ACTUALLY CARRYING THE RETRIEVAL?
 *
 *   npx tsx scripts/eval/leg-comparison.ts
 *
 * `lib/retrieval/search.ts` fuses the vector leg and the keyword leg with
 * Reciprocal Rank Fusion, both at weight 1. That assumes the two legs are
 * worth the same. This script measures whether they are.
 *
 * It runs the real `searchChunks` with a wide limit, reconstructs each
 * leg's own ranking from the per-leg ranks the retriever returns, and
 * scores the golden set under several fusion policies:
 *
 *   vector only        the ANN leg alone
 *   keyword only       the BM25/trigram/substring leg alone
 *   rrf (current)      what the app does today
 *   rrf, vector at 0.5 the vector leg's vote halved
 *   rrf, vector at 0.25
 *   rrf, vector at 0    the keyword leg decides
 *
 * NO LLM CALL. Embeddings are local, the database does the rest.
 */

import { loadEnv } from "./env.js";

loadEnv();

const { closePool } = await import("@/lib/retrieval/db.js");
const { embedQuery } = await import("@/lib/retrieval/embed.js");
const { searchChunks } = await import("@/lib/retrieval/search.js");
const { readGoldenSet, scorableQuestions } = await import("@/lib/eval/golden.js");
const { recallAtK, mrrAtK, hitRate, ndcgAtK } = await import("@/lib/eval/metrics.js");

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

interface Leg {
  name: string;
  ids: string[];
}

interface Expected {
  path: string;
  startLine?: number;
  endLine?: number;
  symbol?: string;
}

/* ------------------------------------------------------------------ */
/* Weighted RRF                                                        */
/* ------------------------------------------------------------------ */

/**
 * RRF where each leg has a weight.
 *
 * `score(d) = sum over legs of weight * 1 / (60 + rank_in_leg(d))`
 *
 * The damping constant stays at 60, exactly as the app uses it: the only
 * thing this script varies is the WEIGHT of the vector leg.
 */
function weightedRrf(legs: Leg[], vectorWeight: number, k = 60): string[] {
  const scores = new Map<string, number>();
  for (const leg of legs) {
    const weight = leg.name === "vector" ? vectorWeight : 1;
    if (weight === 0) continue;
    leg.ids.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map((entry) => entry[0]);
}

/* ------------------------------------------------------------------ */
/* The measurement                                                     */
/* ------------------------------------------------------------------ */

const questions = scorableQuestions(readGoldenSet());

interface Policy {
  name: string;
  /** How to build the ranking out of the two legs. */
  build: (vector: string[], keyword: string[]) => string[];
}

const policies: Policy[] = [
  { name: "vector only", build: (vector) => vector },
  { name: "keyword only", build: (_vector, keyword) => keyword },
  {
    name: "rrf (current, 1.0 / 1.0)",
    build: (vector, keyword) => weightedRrf([{ name: "vector", ids: vector }, { name: "keyword", ids: keyword }], 1),
  },
  {
    name: "rrf vector 0.75",
    build: (vector, keyword) => weightedRrf([{ name: "vector", ids: vector }, { name: "keyword", ids: keyword }], 0.75),
  },
  {
    name: "rrf vector 0.5",
    build: (vector, keyword) => weightedRrf([{ name: "vector", ids: vector }, { name: "keyword", ids: keyword }], 0.5),
  },
  {
    name: "rrf vector 0.25",
    build: (vector, keyword) => weightedRrf([{ name: "vector", ids: vector }, { name: "keyword", ids: keyword }], 0.25),
  },
  {
    name: "rrf vector 0.1",
    build: (vector, keyword) => weightedRrf([{ name: "vector", ids: vector }, { name: "keyword", ids: keyword }], 0.1),
  },
  {
    name: "rrf vector 0 (keyword decides)",
    build: (vector, keyword) => weightedRrf([{ name: "vector", ids: vector }, { name: "keyword", ids: keyword }], 0),
  },
];

/** How many candidates each leg pulls before the fusion. */
const CANDIDATE_DEPTHS = [40, 120];

const scores = new Map<string, number[]>(policies.map((p) => [p.name, []]));

console.log("=== WHICH LEG CARRIES THE RETRIEVAL? ===");
console.log(`questions: ${questions.length}`);
console.log("");

for (const depth of CANDIDATE_DEPTHS) {
  console.log(`--- candidates per leg: ${depth} ---`);
  for (const question of questions) {
    const embedding = await embedQuery(question.question);
    const hits = await searchChunks(
      { query: question.question, projectId: question.project, limit: 200, candidates: depth },
      embedding,
    );

    // Reconstruct each leg's own ranking from the per-leg ranks.
    const withVector = hits
      .filter((hit) => hit.vectorRank !== null)
      .sort((a, b) => (a.vectorRank ?? 0) - (b.vectorRank ?? 0));
    const withKeyword = hits
      .filter((hit) => hit.keywordRank !== null)
      .sort((a, b) => (a.keywordRank ?? 0) - (b.keywordRank ?? 0));

    const vectorIds = withVector.map((hit) => hit.id);
    const keywordIds = withKeyword.map((hit) => hit.id);
    const byId = new Map(hits.map((hit) => [hit.id, hit]));

    const expected: Expected[] = question.expect.evidence.map((evidence) => ({
      path: evidence.path,
      startLine: evidence.startLine,
      endLine: evidence.endLine,
      symbol: evidence.symbol,
    }));

    for (const policy of policies) {
      const ranked = policy.build(vectorIds, keywordIds);
      const hitList = ranked
        .map((id) => byId.get(id))
        .filter((hit): hit is NonNullable<typeof hit> => Boolean(hit))
        .map((hit) => ({
          path: hit.path,
          startLine: hit.startLine,
          endLine: hit.endLine,
          symbol: hit.symbol,
        }));
      const bucket = scores.get(policy.name)!;
      bucket.push(
        recallAtK(hitList, expected, 5),
        recallAtK(hitList, expected, 10),
        mrrAtK(hitList, expected, 10),
        hitRate(hitList, expected, 10),
        ndcgAtK(hitList, expected, 10),
      );
    }
  }

  console.log(
    "policy".padEnd(30) +
      "recall@5".padStart(11) +
      "recall@10".padStart(11) +
      "MRR@10".padStart(10) +
      "hit@10".padStart(10) +
      "nDCG@10".padStart(10),
  );

  for (const policy of policies) {
    const bucket = scores.get(policy.name)!;
    const count = bucket.length / 5;
    // The bucket holds five values PER QUESTION, in the order
    // [recall@5, recall@10, MRR@10, hit@10, nDCG@10]. A metric is therefore
    // every fifth element, NOT a contiguous slice.
    const at = (metricIndex: number): number => {
      const values = bucket.filter((_, index) => index % 5 === metricIndex);
      return values.length === 0
        ? 0
        : values.reduce((sum, value) => sum + value, 0) / values.length;
    };
    const p = (value: number): string => `${(value * 100).toFixed(1)}%`;
    console.log(
      policy.name.padEnd(30) +
        p(at(0)).padStart(11) +
        p(at(1)).padStart(11) +
        at(2).toFixed(3).padStart(10) +
        p(at(3)).padStart(10) +
        p(at(4)).padStart(10),
    );
  }
  console.log("");
}

await closePool();
process.exit(0);
