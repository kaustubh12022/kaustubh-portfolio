#!/usr/bin/env node
/**
 * Audit the golden set's `expect.evidence` against the LIVE index.
 *
 *   npx tsx scripts/eval/audit-golden-ranges.ts            # report only
 *   npx tsx scripts/eval/audit-golden-ranges.ts --fix      # rewrite the YAML
 *   npx tsx scripts/eval/audit-golden-ranges.ts --json     # machine readable
 *
 * WHY
 * ---
 * The indexer chunks by AST and SPLITS a long function into several chunks.
 * A golden set that names only the FIRST chunk of a function calls every
 * other chunk of the same function a miss - which is a measurement artifact,
 * not a retrieval failure.
 *
 * There is a second, worse artifact: the expected FILE may not be in the
 * index at all, because the repository was reorganised after the golden set
 * was written. That question can never pass, no matter how good the
 * retriever is, so it is a broken expectation rather than a broken system.
 *
 * This script tells the two apart, for free:
 *
 *   ok             the path exists and a chunk overlaps the expected range
 *   range-stale    the path exists, the symbol exists, but the LINE RANGE
 *                  does not overlap any chunk (the function moved)
 *   symbol-missing the path exists but the symbol does not; it lives in
 *                  another file of the same project (the file was renamed)
 *   path-missing   the path does not exist in the index at all
 *   no-symbol      the path exists, no symbol was named, the range misses
 *
 * `--fix` rewrites the two repairable cases: the range of a symbol that IS
 * in the index becomes the union span of that symbol's chunks, and a symbol
 * that lives in exactly one other file of the same project moves to that
 * file. The two unrepairable cases (path-missing, ambiguous symbol) are
 * REPORTED and left alone - a human has to decide what the question should
 * point at.
 *
 * NO LLM CALL. This script only reads the index.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseDocument } from "yaml";

import { readGoldenSet } from "@/lib/eval/golden";

import { loadEnv } from "./env.js";

loadEnv();

const { query, closePool } = await import("@/lib/retrieval/db.js");

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2);
const FIX = argv.includes("--fix");
const AS_JSON = argv.includes("--json");

/* ------------------------------------------------------------------ */
/* The index                                                           */
/* ------------------------------------------------------------------ */

interface ChunkRow {
  project_id: string;
  path: string;
  symbol: string;
  start_line: number;
  end_line: number;
}

const chunkRows = await query<ChunkRow>(
  `SELECT project_id, path, symbol, start_line, end_line FROM chunks`,
);

const PROJECTS = [...new Set(chunkRows.rows.map((row) => row.project_id))].sort();

/** `${project}::${path}` -> the chunks of that file. */
const byProjectPath = new Map<string, ChunkRow[]>();
/** `${project}::${symbol}` -> the chunks of that symbol, anywhere. */
const byProjectSymbol = new Map<string, ChunkRow[]>();
/** every path of a project, for the "did the project change?" check. */
const pathsByProject = new Map<string, Set<string>>();

for (const row of chunkRows.rows) {
  const pathKey = `${row.project_id}::${row.path}`;
  const symbolKey = `${row.project_id}::${row.symbol}`;
  if (row.symbol !== "") {
    const symbolRows = byProjectSymbol.get(symbolKey) ?? [];
    symbolRows.push(row);
    byProjectSymbol.set(symbolKey, symbolRows);
  }

  // EVERY chunk belongs to its file - including the symbol-less ones. A SQL
  // migration is chunked as plain blocks and carries no symbol at all, so
  // filtering on `symbol <> ''` here would hide the file completely.
  const pathRows = byProjectPath.get(pathKey) ?? [];
  pathRows.push(row);
  byProjectPath.set(pathKey, pathRows);

  const projectPaths = pathsByProject.get(row.project_id) ?? new Set<string>();
  projectPaths.add(row.path);
  pathsByProject.set(row.project_id, projectPaths);
}

