#!/usr/bin/env node
/**
 * Embed the indexed corpus and persist the vectors.
 *
 *   npx tsx scripts/index/persist.ts [--project=<id>] [--file=<path>] [--batch=<n>] [--force]
 *
 * WHY A SEPARATE STEP
 * -------------------
 * The indexer (`npm run index`) is fast and deterministic: it parses the
 * source, chunks it and writes the rows. Embedding is the slow, expensive
 * part (a model download plus one ONNX forward pass per chunk). Splitting
 * the two means re-indexing a project does not re-embed the whole corpus,
 * and the embedding step is incremental: a chunk whose `content_hash` is
 * already stored with the SAME embedding model is not embedded again.
 *
 * PIPELINE
 * --------
 *   1. read the chunks produced by the indexer
 *   2. look up which `content_hash` values already carry a vector
 *   3. embed only the missing ones, in batches of 128
 *   4. upsert every chunk with its vector, the model name and the dimension
 *   5. stamp `index_manifest` with the model and the dimension so a model
 *      change is detected instead of silently producing nonsense distances
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  embedDocuments,
  toVectorLiteral,
} from "../../lib/retrieval/embed.js";
import { createPgPool, type PgPool } from "../../lib/retrieval/pg.js";
import type { Chunk, ProjectStats } from "./types.js";

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** How many documents are embedded in one ONNX batch. */
export const EMBED_BATCH_SIZE = 128;

/** How many rows are written per INSERT statement. */
export const ROW_BATCH_SIZE = 50;

/** Default location of the chunk file produced by the indexer. */
export const DEFAULT_CHUNKS_FILE = path.join(
  process.cwd(),
  "data",
  "index",
  "chunks.json",
);

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** Options of {@link embedAndPersist}. */
export interface PersistOptions {
  /** The pool to write to. */
  db: PgPool;
  /** Overrides the embedding model (only for experiments). */
  model?: string;
  /** Overrides the embedding dimension. */
  dim?: number;
  /** Documents per ONNX batch. */
  batchSize?: number;
  /** Rows per INSERT statement. */
  rowBatchSize?: number;
  /** Re-embed every chunk, even when a vector already exists. */
  force?: boolean;
  /** Progress callback. */
  onProgress?: (message: string) => void;
}

/** What {@link embedAndPersist} did. */
export interface PersistResult {
  /** Chunks handed in. */
  total: number;
  /** Chunks that went through the model. */
  embedded: number;
  /** Chunks whose vector was copied from an existing row. */
  reused: number;
  /** Rows written to the `chunks` table. */
  rowsWritten: number;
  /** ONNX batches executed. */
  batches: number;
  /** The embedding model used. */
  model: string;
  /** The embedding dimension used. */
  dim: number;
  /** Wall clock time of the whole operation. */
  elapsedMs: number;
}

/** A project entry of the chunk file, used to stamp the manifest. */
export interface ManifestEntry {
  id: string;
  repoUrl: string;
  repoSha: string;
  filesChunked: number;
  chunksProduced: number;
}

/* ------------------------------------------------------------------ */
/* SQL                                                                 */
/* ------------------------------------------------------------------ */

const EXISTING_VECTORS_SQL = `
  SELECT content_hash, embedding::text AS embedding
    FROM chunks
   WHERE content_hash = ANY($1::text[])
     AND embedding_model = $2
     AND embedding IS NOT NULL`;

const CHUNK_COLUMNS = [
  "project_id",
  "repo_sha",
  "path",
  "lang",
  "kind",
  "symbol",
  "symbols",
  "start_line",
  "end_line",
  "content",
  "header",
  "content_hash",
  "parser",
  "embedding",
  "embedding_model",
  "embedding_dim",
];

const UPSERT_CHUNK_SQL = `
  INSERT INTO chunks (${CHUNK_COLUMNS.join(", ")})
  VALUES %VALUES%
  ON CONFLICT (project_id, path, start_line, end_line, content_hash) DO UPDATE SET
    repo_sha       = EXCLUDED.repo_sha,
    lang           = EXCLUDED.lang,
    kind           = EXCLUDED.kind,
    symbol         = EXCLUDED.symbol,
    symbols        = EXCLUDED.symbols,
    content        = EXCLUDED.content,
    header         = EXCLUDED.header,
    parser         = EXCLUDED.parser,
    embedding      = EXCLUDED.embedding,
    embedding_model = EXCLUDED.embedding_model,
    embedding_dim  = EXCLUDED.embedding_dim`;

