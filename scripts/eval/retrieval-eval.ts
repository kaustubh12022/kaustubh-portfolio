#!/usr/bin/env node
/**
 * The retrieval benchmark.
 *
 *   npx tsx scripts/eval/retrieval-eval.ts [--questions=q001,q002] [--json]
 *
 * It runs the golden set's questions against the LIVE index (embedding only,
 * no LLM) and reports how good the retriever is.
 *
 * WHY ONLY THE QUESTIONS WITH EXPECTED EVIDENCE
 * ----------------------------------------------
 * A question that is answered from the content layer (metrics, claims,
 * comparisons, refusals) has no code target: there is nothing for the
 * retriever to find. Those questions are answered by `get_metrics`,
 * `get_claim`, `compare_projects` and the profile, and they are scored by the
 * ANSWER benchmark instead. Here they are listed as "not scorable".
 *
 * THE THRESHOLDS
 * --------------
 *   recall@5  >= 0.85   the right file is in the top five
 *   MRR@10    >= 0.75   the right file is found EARLY
 *
 * Exit code 1 when a threshold is not met.
 *
 * NOTE: `lib/retrieval/db.ts` carries `import "server-only"`, so the script
 * has to run with `NODE_OPTIONS=--conditions=react-server`.
 */

import { writeFileSync } from "node:fs";

import { loadEnv } from "./env.js";

import {
  readGoldenSet,
  selectQuestions,
  scorableQuestions,
} from "@/lib/eval/golden";
import {
  aggregate,
  hitRate,
  mrrAtK,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  type HitLike,
} from "@/lib/eval/metrics";

loadEnv();

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