/** The union span of a symbol's chunks. */
function symbolSpan(project: string, symbol: string): { lo: number; hi: number } | null {
  const rows = byProjectSymbol.get(`${project}::${symbol}`);
  if (!rows || rows.length === 0) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const row of rows) {
    lo = Math.min(lo, row.start_line);
    hi = Math.max(hi, row.end_line);
  }
  return { lo, hi };
}

/** Does any chunk of this file overlap the range? */
function overlaps(
  project: string,
  filePath: string,
  start: number | undefined,
  end: number | undefined,
): boolean {
  const rows = byProjectPath.get(`${project}::${filePath}`);
  if (!rows) return false;
  if (start === undefined || end === undefined) return rows.length > 0;
  return rows.some(
    (row) => row.start_line <= end && row.end_line >= start,
  );
}

/* ------------------------------------------------------------------ */
/* The audit                                                           */
/* ------------------------------------------------------------------ */

type Status =
  | "ok"
  | "range-stale"
  | "symbol-missing"
  | "path-missing"
  | "no-symbol"
  | "no-project";

interface Finding {
  id: string;
  bucket: string;
  question: string;
  project: string;
  path: string;
  symbol: string | undefined;
  startLine: number | undefined;
  endLine: number | undefined;
  status: Status;
  /** The repair, when there is an unambiguous one. */
  fix:
    | {
        path: string;
        startLine: number;
        endLine: number;
        symbol: string;
      }
    | null;
  detail: string;
}

const questions = readGoldenSet();
const findings: Finding[] = [];