const UPSERT_MANIFEST_SQL = `
  INSERT INTO index_manifest
    (project_id, repo_url, repo_sha, indexed_at, file_count, chunk_count, embedding_model, embedding_dim, content_hash)
  VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8)
  ON CONFLICT (project_id) DO UPDATE SET
    repo_url        = EXCLUDED.repo_url,
    repo_sha        = EXCLUDED.repo_sha,
    indexed_at      = now(),
    file_count      = EXCLUDED.file_count,
    chunk_count     = EXCLUDED.chunk_count,
    embedding_model = EXCLUDED.embedding_model,
    embedding_dim   = EXCLUDED.embedding_dim,
    content_hash    = EXCLUDED.content_hash`;

/* ------------------------------------------------------------------ */
/* Embedding                                                           */
/* ------------------------------------------------------------------ */

/** The text that is embedded for a chunk: the header plus the source. */
export function embeddingText(chunk: Chunk): string {
  return `${chunk.header}\n${chunk.content}`;
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

/**
 * Embed chunks and write the vectors to the `chunks` table.
 *
 * Incremental by `content_hash`: a chunk whose hash is already stored with
 * the same embedding model keeps its existing vector instead of being
 * embedded again. That is what makes a re-index of a single project cheap.
 */
/**
 * Delete the chunks of a project that are no longer in the index.
 *
 * WHY THIS EXISTS
 * ---------------
 * The conflict key of the chunks table is
 * `(project_id, path, start_line, end_line, content_hash)`. When a function
 * changes, its content hash changes, so the new version is INSERTED and the
 * old row SURVIVES - two overlapping chunks for the same path and lines, the
 * stale one still carrying a live vector and still being returned by every
 * retrieval leg.
 *
 * The corpus was clean because every project had been indexed exactly once.
 * The first commit that changes a file starts accumulating orphans, and
 * nothing would ever notice, because the orphan looks exactly like a real
 * chunk to the retriever.
 *
 * The prune is per project and only runs for the project that was just
 * indexed, so it can never remove another project's data.
 */
export async function pruneStaleChunks(
  db: { query: (sql: string, values?: unknown[]) => Promise<{ rowCount: number | null }> },
  projectId: string,
  liveHashes: string[],
): Promise<number> {
  if (liveHashes.length === 0) return 0;
  const result = await db.query(
    `DELETE FROM chunks
      WHERE project_id = $1
        AND NOT (content_hash = ANY($2::text[]))`,
    [projectId, liveHashes],
  );
  return result.rowCount ?? 0;
}

export async function embedAndPersist(
  chunks: Chunk[],
  options: PersistOptions,
): Promise<PersistResult> {
  const started = Date.now();
  const model = options.model ?? EMBEDDING_MODEL;
  const dim = options.dim ?? EMBEDDING_DIM;
  const batchSize = options.batchSize ?? EMBED_BATCH_SIZE;
  const rowBatchSize = options.rowBatchSize ?? ROW_BATCH_SIZE;
  const log = options.onProgress ?? (() => undefined);

  if (chunks.length === 0) {
    return {
      total: 0,
      embedded: 0,
      reused: 0,
      rowsWritten: 0,
      batches: 0,
      model,
      dim,
      elapsedMs: Date.now() - started,
    };
  }

  // ---- 1. what already has a vector? ---------------------------------
  const hashes = [...new Set(chunks.map((chunk) => chunk.contentHash))];
  const existing = new Map<string, string>();
  if (!options.force) {
    const result = await options.db.query<{
      content_hash: string;
      embedding: string;
    }>(EXISTING_VECTORS_SQL, [hashes, model]);
    for (const row of result.rows) existing.set(row.content_hash, row.embedding);
  }

  // ---- 2. split into "reuse" and "embed" ------------------------------
  const toEmbed: Chunk[] = [];
  const vectors = new Map<string, string>();
  for (const chunk of chunks) {
    const known = existing.get(chunk.contentHash);
    if (known) {
      vectors.set(chunk.contentHash, known);
    } else {
      toEmbed.push(chunk);
    }
  }

  log(
    `model        : ${model} (${dim} dims)`,
  );
  log(
    `chunks       : ${chunks.length} total, ${toEmbed.length} to embed, ` +
      `${chunks.length - toEmbed.length} reused`,
  );

  // ---- 3. embed the missing ones --------------------------------------
  let batches = 0;
  for (let offset = 0; offset < toEmbed.length; offset += batchSize) {
    const batch = toEmbed.slice(offset, offset + batchSize);
    const texts = batch.map((chunk) => embeddingText(chunk));
    const embedded = await embedDocuments(texts);
    for (let i = 0; i < batch.length; i++) {
      vectors.set(batch[i].contentHash, toVectorLiteral(embedded[i]));
    }
    batches++;
    log(
      `embedded     : ${Math.min(offset + batch.length, toEmbed.length)} / ` +
        `${toEmbed.length}`,
    );
  }

  // ---- 4. write the rows ----------------------------------------------
  let rowsWritten = 0;
  for (let offset = 0; offset < chunks.length; offset += rowBatchSize) {
    const batch = chunks.slice(offset, offset + rowBatchSize);
    const values: unknown[] = [];
    const tuples = batch.map((chunk, index) => {
      const base = index * CHUNK_COLUMNS.length;
      values.push(
        chunk.projectId,
        chunk.repoSha,
        chunk.path,
        chunk.language,
        chunk.kind,
        chunk.symbol,
        chunk.symbols ?? [],
        chunk.startLine,
        chunk.endLine,
        chunk.content,
        chunk.header,
        chunk.contentHash,
        chunk.parser,
        vectors.get(chunk.contentHash) ?? null,
        model,
        dim,
      );
      const placeholders = CHUNK_COLUMNS.map(
        (_, column) => `$${base + column + 1}`,
      );
      return `(${placeholders.join(", ")})`;
    });
    const sql = UPSERT_CHUNK_SQL.replace(
      "%VALUES%",
      tuples.join(", "),
    );
    const result = await options.db.query(sql, values);
    rowsWritten += result.rowCount ?? batch.length;
  }
  log(`rows written : ${rowsWritten}`);

  return {
    total: chunks.length,
    embedded: toEmbed.length,
    reused: chunks.length - toEmbed.length,
    rowsWritten,
    batches,
    model,
    dim,
    elapsedMs: Date.now() - started,
  };
}

/**
 * Stamp `index_manifest` with the embedding model and dimension.
 *
 * The manifest is the guard against mixing vector spaces: if the model
 * changes, the dimension changes with it and the mismatch is visible
 * instead of producing silently wrong distances.
 */
export async function stampManifest(
  db: PgPool,
  entries: ManifestEntry[],
  model: string,
  dim: number,
): Promise<number> {
  for (const entry of entries) {
    await db.query(UPSERT_MANIFEST_SQL, [
      entry.id,
      entry.repoUrl,
      entry.repoSha,
      entry.filesChunked,
      entry.chunksProduced,
      model,
      dim,
      "",
    ]);
  }
  return entries.length;
}

/* ------------------------------------------------------------------ */
/* Chunk sources                                                       */
/* ------------------------------------------------------------------ */

const CHUNKS_FROM_DB_SQL = `
  SELECT project_id, repo_sha, path, lang, kind, symbol, symbols,
         start_line, end_line, content, header, content_hash, parser
    FROM chunks
   WHERE ($1::text IS NULL OR project_id = $1)
   ORDER BY project_id, path, start_line`;

interface ChunkDbRow {
  project_id: string;
  repo_sha: string;
  path: string;
  lang: string;
  kind: string;
  symbol: string;
  symbols: string[];
  start_line: number;
  end_line: number;
  content: string;
  header: string;
  content_hash: string;
  parser: string;
}

/**
 * Read the chunks to embed straight from the `chunks` table.
 *
 * The database is the source of truth: the indexer already applied the
 * secret/PII gate and the owner PII redaction, so the corpus that gets
 * embedded is exactly the corpus that will be served.
 */
export async function loadChunksFromDb(
  db: PgPool,
  projectId?: string,
): Promise<Chunk[]> {
  const result = await db.query<ChunkDbRow>(CHUNKS_FROM_DB_SQL, [
    projectId ?? null,
  ]);
  return result.rows.map((row) => ({
    projectId: row.project_id,
    repoSha: row.repo_sha,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    kind: row.kind as Chunk["kind"],
    symbol: row.symbol ?? "",
    symbols: row.symbols ?? [],
    content: row.content,
    header: row.header ?? "",
    parser: row.parser as Chunk["parser"],
    language: row.lang,
    contentHash: row.content_hash,
  }));
}

/** Read the chunks to embed from a `chunks.json` produced by the indexer. */
export function loadChunksFromFile(
  file: string,
  projectId?: string,
): { chunks: Chunk[]; projects: ProjectStats[] } {
  const raw = JSON.parse(readFileSync(file, "utf8")) as {
    projects: ProjectStats[];
    chunks: Chunk[];
  };
  const projects = projectId
    ? raw.projects.filter((project) => String(project.id) === projectId)
    : raw.projects;
  const wanted = new Set<string>(projects.map((project) => String(project.id)));
  return {
    chunks: raw.chunks.filter((chunk) => wanted.has(chunk.projectId)),
    projects,
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

interface CliOptions {
  project?: string;
  source: "db" | "file";
  file: string;
  batch: number;
  force: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    source: "db",
    file: DEFAULT_CHUNKS_FILE,
    batch: EMBED_BATCH_SIZE,
    force: false,
  };
  for (const arg of argv) {
    if (arg.startsWith("--project=")) options.project = arg.slice(10);
    else if (arg.startsWith("--source=")) {
      const value = arg.slice(9);
      if (value !== "db" && value !== "file") {
        throw new Error(`--source must be "db" or "file", got "${value}"`);
      }
      options.source = value;
    } else if (arg.startsWith("--file=")) {
      options.file = path.resolve(arg.slice(7));
      options.source = "file";
    } else if (arg.startsWith("--batch=")) options.batch = Number(arg.slice(8));
    else if (arg === "--force") options.force = true;
  }
  return options;
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  loadLocalEnv();

  console.log("=".repeat(78));
  console.log("kaustubh-portfolio :: embed + persist");
  console.log("=".repeat(78));
  console.log(`source        : ${options.source}`);
  if (options.source === "file") console.log(`chunks file   : ${options.file}`);
  console.log(`project       : ${options.project ?? "(all)"}`);
  console.log(`batch size    : ${options.batch}`);
  console.log(`force         : ${options.force ? "yes" : "no"}`);
  console.log("");

  const pool = createPgPool(process.env.DATABASE_URL ?? "");
  try {
    let chunks: Chunk[];
    let manifest: ManifestEntry[] = [];

    if (options.source === "file") {
      const loaded = loadChunksFromFile(options.file, options.project);
      chunks = loaded.chunks;
      manifest = loaded.projects.map((project) => ({
        id: String(project.id),
        repoUrl: project.repoUrl,
        repoSha: project.repoSha,
        filesChunked: project.filesChunked,
        chunksProduced: project.chunksProduced,
      }));
    } else {
      chunks = await loadChunksFromDb(pool, options.project);
      const stats = await pool.query<{
        project_id: string;
        repo_url: string;
        repo_sha: string;
        file_count: number;
        chunk_count: number;
      }>(
        `SELECT project_id, repo_url, repo_sha, file_count, chunk_count
           FROM index_manifest
          WHERE ($1::text IS NULL OR project_id = $1)
          ORDER BY project_id`,
        [options.project ?? null],
      );
      manifest = stats.rows.map((row) => ({
        id: row.project_id,
        repoUrl: row.repo_url,
        repoSha: row.repo_sha,
        filesChunked: row.file_count,
        chunksProduced: row.chunk_count,
      }));
    }

    console.log(`chunks        : ${chunks.length}`);
    console.log("");

    const result = await embedAndPersist(chunks, {
      db: pool,
      batchSize: options.batch,
      force: options.force,
      onProgress: (message) => console.log(`  ${message}`),
    });

    await stampManifest(pool, manifest, result.model, result.dim);

    // ---- 5. prune the chunks that are no longer in the index -------------
    //
    // A changed file produces a new content hash, so the old row survives
    // the upsert. Left alone, the corpus grows a second, stale copy of
    // every file that ever changed, and the retriever keeps returning it.
    const byProject = new Map<string, string[]>();
    for (const chunk of chunks) {
      const project = chunk.projectId;
      const list = byProject.get(project) ?? [];
      list.push(chunk.contentHash);
      byProject.set(project, list);
    }
    let pruned = 0;
    for (const [projectId, hashes] of byProject) {
      const removed = await pruneStaleChunks(pool, projectId, hashes);
      pruned += removed;
      if (removed > 0) {
        console.log(`pruned        : ${removed} stale chunks from ${projectId}`);
      }
    }

    console.log("");
    console.log("SUMMARY");
    console.log("=".repeat(78));
    console.log(`model         : ${result.model} (${result.dim} dims)`);
    console.log(`chunks        : ${result.total}`);
    console.log(`pruned        : ${pruned} stale chunks`);
    console.log(`embedded      : ${result.embedded} (${result.batches} batches)`);
    console.log(`reused        : ${result.reused}`);
    console.log(`rows written  : ${result.rowsWritten}`);
    console.log(`elapsed       : ${(result.elapsedMs / 1000).toFixed(1)} s`);
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  /scripts[\\/]index[\\/]persist\.(ts|js)$/.test(process.argv[1]);

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export { main };