interface CliOptions {
  questions: string[];
  json: boolean;
  limit: number;
  /** Where to write the JSON report. */
  out: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { questions: [], json: false, limit: 10, out: null };
  for (const arg of argv) {
    if (arg.startsWith("--questions=")) {
      options.questions = arg
        .slice("--questions=".length)
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg.startsWith("--limit=")) {
      options.limit = Number(arg.slice("--limit=".length));
    } else if (arg.startsWith("--out=")) {
      options.out = arg.slice("--out=".length);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

/* ------------------------------------------------------------------ */
/* Thresholds                                                          */
/* ------------------------------------------------------------------ */

export const RECALL_AT_5_THRESHOLD = 0.85;
export const MRR_AT_10_THRESHOLD = 0.75;

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

const { embedQuery } = await import("@/lib/retrieval/embed.js");
const { searchChunks } = await import("@/lib/retrieval/search.js");

const all = readGoldenSet();
const selected = selectQuestions(all, options.questions);
const scorable = scorableQuestions(selected);

if (!options.json) {
  console.log(
    `[eval] ${selected.length} question(s) selected, ${scorable.length} scorable ` +
      `against the live index.`,
  );
  console.log(
    "[eval] embedding model is loading (first run downloads it, ~12 s)...",
  );
}

interface HitRecord extends HitLike {
  projectId: string;
  score: number;
  vectorRank: number | null;
  keywordRank: number | null;
}

interface QuestionRecord {
  id: string;
  bucket: string;
  project: string | undefined;
  question: string;
  metrics: {
    recallAt5: number;
    recallAt10: number;
    mrrAt10: number;
    ndcgAt10: number;
    hitRateAt10: number;
    precisionAt10: number;
    /** The FILE level: the right FILE was retrieved (line ranges ignored). */
    pathRecallAt5: number;
    pathRecallAt10: number;
    /** The same metrics with the TEST chunks removed from the hit list. */
    sourceOnly: {
      recallAt5: number;
      recallAt10: number;
      mrrAt10: number;
      hitRateAt10: number;
      pathRecallAt5: number;
    };
    /** The same, but with a 40 candidate pool before the tests are dropped. */
    sourceOnlyDeep: {
      recallAt5: number;
      recallAt10: number;
      mrrAt10: number;
      hitRateAt10: number;
      pathRecallAt5: number;
    };
  };
  /** The 1-based rank of the first chunk level relevant hit, 0 when none. */
  firstRelevantRank: number;
  /** The 1-based rank of the first FILE level hit, 0 when none. */
  firstPathRank: number;
  topHits: HitRecord[];
  /** The expected ranges, for the report. */
  expected: Array<{ path: string; startLine?: number; endLine?: number; symbol?: string }>;
}

/** The rank (1-based) of the first hit that satisfies the expectation. */
function firstRelevantRank(
  hits: HitLike[],
  expected: Array<{ path: string; startLine?: number; endLine?: number; symbol?: string }>,
): number {
  for (let index = 0; index < hits.length; index++) {
    const hit = hits[index];
    if (!hit) continue;
    const ok = expected.some((range) =>
      range.startLine !== undefined && range.endLine !== undefined
        ? hit.path === range.path &&
          hit.startLine <= range.endLine &&
          hit.endLine >= range.startLine
        : range.symbol
          ? hit.path === range.path &&
            (hit.symbol ?? "").toLowerCase() === range.symbol.toLowerCase()
          : hit.path === range.path,
    );
    if (ok) return index + 1;
  }
  return 0;
}

const records: QuestionRecord[] = [];

for (const question of scorable) {
  const expected = question.expect.evidence.map((evidence) => ({
    path: evidence.path,
    startLine: evidence.startLine,
    endLine: evidence.endLine,
    symbol: evidence.symbol,
  }));
  /** The same expectations, reduced to the file level. */
  const expectedPaths = expected.map((range) => ({ path: range.path }));

  const embedding = await embedQuery(question.question);
  const hits = await searchChunks(
    {
      query: question.question,
      projectId: question.project,
      limit: options.limit,
    },
    embedding,
  );

  const hitList: HitRecord[] = hits.map((hit) => ({
    projectId: hit.projectId,
    path: hit.path,
    startLine: hit.startLine,
    endLine: hit.endLine,
    symbol: hit.symbol,
    score: hit.score,
    vectorRank: hit.vectorRank,
    keywordRank: hit.keywordRank,
  }));

  /** What the numbers would be if the test chunks were not in the pool. */
  const sourceHits = hitList.filter((hit) => !isTestPath(hit.path));

  /**
   * The same, but with a DEEPER candidate pool.
   *
   * `searchChunks` gives each keyword sub-leg a LIMIT equal to `limit`, so a
   * small limit also shrinks the keyword pool. Pulling 40 candidates and then
   * dropping the test files and keeping the first 10 is a faithful estimate
   * of "the tests were never in the index".
   */
  const deepEmbedding = await embedQuery(question.question);
  const deepHits = await searchChunks(
    {
      query: question.question,
      projectId: question.project,
      limit: 40,
    },
    deepEmbedding,
  );
  const deepSourceHits = deepHits
    .filter((hit) => !isTestPath(hit.path))
    .slice(0, 10)
    .map((hit) => ({
      projectId: hit.projectId,
      path: hit.path,
      startLine: hit.startLine,
      endLine: hit.endLine,
      symbol: hit.symbol,
      score: hit.score,
      vectorRank: hit.vectorRank,
      keywordRank: hit.keywordRank,
    }));

  records.push({
    id: question.id,
    bucket: question.bucket,
    project: question.project,
    question: question.question,
    metrics: {
      recallAt5: recallAtK(hitList, expected, 5),
      recallAt10: recallAtK(hitList, expected, 10),
      mrrAt10: mrrAtK(hitList, expected, 10),
      ndcgAt10: ndcgAtK(hitList, expected, 10),
      hitRateAt10: hitRate(hitList, expected, 10),
      precisionAt10: precisionAtK(hitList, expected, 10),
      pathRecallAt5: recallAtK(hitList, expectedPaths, 5),
      pathRecallAt10: recallAtK(hitList, expectedPaths, 10),
      sourceOnly: {
        recallAt5: recallAtK(sourceHits, expected, 5),
        recallAt10: recallAtK(sourceHits, expected, 10),
        mrrAt10: mrrAtK(sourceHits, expected, 10),
        hitRateAt10: hitRate(sourceHits, expected, 10),
        pathRecallAt5: recallAtK(sourceHits, expectedPaths, 5),
      },
      sourceOnlyDeep: {
        recallAt5: recallAtK(deepSourceHits, expected, 5),
        recallAt10: recallAtK(deepSourceHits, expected, 10),
        mrrAt10: mrrAtK(deepSourceHits, expected, 10),
        hitRateAt10: hitRate(deepSourceHits, expected, 10),
        pathRecallAt5: recallAtK(deepSourceHits, expectedPaths, 5),
      },
    },
    firstRelevantRank: firstRelevantRank(hitList, expected),
    firstPathRank: firstRelevantRank(hitList, expectedPaths),
    topHits: hitList.slice(0, 3),
    expected,
  });
}

/* ------------------------------------------------------------------ */
/* The test-file diagnostic                                            */
/* ------------------------------------------------------------------ */

/**
 * Is this path a TEST file?
 *
 * The corpus is source heavy on tests: `smartapply` alone has more than a
 * hundred `tests/**` files, and a test function is short, dense and full of
 * the same words as the production code ("filter", "relevance", "booking").
 * The vector leg therefore loves them, and they crowd the real
 * implementation out of the top 5.
 *
 * The diagnostic below measures what the metrics would be if the test chunks
 * were removed from the candidate pool. It does NOT change the app: it
 * quantifies the impact of the single highest-leverage fix.
 */
export function isTestPath(path: string): boolean {
  return (
    /(^|\/)tests?\//.test(path) ||
    /(^|\/)__tests__\//.test(path) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|\/)test_[^/]*\.py$/.test(path) ||
    /[^/]*_test\.(py|js|ts)$/.test(path)
  );
}

/* ------------------------------------------------------------------ */
/* Aggregate                                                           */
/* ------------------------------------------------------------------ */

const scored = records.map((record) => ({
  id: record.id,
  bucket: record.bucket,
  project: record.project,
  metrics: record.metrics,
  topHits: record.topHits,
}));

const overall = aggregate(scored);

function groupBy<T>(
  items: T[],
  key: (item: T) => string | undefined,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item) ?? "(none)";
    const list = groups.get(name) ?? [];
    list.push(item);
    groups.set(name, list);
  }
  return groups;
}

const byBucket = new Map<string, ReturnType<typeof aggregate>>();
for (const [bucket, items] of groupBy(scored, (item) => item.bucket)) {
  byBucket.set(bucket, aggregate(items));
}

const byProject = new Map<string, ReturnType<typeof aggregate>>();
for (const [project, items] of groupBy(scored, (item) => item.project)) {
  byProject.set(project, aggregate(items));
}

/** The ten questions with the lowest combined score. */
const worst = [...scored]
  .map((item) => ({
    ...item,
    score:
      0.5 * item.metrics.recallAt5 +
      0.3 * item.metrics.mrrAt10 +
      0.2 * item.metrics.hitRateAt10,
  }))
  .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id))
  .slice(0, 10);