for (const question of questions) {
  for (const evidence of question.expect.evidence) {
    const project = evidence.project ?? question.project ?? "";
    const symbol = evidence.symbol;
    const start = evidence.startLine;
    const end = evidence.endLine;

    const push = (
      status: Status,
      detail: string,
      fix: Finding["fix"] = null,
    ): void => {
      findings.push({
        id: question.id,
        bucket: question.bucket,
        question: question.question,
        project,
        path: evidence.path,
        symbol,
        startLine: start,
        endLine: end,
        status,
        fix,
        detail,
      });
    };

    if (!project) {
      push("no-project", "the expectation names no project and the question has none");
      continue;
    }

    if (!pathsByProject.has(project)) {
      push(
        "path-missing",
        `project "${project}" is not in the index (indexed: ${PROJECTS.join(", ")})`,
      );
      continue;
    }

    const fileExists = (pathsByProject.get(project) ?? new Set()).has(evidence.path);

    if (!fileExists) {
      // Does the SYMBOL live in exactly one other file of the same project?
      if (symbol) {
        const rows = byProjectSymbol.get(`${project}::${symbol}`) ?? [];
        const otherPaths = [...new Set(rows.map((row) => row.path))].filter(
          (item) => item !== evidence.path,
        );
        if (otherPaths.length === 1) {
          const otherPath = otherPaths[0] as string;
          const span = symbolSpan(project, symbol);
          if (span) {
            push(
              "symbol-missing",
              `the file moved to ${otherPath}; the symbol ${symbol} spans ${span.lo}-${span.hi} there`,
              {
                path: otherPath,
                startLine: span.lo,
                endLine: span.endLine,
                symbol,
              },
            );
            continue;
          }
        }
        if (otherPaths.length > 1) {
          push(
            "symbol-missing",
            `the symbol ${symbol} lives in ${otherPaths.length} files: ${otherPaths.join(", ")} - ambiguous, needs a human`,
          );
          continue;
        }
      }
      push(
        "path-missing",
        `the file does not exist in project ${project}`,
      );
      continue;
    }

    // The file exists. Does the range overlap a chunk?
    if (overlaps(project, evidence.path, start, end)) {
      push("ok", "the expected range overlaps a chunk of the index");
      continue;
    }

    // The range misses. Is the symbol there under a different span?
    if (symbol) {
      const span = symbolSpan(project, symbol);
      if (span) {
        push(
          "range-stale",
          `the symbol ${symbol} spans ${span.lo}-${span.hi}, not ${start}-${end}`,
          {
            path: evidence.path,
            startLine: span.lo,
            endLine: span.endLine,
            symbol,
          },
        );
        continue;
      }
      push(
        "symbol-missing",
        `the file exists but the symbol ${symbol} is not in it`,
      );
      continue;
    }

    push(
      "no-symbol",
      `no chunk of ${evidence.path} overlaps ${start}-${end}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

const byStatus = new Map<Status, Finding[]>();
for (const finding of findings) {
  const list = byStatus.get(finding.status) ?? [];
  list.push(finding);
  byStatus.set(finding.status, list);
}

const summary = {
  ok: byStatus.get("ok")?.length ?? 0,
  "range-stale": byStatus.get("range-stale")?.length ?? 0,
  "symbol-missing": byStatus.get("symbol-missing")?.length ?? 0,
  "path-missing": byStatus.get("path-missing")?.length ?? 0,
  "no-symbol": byStatus.get("no-symbol")?.length ?? 0,
  "no-project": byStatus.get("no-project")?.length ?? 0,
};

if (AS_JSON) {
  console.log(
    JSON.stringify(
      { projects: PROJECTS, summary, findings },
      null,
      2,
    ),
  );
} else {
  console.log("");
  console.log("=== GOLDEN SET EVIDENCE AUDIT (no LLM) ===");
  console.log("");
  console.log(`indexed projects: ${PROJECTS.join(", ")}`);
  console.log(`evidence entries: ${findings.length}`);
  console.log("");
  for (const [status, list] of [...byStatus.entries()].sort()) {
    console.log(`  ${status.padEnd(16)} ${String(list.length).padStart(4)}`);
  }
  console.log("");
  for (const status of ["path-missing", "symbol-missing", "no-symbol", "no-project", "range-stale"] as Status[]) {
    const list = byStatus.get(status);
    if (!list || list.length === 0) continue;
    console.log("");
    console.log(`${status.toUpperCase()} (${list.length})`);
    for (const finding of list) {
      console.log(
        `  ${finding.id} [${finding.bucket}] ${finding.project}/${finding.path}` +
          `${finding.symbol ? ` (${finding.symbol})` : ""} ` +
          `${finding.startLine ?? "?"}-${finding.endLine ?? "?"} :: ${finding.detail}`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Fix                                                                 */
/* ------------------------------------------------------------------ */

if (FIX) {
  const file = path.join(process.cwd(), "evals", "golden-set.yaml");
  const doc = parseDocument(readFileSync(file, "utf8"));

  const sequence = doc.contents;
  if (!sequence || !("items" in sequence) || !Array.isArray(sequence.items)) {
    throw new Error("evals/golden-set.yaml must be a top-level sequence of questions.");
  }

  const byId = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (!finding.fix) continue;
    const list = byId.get(finding.id) ?? [];
    list.push(finding);
    byId.set(finding.id, list);
  }

  let changed = 0;

  for (const node of sequence.items) {
    const q = node as { get: (key: string) => unknown };
    const id = q.get("id") as string;
    const fixes = byId.get(id);
    if (!fixes) continue;
    const expect = q.get("expect") as { get: (key: string) => { items?: unknown[] } };
    const evidence = expect.get("evidence") as { items?: unknown[] };
    const items = evidence?.items ?? [];

    for (const item of items) {
      const entry = item as {
        get: (key: string) => unknown;
        set: (key: string, value: unknown) => void;
      };
      const entryPath = entry.get("path") as string;
      const entrySymbol = entry.get("symbol") as string | undefined;
      const entryStart = entry.get("startLine") as number | undefined;
      const entryEnd = entry.get("endLine") as number | undefined;

      const fix = fixes.find(
        (candidate) =>
          candidate.path === entryPath &&
          candidate.symbol === entrySymbol &&
          candidate.startLine === entryStart &&
          candidate.endLine === entryEnd,
      );
      if (!fix || !fix.fix) continue;

      entry.set("path", fix.fix.path);
      entry.set("startLine", fix.fix.startLine);
      entry.set("endLine", fix.fix.endLine);
      changed += 1;
    }
  }

  writeFileSync(file, doc.toString({ lineWidth: 0 }), "utf8");
  console.log("");
  console.log(`[eval] rewrote ${changed} evidence entry/entries in ${file}`);
}

await closePool();
process.exit(0);
