#!/usr/bin/env node
/**
 * Code-indexing CLI.
 *
 *   npx tsx scripts/index/index.ts [--project=<id>] [--dry-run] [--out=<file.json>]
 *
 * Pipeline per project:
 *   1. resolve files through the default-deny allow-list
 *   2. scan every file (secret + PII scanner) - HARD GATE
 *   3. abort the project when a `block` finding exists
 *   4. chunk the files with tree-sitter
 *   5. verify line coverage
 *   6. write chunks.json or upsert into Postgres
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { resolveFiles } from "./allowlist.js";
import { chunkProject, splitLines, verifyCoverage, type CoverageResult } from "./chunker.js";
import { contentHash } from "./hash.js";
import { PROJECTS, getProject, repoName } from "./projects.js";
import { redactOwnerPii, scanContent } from "./scan.js";
import type { Chunk, Finding, ProjectDef, ProjectStats } from "./types.js";

/* ------------------------------------------------------------------ */
/* CLI parsing                                                         */
/* ------------------------------------------------------------------ */

interface CliOptions {
  project?: string;
  dryRun: boolean;
  out?: string;
  redactPii: boolean;
  verbose: boolean;
}

/** Parse `process.argv` into CLI options. */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false, redactPii: false, verbose: false };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--redact-pii") options.redactPii = true;
    else if (arg === "--verbose" || arg === "-v") options.verbose = true;
    else if (arg.startsWith("--project=")) options.project = arg.slice("--project=".length);
    else if (arg.startsWith("--out=")) options.out = arg.slice("--out=".length);
  }
  return options;
}

/* ------------------------------------------------------------------ */
/* Database layer (exported so the owner can wire it up)               */
/* ------------------------------------------------------------------ */

/** Minimal query interface, satisfied by `pg`'s `Pool` and `Client`. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

const CHUNK_COLUMNS =
  "project_id, repo_sha, path, lang, kind, symbol, start_line, end_line, content, header, content_hash, parser";

/**
 * Upsert chunks into the `chunks` table.
 *
 * The conflict target matches the unique index declared in
 * `lib/retrieval/schema.sql`:
 *   (project_id, path, start_line, end_line, content_hash)
 */
export async function upsertChunks(chunks: Chunk[], db: Queryable): Promise<number> {
  if (chunks.length === 0) return 0;
  const batchSize = 200;
  let written = 0;

  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const batch = chunks.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const tuples = batch.map((chunk, index) => {
      const base = index * 12;
      values.push(
        chunk.projectId,
        chunk.repoSha,
        chunk.path,
        chunk.language,
        chunk.kind,
        chunk.symbol,
        chunk.startLine,
        chunk.endLine,
        chunk.content,
        chunk.header,
        chunk.contentHash,
        chunk.parser,
      );
      return `(${Array.from({ length: 12 }, (_, i) => `$${base + i + 1}`).join(", ")})`;
    });
    const sql = `
      INSERT INTO chunks (${CHUNK_COLUMNS})
      VALUES ${tuples.join(", ")}
      ON CONFLICT (project_id, path, start_line, end_line, content_hash)
      DO UPDATE SET
        repo_sha = EXCLUDED.repo_sha,
        lang = EXCLUDED.lang,
        kind = EXCLUDED.kind,
        symbol = EXCLUDED.symbol,
        content = EXCLUDED.content,
        header = EXCLUDED.header,
        parser = EXCLUDED.parser
    `;
    const result = await db.query(sql, values);
    written += result.rowCount ?? batch.length;
  }
  return written;
}

/** Upsert one row per project into `index_manifest`. */
export async function upsertManifest(
  stats: ProjectStats,
  db: Queryable,
  embeddingModel = "",
  embeddingDim = 0,
): Promise<void> {
  await db.query(
    `INSERT INTO index_manifest
       (project_id, repo_url, repo_sha, indexed_at, file_count, chunk_count, embedding_model, embedding_dim, content_hash)
     VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8)
     ON CONFLICT (project_id) DO UPDATE SET
       repo_url = EXCLUDED.repo_url,
       repo_sha = EXCLUDED.repo_sha,
       indexed_at = now(),
       file_count = EXCLUDED.file_count,
       chunk_count = EXCLUDED.chunk_count,
       embedding_model = CASE WHEN EXCLUDED.embedding_model <> '' THEN EXCLUDED.embedding_model ELSE index_manifest.embedding_model END,
       embedding_dim = CASE WHEN EXCLUDED.embedding_dim <> 0 THEN EXCLUDED.embedding_dim ELSE index_manifest.embedding_dim END,
       content_hash = EXCLUDED.content_hash`,
    [
      stats.id,
      stats.repoUrl,
      stats.repoSha,
      stats.filesChunked,
      stats.chunksProduced,
      embeddingModel,
      embeddingDim,
      contentHash([stats.repoSha, String(stats.chunksProduced)]),
    ],
  );
}