const pass =
  overall.recallAt5 >= RECALL_AT_5_THRESHOLD &&
  overall.mrrAt10 >= MRR_AT_10_THRESHOLD;

/** The file level diagnostics, averaged over the scored questions. */
const pathRecall5 =
  scored.length === 0
    ? 0
    : scored.reduce((sum, item) => sum + item.metrics.pathRecallAt5, 0) /
      scored.length;
const pathRecall10 =
  scored.length === 0
    ? 0
    : scored.reduce((sum, item) => sum + item.metrics.pathRecallAt10, 0) /
      scored.length;

/** The same aggregate over the "tests excluded" variant. */
const sourceOnly = {
  recallAt5:
    scored.length === 0
      ? 0
      : scored.reduce((sum, item) => sum + item.metrics.sourceOnly.recallAt5, 0) /
        scored.length,
  recallAt10:
    scored.length === 0
      ? 0
      : scored.reduce((sum, item) => sum + item.metrics.sourceOnly.recallAt10, 0) /
        scored.length,
  mrrAt10:
    scored.length === 0
      ? 0
      : scored.reduce((sum, item) => sum + item.metrics.sourceOnly.mrrAt10, 0) /
        scored.length,
  hitRateAt10:
    scored.length === 0
      ? 0
      : scored.reduce(
          (sum, item) => sum + item.metrics.sourceOnly.hitRateAt10,
          0,
        ) / scored.length,
  pathRecallAt5:
    scored.length === 0
      ? 0
      : scored.reduce(
          (sum, item) => sum + item.metrics.sourceOnly.pathRecallAt5,
          0,
        ) / scored.length,
};

