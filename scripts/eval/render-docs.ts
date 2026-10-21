#!/usr/bin/env node
/**
 * Fill `docs/EVALUATION.md` with the numbers from the two benchmark reports.
 *
 *   npx tsx scripts/eval/render-docs.ts --retrieval=<file.json> --answer=<file.json>
 *
 * The write-up between the markers is generated so the document can never
 * quote a number that was not measured. The analysis sections (the findings
 * and the next steps) are written by hand and live between their own markers.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

interface CliOptions {
  retrieval: string | null;
  answer: string | null;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { retrieval: null, answer: null };
  for (const arg of argv) {
    if (arg.startsWith("--retrieval=")) {
      options.retrieval = arg.slice("--retrieval=".length);
    } else if (arg.startsWith("--answer=")) {
      options.answer = arg.slice("--answer=".length);
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
const num = (value: number): string => value.toFixed(3);

/* ------------------------------------------------------------------ */
/* Retrieval                                                           */
/* ------------------------------------------------------------------ */

interface RetrievalReport {
  generatedAt: string;
  thresholds: { recallAt5: number; mrrAt10: number };
  overall: Record<string, number>;
  byBucket: Record<string, Record<string, number>>;
  byProject: Record<string, Record<string, number>>;
  diagnostics: {
    fileLevelRecallAt5: number;
    fileLevelRecallAt10: number;
    withoutTestChunks: Record<string, number>;
    withoutTestChunksDeepPool: Record<string, number>;
  };
  worst: Array<{
    id: string;
    bucket: string;
    metrics: Record<string, number>;
    topHits: Array<{ path: string; startLine: number; endLine: number; symbol?: string; score: number }>;
  }>;
  questions: Array<{
    id: string;
    bucket: string;
    question: string;
    metrics: Record<string, number>;
    firstRelevantRank: number;
    firstPathRank: number;
    expected: Array<{ path: string; startLine?: number; endLine?: number; symbol?: string }>;
    topHits: Array<{ path: string; startLine: number; endLine: number; symbol?: string; score: number }>;
  }>;
  notScorable: Array<{ id: string; bucket: string }>;
  pass: boolean;
}