/** Remove chunks for a project that are no longer part of the corpus. */
export async function pruneStaleChunks(
  projectId: string,
  validContentHashes: string[],
  db: Queryable,
): Promise<number> {
  if (validContentHashes.length === 0) return 0;
  const result = await db.query(
    `DELETE FROM chunks WHERE project_id = $1 AND NOT (content_hash = ANY($2::text[]))`,
    [projectId, validContentHashes],
  );
  return result.rowCount ?? 0;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

function printFinding(finding: Finding): string {
  return `    [${finding.severity.toUpperCase()}] ${finding.file}:${finding.line}:${finding.column}  ${finding.rule}  ${finding.match}`;
}

/** Read a file, optionally redacting owner PII in place (line count preserved). */
function makeReader(redactPii: boolean): (absolutePath: string) => string {
  return (absolutePath: string) => {
    const raw = readFileSync(absolutePath, "utf8");
    return redactPii ? redactOwnerPii(raw) : raw;
  };
}

/** Load `.env.local` when the environment does not already have a URL. */
function loadLocalEnv(): void {
  if (process.env.DATABASE_URL) return;
  const envFile = path.join(process.cwd(), ".env.local");
  try {
    process.loadEnvFile(envFile);
  } catch {
    // No .env.local: the environment must provide the URL.
  }
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  loadLocalEnv();
  const options = parseArgs(process.argv.slice(2));

  if (options.project && !getProject(options.project)) {
    console.error(
      `Unknown project "${options.project}". Known ids: ${PROJECTS.map((p) => p.id).join(", ")}`,
    );
    process.exitCode = 2;
    return;
  }

  const projects = options.project
    ? PROJECTS.filter((p) => p.id === options.project)
    : PROJECTS;

  console.log("=".repeat(78));
  console.log("kaustubh-portfolio :: code indexer");
  console.log("=".repeat(78));
  console.log(`mode            : ${options.dryRun ? "dry-run" : "write"}`);
  console.log(`projects        : ${projects.map((p) => p.id).join(", ")}`);
  console.log(`owner PII       : ${options.redactPii ? "redacted in place" : "detected (blocks project)"}`);
  console.log("");

  const allChunks: Chunk[] = [];
  const statsList: ProjectStats[] = [];

  for (const project of projects) {
    const name = repoName(project);
    console.log("-".repeat(78));
    console.log(`>> ${project.id}  (${name} @ ${project.repoSha.slice(0, 7)})`);
    console.log(`   repo        : ${project.repoPath}`);
    console.log(`   remote      : ${project.repoUrl}`);

    const files = resolveFiles(project);
    console.log(`   files       : ${plural(files.length, "allow-listed file")}`);

    if (files.length === 0) {
      console.log("   STATUS      : SKIPPED (repository not found or nothing allow-listed)");
      console.log("");
      statsList.push({
        id: project.id,
        name,
        repoUrl: project.repoUrl,
        repoSha: project.repoSha,
        filesScanned: 0,
        filesChunked: 0,
        chunksProduced: 0,
        linesCovered: 0,
        findings: 0,
        blockFindings: 0,
        warnFindings: 0,
        status: "skipped",
        coverageFailures: [],
      });
      continue;
    }

    // ---- step 2: the hard gate -----------------------------------------
    const readFile = makeReader(options.redactPii);
    const findings: Finding[] = [];
    for (const relPath of files) {
      let content: string;
      try {
        content = readFile(path.join(project.repoPath, relPath));
      } catch {
        continue;
      }
      findings.push(...scanContent(content, relPath).findings);
    }

    const blockFindings = findings.filter((f) => f.severity === "block");
    const warnFindings = findings.filter((f) => f.severity === "warn");

    console.log(
      `   findings    : ${findings.length} (${blockFindings.length} block, ${warnFindings.length} warn)`,
    );
    for (const finding of findings) {
      console.log(printFinding(finding));
    }

    if (blockFindings.length > 0) {
      console.log(
        `   STATUS      : ABORTED - ${plural(blockFindings.length, "block-severity finding")} must be resolved before this project can be indexed`,
      );
      console.log("");
      statsList.push({
        id: project.id,
        name,
        repoUrl: project.repoUrl,
        repoSha: project.repoSha,
        filesScanned: files.length,
        filesChunked: 0,
        chunksProduced: 0,
        linesCovered: 0,
        findings: findings.length,
        blockFindings: blockFindings.length,
        warnFindings: warnFindings.length,
        status: "aborted",
        coverageFailures: [],
      });
      continue;
    }

    // ---- step 3: chunk --------------------------------------------------
    const { chunks, coverage } = await chunkProject(project, name, files, readFile);
    allChunks.push(...chunks);

    let linesCovered = 0;
    const coverageFailures: string[] = [];
    for (const relPath of files) {
      const result: CoverageResult | undefined = coverage.get(relPath);
      if (!result) continue;
      const fileChunks = chunks.filter((c) => c.path === relPath);
      for (const chunk of fileChunks) linesCovered += chunk.endLine - chunk.startLine + 1;
      if (!result.complete) {
        coverageFailures.push(
          `${relPath}: ${plural(result.gaps.length, "uncovered line")} (${result.gaps
            .slice(0, 8)
            .join(", ")}${result.gaps.length > 8 ? ", ..." : ""})`,
        );
      } else if (result.duplicates.length > 0) {
        const parser = fileChunks[0]?.parser ?? "window";
        if (parser === "tree-sitter") {
          coverageFailures.push(
            `${relPath}: ${plural(result.duplicates.length, "duplicated line")} in tree-sitter chunks`,
          );
        }
      }
    }

    const chunkedFiles = new Set(chunks.map((c) => c.path)).size;
    console.log(`   chunked     : ${plural(chunkedFiles, "file")}`);
    console.log(`   chunks      : ${plural(chunks.length, "chunk")}`);
    console.log(`   lines       : ${linesCovered.toLocaleString("en-US")} chunk lines`);
    console.log(
      `   coverage    : ${
        coverageFailures.length === 0
          ? "OK (every non-blank line covered)"
          : `${coverageFailures.length} file(s) failed`
      }`,
    );
    for (const failure of coverageFailures) console.log(`     ! ${failure}`);
    console.log(`   STATUS      : ${options.dryRun ? "WOULD INDEX" : "INDEXED"}`);
    console.log("");

    statsList.push({
      id: project.id,
      name,
      repoUrl: project.repoUrl,
      repoSha: project.repoSha,
      filesScanned: files.length,
      filesChunked: chunkedFiles,
      chunksProduced: chunks.length,
      linesCovered,
      findings: findings.length,
      blockFindings: blockFindings.length,
      warnFindings: warnFindings.length,
      status: "indexed",
      coverageFailures,
    });
  }

  // ---- summary ---------------------------------------------------------
  console.log("=".repeat(78));
  console.log("SUMMARY");
  console.log("=".repeat(78));
  console.log(
    "project".padEnd(18) +
      "files".padStart(8) +
      "chunked".padStart(9) +
      "chunks".padStart(9) +
      "lines".padStart(11) +
      "findings".padStart(10) +
      "  status",
  );
  for (const stats of statsList) {
    console.log(
      stats.id.padEnd(18) +
        String(stats.filesScanned).padStart(8) +
        String(stats.filesChunked).padStart(9) +
        String(stats.chunksProduced).padStart(9) +
        String(stats.linesCovered).padStart(11) +
        String(stats.findings).padStart(10) +
        `  ${stats.status}`,
    );
  }
  const totalChunks = statsList.reduce((sum, s) => sum + s.chunksProduced, 0);
  console.log("");
  console.log(`total chunks    : ${totalChunks.toLocaleString("en-US")}`);

  if (options.dryRun) {
    console.log("dry run         : nothing was written");
    return;
  }

  // ---- output ----------------------------------------------------------
  const outFile = options.out
    ? path.resolve(process.cwd(), options.out)
    : path.resolve(process.cwd(), "data", "index", "chunks.json");

  const databaseUrl = process.env.DATABASE_URL;
  if (!options.out && databaseUrl) {
    console.log("");
    console.log("DATABASE_URL is set -> upserting into Postgres");
    // `pg` is loaded lazily and untyped so the indexer does not need
    // `@types/pg` at build time.
    const require = createRequire(import.meta.url);
    const pg = require("pg") as {
      Pool: new (config: { connectionString: string }) => Queryable;
    };
    const pool = new pg.Pool({ connectionString: databaseUrl });
    try {
      for (const stats of statsList) {
        if (stats.status !== "indexed") continue;
        const projectChunks = allChunks.filter((c) => c.projectId === stats.id);
        const written = await upsertChunks(projectChunks, pool);
        const pruned = await pruneStaleChunks(
          stats.id,
          projectChunks.map((c) => c.contentHash),
          pool,
        );
        await upsertManifest(stats, pool);
        const prunedMsg = pruned > 0 ? `, ${pruned} stale chunks pruned` : "";
        console.log(`  ${stats.id}: ${written} chunks upserted${prunedMsg}`);
      }
    } finally {
      await (pool as unknown as { end?: () => Promise<void> }).end?.();
    }
    console.log("");
    console.log(`wrote to Postgres (${allChunks.length} chunks total)`);
    return;
  }

  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(
    outFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        projects: statsList,
        chunks: allChunks,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log("");
  console.log(`wrote ${allChunks.length} chunks to ${outFile}`);
}

/* ------------------------------------------------------------------ */

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  /scripts[\\/]index[\\/]index\.(ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { main };
export type { ProjectDef };
export { splitLines, verifyCoverage };