/** The same aggregate, with a 40 candidate pool before the tests are dropped. */
const sourceOnlyDeep = {
  recallAt5:
    scored.length === 0
      ? 0
      : scored.reduce(
          (sum, item) => sum + item.metrics.sourceOnlyDeep.recallAt5,
          0,
        ) / scored.length,
  recallAt10:
    scored.length === 0
      ? 0
      : scored.reduce(
          (sum, item) => sum + item.metrics.sourceOnlyDeep.recallAt10,
          0,
        ) / scored.length,
  mrrAt10:
    scored.length === 0
      ? 0
      : scored.reduce(
          (sum, item) => sum + item.metrics.sourceOnlyDeep.mrrAt10,
          0,
        ) / scored.length,
  hitRateAt10:
    scored.length === 0
      ? 0
      : scored.reduce(
          (sum, item) => sum + item.metrics.sourceOnlyDeep.hitRateAt10,
          0,
        ) / scored.length,
  pathRecallAt5:
    scored.length === 0
      ? 0
      : scored.reduce(
          (sum, item) => sum + item.metrics.sourceOnlyDeep.pathRecallAt5,
          0,
        ) / scored.length,
};

const report = {
  generatedAt: new Date().toISOString(),
  thresholds: {
    recallAt5: RECALL_AT_5_THRESHOLD,
    mrrAt10: MRR_AT_10_THRESHOLD,
  },
  overall,
  byBucket: Object.fromEntries(byBucket),
  byProject: Object.fromEntries(byProject),
  diagnostics: {
    fileLevelRecallAt5: pathRecall5,
    fileLevelRecallAt10: pathRecall10,
    withoutTestChunks: sourceOnly,
    withoutTestChunksDeepPool: sourceOnlyDeep,
  },
  worst: worst.map((item) => ({
    id: item.id,
    bucket: item.bucket,
    project: item.project,
    metrics: item.metrics,
    topHits: item.topHits,
  })),
  questions: records,
  notScorable: selected
    .filter((question) => question.expect.evidence.length === 0)
    .map((question) => ({ id: question.id, bucket: question.bucket })),
  pass,
};

/* ------------------------------------------------------------------ */
/* Print                                                               */
/* ------------------------------------------------------------------ */