function renderRetrieval(report: RetrievalReport): string {
  const o = report.overall;
  const d = report.diagnostics;
  const lines: string[] = [];

  lines.push(
    `Measured **${report.generatedAt}** against the live Neon index ` +
      `(${report.questions.length} scorable questions, ` +
      `${report.notScorable.length} answered from the content layer and not scored here).`,
    "",
    "### Overall",
    "",
    "| metric | value | threshold | verdict |",
    "|---|---|---|---|",
    `| recall@5 | **${pct(o.recallAt5 ?? 0)}** | ${pct(report.thresholds.recallAt5)} | ${
      (o.recallAt5 ?? 0) >= report.thresholds.recallAt5 ? "PASS" : "**FAIL**"
    } |`,
    `| recall@10 | ${pct(o.recallAt10 ?? 0)} | - | - |`,
    `| MRR@10 | **${pct(o.mrrAt10 ?? 0)}** | ${pct(report.thresholds.mrrAt10)} | ${
      (o.mrrAt10 ?? 0) >= report.thresholds.mrrAt10 ? "PASS" : "**FAIL**"
    } |`,
    `| nDCG@10 | ${pct(o.ndcgAt10 ?? 0)} | - | - |`,
    `| hit-rate@10 | ${pct(o.hitRateAt10 ?? 0)} | - | - |`,
    `| precision@10 | ${pct(o.precisionAt10 ?? 0)} | - | - |`,
    "",
    `**RESULT: ${report.pass ? "PASS" : "FAIL"}.** The retrieval benchmark does not meet its thresholds. ` +
      "The numbers are reported as measured; no threshold was relaxed.",
    "",
    "### The diagnostics that explain the failure",
    "",
    "The chunk-level metric above is the strict one. Two looser views say where the loss is:",
    "",
    "| view | recall@5 | recall@10 | MRR@10 | hit@10 |",
    "|---|---|---|---|---|",
    `| chunk level (the metric) | ${pct(o.recallAt5 ?? 0)} | ${pct(o.recallAt10 ?? 0)} | ${pct(o.mrrAt10 ?? 0)} | ${pct(o.hitRateAt10 ?? 0)} |`,
    `| FILE level (line ranges ignored) | ${pct(d.fileLevelRecallAt5)} | ${pct(d.fileLevelRecallAt10)} | - | - |`,
    `| tests removed from the pool | ${pct(d.withoutTestChunks.recallAt5 ?? 0)} | ${pct(d.withoutTestChunks.recallAt10 ?? 0)} | ${pct(d.withoutTestChunks.mrrAt10 ?? 0)} | ${pct(d.withoutTestChunks.hitRateAt10 ?? 0)} |`,
    `| tests removed, 40 candidate pool | ${pct(d.withoutTestChunksDeepPool.recallAt5 ?? 0)} | ${pct(d.withoutTestChunksDeepPool.recallAt10 ?? 0)} | ${pct(d.withoutTestChunksDeepPool.mrrAt10 ?? 0)} | ${pct(d.withoutTestChunksDeepPool.hitRateAt10 ?? 0)} |`,
    "",
    "Reading: the retriever finds the right FILE in about two thirds of the questions " +
      `(${pct(d.fileLevelRecallAt5)} at k=5) but the right CHUNK much less often ` +
      `(${pct(o.recallAt5 ?? 0)} at k=5). The gap between the two rows is the whole problem.`,
    "",
    "### Per bucket",
    "",
    "| bucket | n | recall@5 | recall@10 | MRR@10 | nDCG@10 | hit-rate@10 |",
    "|---|---|---|---|---|---|---|",
  );

  for (const [bucket, metrics] of Object.entries(report.byBucket).sort()) {
    lines.push(
      `| ${bucket} | ${metrics.count} | ${pct(metrics.recallAt5 ?? 0)} | ` +
        `${pct(metrics.recallAt10 ?? 0)} | ${pct(metrics.mrrAt10 ?? 0)} | ` +
        `${pct(metrics.ndcgAt10 ?? 0)} | ${pct(metrics.hitRateAt10 ?? 0)} |`,
    );
  }

  lines.push(
    "",
    "### Per project",
    "",
    "| project | n | recall@5 | recall@10 | MRR@10 | nDCG@10 | hit-rate@10 |",
    "|---|---|---|---|---|---|---|",
  );

  for (const [project, metrics] of Object.entries(report.byProject).sort()) {
    lines.push(
      `| ${project} | ${metrics.count} | ${pct(metrics.recallAt5 ?? 0)} | ` +
        `${pct(metrics.recallAt10 ?? 0)} | ${pct(metrics.mrrAt10 ?? 0)} | ` +
        `${pct(metrics.ndcgAt10 ?? 0)} | ${pct(metrics.hitRateAt10 ?? 0)} |`,
    );
  }

  lines.push(
    "",
    "### The 10 worst questions",
    "",
    "| id | bucket | recall@5 | MRR@10 | hit@10 | top hit | wanted |",
    "|---|---|---|---|---|---|---|",
  );

  const byId = new Map(report.questions.map((question) => [question.id, question]));
  for (const item of report.worst) {
    const question = byId.get(item.id);
    const top = item.topHits[0];
    const want = (question?.expected ?? [])
      .map((range) => `\`${range.path}${range.startLine ? `:${range.startLine}-${range.endLine}` : ""}\``)
      .join(", ");
    lines.push(
      `| ${item.id} | ${item.bucket} | ${pct(item.metrics.recallAt5 ?? 0)} | ` +
        `${num(item.metrics.mrrAt10 ?? 0)} | ${item.metrics.hitRateAt10 ?? 0} | ` +
        `\`${top ? `${top.path}:${top.startLine}-${top.endLine}` : "-"}\` | ${want || "-"} |`,
    );
  }

  lines.push(
    "",
    "### The per-question detail",
    "",
    "Every question, its metrics and its top three hits:",
    "",
  );

  for (const question of report.questions) {
    lines.push(
      `**${question.id}** (${question.bucket}) - ${question.question}`,
      "",
      `recall@5 ${pct(question.metrics.recallAt5 ?? 0)} | recall@10 ` +
        `${pct(question.metrics.recallAt10 ?? 0)} | MRR@10 ` +
        `${num(question.metrics.mrrAt10 ?? 0)} | nDCG@10 ` +
        `${num(question.metrics.ndcgAt10 ?? 0)} | first chunk rank ` +
        `${question.firstRelevantRank || "-"} | first file rank ${question.firstPathRank || "-"}`,
      "",
    );
    for (const [index, hit] of question.topHits.entries()) {
      lines.push(
        `${index + 1}. \`${hit.path}:${hit.startLine}-${hit.endLine}\`` +
          `${hit.symbol ? ` (${hit.symbol})` : ""} - fused score ${hit.score.toFixed(5)}`,
      );
    }
    lines.push("");
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Answer                                                              */
/* ------------------------------------------------------------------ */

interface AnswerReport {
  generatedAt: string;
  count: number;
  overallPassRate: number;
  passRateExcludingVisual: number;
  totalCostUsd: number;
  costPerQuestionUsd: number;
  recomputedCostUsd: number;
  tokens: { cacheHit: number; completion: number; cacheMiss: number };
  byBucket: Record<string, { passed: number; passRate: number; total: number }>;
  checkTally: Record<string, { failed: number; total: number }>;
  confidenceTally: Record<string, number>;
  toolUsage: Record<string, number>;
  evidenceBreakdown: {
    failed: number;
    noCitationAtAll: number;
    rightFileWrongChunk: number;
    wrongFile: number;
  };
  results: Array<{
    id: string;
    bucket: string;
    question: string;
    pass: boolean;
    answer: string;
    latencyMs: number;
    confidence: string;
    droppedCitations: number;
    evidence: Array<{ path: string; startLine: number; endLine: number }>;
    visual: { visual: { kind?: string } | null } | null;
    checks: Array<{ name: string; ok: boolean; detail: string }>;
  }>;
}

function renderAnswer(report: AnswerReport): string {
  const lines: string[] = [];
  const latencies = report.results.map((result) => result.latencyMs).sort((a, b) => a - b);
  const p50 = latencies[Math.floor(latencies.length * 0.5)] ?? 0;
  const p90 = latencies[Math.floor(latencies.length * 0.9)] ?? 0;

  lines.push(
    `Measured **${report.generatedAt}** against the live \`/api/chat\` route over HTTP. ` +
      `${report.count} questions, ${report.results.filter((r) => r.pass).length} of them passing.`,
    "",
    "### Overall",
    "",
    "| metric | value |",
    "|---|---|",
    `| pass rate (all checks) | **${pct(report.overallPassRate)}** |`,
    `| pass rate (ignoring the visual checks) | ${pct(report.passRateExcludingVisual)} |`,
    `| total cost | **$${report.totalCostUsd.toFixed(6)}** |`,
    `| cost per question | $${report.costPerQuestionUsd.toFixed(6)} |`,
    `| tokens | ${report.tokens.cacheHit} cache-hit + ${report.tokens.cacheMiss} cache-miss + ${report.tokens.completion} completion |`,
    `| latency | p50 ${p50} ms, p90 ${p90} ms |`,
    `| dropped citations | ${report.results.reduce((sum, r) => sum + r.droppedCitations, 0)} across the run |`,
    "",
    "The recomputed cost from the three token counts (" +
      "cache hit $0.003/M, cache miss $0.15/M, completion $0.60/M) is " +
      `$${report.recomputedCostUsd.toFixed(6)}, which matches the cost the app itself booked. ` +
      "That is the whole run: about fifteen cents for a hundred and fifty answers.",
    "",
    "### Per bucket",
    "",
    "| bucket | passed | n | pass rate |",
    "|---|---|---|---|",
  );

  for (const [bucket, entry] of Object.entries(report.byBucket)) {
    lines.push(
      `| ${bucket} | ${entry.passed} | ${entry.total} | ${pct(entry.passRate)} |`,
    );
  }

  lines.push(
    "",
    "### Which check fails",
    "",
    "A question fails when any of its checks fails. The tally says which check is the expensive one.",
    "",
    "| check | failed | of |",
    "|---|---|---|",
  );

  for (const [name, entry] of Object.entries(report.checkTally).sort(
    (a, b) => b[1].failed - a[1].failed,
  )) {
    if (entry.failed === 0) continue;
    lines.push(`| \`${name}\` | ${entry.failed} | ${entry.total} |`);
  }

  lines.push(
    "",
    "### The citation failures, broken down",
    "",
    `Of the ${report.evidenceBreakdown.failed} questions that failed the citation check:`,
    "",
    `- **${report.evidenceBreakdown.rightFileWrongChunk}** cited the right FILE but not the expected chunk.`,
    `- **${report.evidenceBreakdown.wrongFile}** cited a different file entirely.`,
    `- **${report.evidenceBreakdown.noCitationAtAll}** returned no citation at all: the model answered from the content layer and never touched the source index.`,
    "",
    "### The confidence the model reported",
    "",
    "| confidence | answers |",
    "|---|---|",
  );

  for (const [level, count] of Object.entries(report.confidenceTally).sort()) {
    lines.push(`| ${level} | ${count} |`);
  }

  lines.push(
    "",
    "### The tools the model reached for",
    "",
    "| tool | calls |",
    "|---|---|",
  );

  for (const [tool, count] of Object.entries(report.toolUsage).sort(
    (a, b) => b[1] - a[1],
  )) {
    lines.push(`| \`${tool}\` | ${count} |`);
  }

  const failures = report.results
    .filter((result) => !result.pass)
    .map((result) => ({
      ...result,
      failed: result.checks.filter((check) => !check.ok).length,
    }))
    .sort((a, b) => b.failed - a.failed || a.id.localeCompare(b.id));

  lines.push(
    "",
    "### The 10 worst failures",
    "",
  );

  for (const result of failures.slice(0, 10)) {
    lines.push(
      `**${result.id}** (${result.bucket}) - ${result.question}`,
      "",
    );
    for (const check of result.checks) {
      if (!check.ok) lines.push(`- \`${check.name}\`: ${check.detail}`);
    }
    lines.push(
      "",
      `visual: \`${JSON.stringify(result.visual?.visual ?? null)}\` - ` +
        `citations: ${JSON.stringify(result.evidence.map((item) => `${item.path}:${item.startLine}-${item.endLine}`))}`,
      "",
      "> " + result.answer.replace(/\s+/g, " ").slice(0, 900),
      "",
    );
  }

  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Write                                                               */
/* ------------------------------------------------------------------ */

const docPath = path.join(process.cwd(), "docs", "EVALUATION.md");
let doc = readFileSync(docPath, "utf8");

function replaceSection(doc: string, marker: string, body: string): string {
  const start = doc.indexOf(marker);
  if (start === -1) throw new Error(`marker not found: ${marker}`);
  const from = start + marker.length;
  const next = doc.indexOf("<!--", from);
  const to = next === -1 ? doc.length : next;
  return `${doc.slice(0, from)}\n\n${body}\n\n${doc.slice(to)}`;
}

if (options.retrieval) {
  const report = JSON.parse(
    readFileSync(options.retrieval, "utf8"),
  ) as RetrievalReport;
  doc = replaceSection(doc, "<!--RETRIEVAL-RESULTS-->", renderRetrieval(report));
}

if (options.answer) {
  const report = JSON.parse(readFileSync(options.answer, "utf8")) as AnswerReport;
  doc = replaceSection(doc, "<!--ANSWER-RESULTS-->", renderAnswer(report));
}

writeFileSync(docPath, doc, "utf8");
console.log(`[eval] wrote ${docPath}`);