if (options.json) {
  const text = JSON.stringify(report, null, 2);
  if (options.out) {
    writeFileSync(options.out, text, "utf8");
    console.log(`[eval] report written to ${options.out}`);
  } else {
    console.log(text);
  }
} else {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const pad = (text: string, width: number): string =>
    text.padEnd(width);

  console.log("");
  console.log("=== RETRIEVAL BENCHMARK (live index, no LLM) ===");
  console.log("");
  console.log(
    `questions scored : ${overall.count} (of ${selected.length} selected; ` +
      `${selected.length - overall.count} answered from the content layer)`,
  );
  console.log("");
  console.log("OVERALL");
  console.log(
    `  recall@5    ${pct(overall.recallAt5).padStart(7)}   threshold ${pct(RECALL_AT_5_THRESHOLD)}   ${overall.recallAt5 >= RECALL_AT_5_THRESHOLD ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  recall@10   ${pct(overall.recallAt10).padStart(7)}`,
  );
  console.log(
    `  MRR@10      ${pct(overall.mrrAt10).padStart(7)}   threshold ${pct(MRR_AT_10_THRESHOLD)}   ${overall.mrrAt10 >= MRR_AT_10_THRESHOLD ? "PASS" : "FAIL"}`,
  );
  console.log(`  nDCG@10     ${pct(overall.ndcgAt10).padStart(7)}`);
  console.log(`  hit-rate@10 ${pct(overall.hitRateAt10).padStart(7)}`);
  console.log(`  precision@10${pct(overall.precisionAt10).padStart(7)}`);
  console.log(
    `  FILE level  recall@5 ${pct(pathRecall5)}  recall@10 ${pct(pathRecall10)}  (line ranges ignored)`,
  );
  console.log(
    `  NO TESTS   recall@5 ${pct(sourceOnly.recallAt5)}  recall@10 ${pct(sourceOnly.recallAt10)}  ` +
      `MRR@10 ${pct(sourceOnly.mrrAt10)}  hit@10 ${pct(sourceOnly.hitRateAt10)}  (same pool, tests dropped)`,
  );
  console.log(
    `  NO TESTS   recall@5 ${pct(sourceOnlyDeep.recallAt5)}  recall@10 ${pct(sourceOnlyDeep.recallAt10)}  ` +
      `MRR@10 ${pct(sourceOnlyDeep.mrrAt10)}  hit@10 ${pct(sourceOnlyDeep.hitRateAt10)}  (40-candidate pool, tests dropped)`,
  );

  console.log("");
  console.log("PER BUCKET");
  console.log(
    `  ${pad("bucket", 32)}${pad("n", 6)}${pad("recall@5", 12)}${pad("recall@10", 12)}${pad("MRR@10", 10)}${pad("nDCG@10", 10)}${pad("hit@10", 10)}`,
  );
  for (const [bucket, metrics] of [...byBucket.entries()].sort()) {
    console.log(
      `  ${pad(bucket, 32)}${pad(String(metrics.count), 6)}${pad(pct(metrics.recallAt5), 12)}${pad(pct(metrics.recallAt10), 12)}${pad(pct(metrics.mrrAt10), 10)}${pad(pct(metrics.ndcgAt10), 10)}${pad(pct(metrics.hitRateAt10), 10)}`,
    );
  }

  console.log("");
  console.log("PER PROJECT");
  console.log(
    `  ${pad("project", 32)}${pad("n", 6)}${pad("recall@5", 12)}${pad("recall@10", 12)}${pad("MRR@10", 10)}${pad("nDCG@10", 10)}${pad("hit@10", 10)}`,
  );
  for (const [project, metrics] of [...byProject.entries()].sort()) {
    console.log(
      `  ${pad(project, 32)}${pad(String(metrics.count), 6)}${pad(pct(metrics.recallAt5), 12)}${pad(pct(metrics.recallAt10), 12)}${pad(pct(metrics.mrrAt10), 10)}${pad(pct(metrics.ndcgAt10), 10)}${pad(pct(metrics.hitRateAt10), 10)}`,
    );
  }

  console.log("");
  console.log("PER QUESTION (top 3 hits)");
  for (const record of records) {
    console.log(
      `  ${record.id} [${record.bucket}] r@5=${pct(record.metrics.recallAt5)} ` +
        `r@10=${pct(record.metrics.recallAt10)} mrr@10=${record.metrics.mrrAt10.toFixed(3)} ` +
        `ndcg@10=${record.metrics.ndcgAt10.toFixed(3)} hit@10=${record.metrics.hitRateAt10} ` +
        `| first chunk rank=${record.firstRelevantRank || "-"} first file rank=${record.firstPathRank || "-"}`,
    );
    console.log(`      Q: ${record.question}`);
    for (const [index, hit] of record.topHits.entries()) {
      console.log(
        `      ${index + 1}. ${hit.projectId} ${hit.path}:${hit.startLine}-${hit.endLine}` +
          `${hit.symbol ? ` (${hit.symbol})` : ""} score=${hit.score.toFixed(5)}` +
          ` v=${hit.vectorRank ?? "-"} k=${hit.keywordRank ?? "-"}`,
      );
    }
    for (const expected of record.expected) {
      console.log(
        `      want: ${expected.path}${expected.startLine ? `:${expected.startLine}-${expected.endLine}` : ""}${expected.symbol ? ` (${expected.symbol})` : ""}`,
      );
    }
  }

  console.log("");
  console.log("WORST 10 (the improvement list)");
  for (const item of worst) {
    console.log(
      `  ${item.id} [${item.bucket}] score=${(item.metrics.recallAt5 * 0.5 + item.metrics.mrrAt10 * 0.3 + item.metrics.hitRateAt10 * 0.2).toFixed(3)} ` +
        `r@5=${pct(item.metrics.recallAt5)} mrr@10=${item.metrics.mrrAt10.toFixed(3)} hit@10=${item.metrics.hitRateAt10}`,
    );
    for (const [index, hit] of item.topHits.entries()) {
      console.log(
        `      ${index + 1}. ${hit.projectId} ${hit.path}:${hit.startLine}-${hit.endLine}` +
          `${hit.symbol ? ` (${hit.symbol})` : ""} score=${hit.score.toFixed(5)}`,
      );
    }
  }

  console.log("");
  console.log(
    `RESULT: ${pass ? "PASS" : "FAIL"}  (recall@5 ${pct(overall.recallAt5)} vs ${pct(RECALL_AT_5_THRESHOLD)}, MRR@10 ${pct(overall.mrrAt10)} vs ${pct(MRR_AT_10_THRESHOLD)})`,
  );
}

process.exit(pass ? 0 : 1);
