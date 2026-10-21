/**
 * Local, zero-cost sentence embeddings.
 *
 * MEASURED NUMBERS (this machine, Node 26, 2026-10-21)
 * ----------------------------------------------------
 *   model            : Xenova/all-MiniLM-L6-v2, dtype "q8" (int8 ONNX)
 *   dimensions       : 384
 *   first load       : ~12 s (one time: model download + ONNX session init)
 *   warm query       : ~2.8 ms per single query
 *   warm batch       : 128 documents in ~100 ms
 *   API cost         : $0.00 - everything runs in this process
 *   rate limits      : none, there is no remote API in the hot path
 *
 * The model is fetched once from the Hugging Face CDN and cached on disk
 * under the OS temp directory, so a warm process never touches the network.
 *
 * THE FLAT ARRAY TRAP
 * -------------------
 * The feature-extraction pipeline returns a `Tensor` whose `data` is ONE flat
 * `Float32Array` of `batch * dim` values, plus `dims: [batch, dim]`. Row `i`
 * is therefore `data.slice(i * dim, (i + 1) * dim)`. Reading
 * `data.slice(0, dim)` for every row silently produces identical (or
 * all-zero) similarities - the pipeline looks like it works but ranks
 * everything the same. `tests/unit/retrieval.test.ts` guards this.
 *
 * This module must only be imported from server-side code: it loads an ONNX
 * runtime, which has no business in a browser bundle.
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** The embedding model. Changing it requires re-embedding the whole corpus. */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

/** Dimensionality of the model. Matches `chunks.embedding vector(384)`. */
export const EMBEDDING_DIM = 384;

/** Quantisation used for the ONNX weights. `q8` keeps the download small. */
export const EMBEDDING_DTYPE = "q8";

/**
 * Directory the ONNX model is cached in.
 *
 * Overridable with `KAUSTUBH_MODEL_CACHE_DIR`; defaults to a folder under
 * the OS temp directory so a read-only deployment still works.
 */
export const MODEL_CACHE_DIR =
  process.env.KAUSTUBH_MODEL_CACHE_DIR ??
  path.join(os.tmpdir(), "kaustubh-portfolio-models");

/**
 * Where the model is bundled in the deployment.
 *
 * The model is 22.6 MB on disk, which is small enough to ship with the
 * application. That matters more than it looks: on a serverless host the
 * Hugging Face CDN is not always reachable, and a cold instance that cannot
 * download the model cannot answer from the source code at all - it falls
 * back to the claim ledger, which is a much weaker portfolio.
 *
 * Bundling the weights removes the network dependency and the ~12 second
 * cold-start download. The CDN stays as a fallback for a local checkout
 * that does not have the folder.
 */
export const BUNDLED_MODEL_DIR = path.join(
  process.cwd(),
  "models",
  "all-MiniLM-L6-v2",
);

/** True when the bundled model is present on disk. */
export function hasBundledModel(): boolean {
  return existsSync(
    path.join(BUNDLED_MODEL_DIR, "onnx", "model_quantized.onnx"),
  );
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

/**
 * Thrown when the embedding model cannot be loaded - typically because the
 * machine is offline and the model was never cached.
 *
 * The API route turns this into a graceful "retrieval unavailable" answer
 * instead of a 500: a portfolio assistant that cannot search should still be
 * able to answer from the claim ledger.
 */
export class EmbeddingUnavailableError extends Error {
  override readonly name = "EmbeddingUnavailableError";
  readonly reason: string;

  constructor(message: string, reason?: string) {
    super(message);
    this.reason = reason ?? "unknown";
  }
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

/** The shape of the pipeline output this module relies on. */
interface TensorLike {
  /** ONE flat buffer holding every row of the batch. */
  data: Float32Array | ArrayLike<number>;
  /** `[batch, dim]` for a 2D batch. */
  dims: number[];
}

/** The subset of the feature-extraction pipeline this module calls. */
type Extractor = (
  texts: string | string[],
  options?: { pooling?: "mean" | "cls" | "none"; normalize?: boolean },
) => Promise<TensorLike>;

let extractorPromise: Promise<Extractor> | null = null;

/** Load the model and the ONNX session. Runs at most once per process. */
async function loadExtractor(): Promise<Extractor> {
  // Imported dynamically so the ONNX runtime is not part of the module graph
  // until it is actually needed.
  const { pipeline, env } = await import("@huggingface/transformers");

  const bundled = hasBundledModel();

  if (bundled) {
    // The weights ship with the deployment: no network, no cold-start
    // download, and the serverless instance can answer immediately.
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = BUNDLED_MODEL_DIR;
    env.cacheDir = MODEL_CACHE_DIR;
  } else {
    // A local checkout without the bundled folder falls back to the CDN.
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.cacheDir = MODEL_CACHE_DIR;
  }

  const extractor = await pipeline("feature-extraction", EMBEDDING_MODEL, {
    dtype: EMBEDDING_DTYPE,
  });
  return extractor as unknown as Extractor;
}

/**
 * Get the (cached) feature-extraction pipeline.
 *
 * @throws {EmbeddingUnavailableError} when the model cannot be downloaded.
 */
export function getEmbeddingModel(): Promise<Extractor> {
  if (!extractorPromise) {
    extractorPromise = loadExtractor().catch((error: unknown) => {
      // Allow a later retry: a transient network failure should not poison
      // the process for its whole lifetime.
      extractorPromise = null;
      const detail = error instanceof Error ? error.message : String(error);
      throw new EmbeddingUnavailableError(
        `The embedding model "${EMBEDDING_MODEL}" could not be loaded from ` +
          `huggingface.co. It is cached in ${MODEL_CACHE_DIR} after the first ` +
          `successful download, so an offline machine only works once that ` +
          `cache exists.`,
        detail,
      );
    });
  }
  return extractorPromise;
}

/** True when the model can be loaded right now (used by the CLI/tests). */
export async function isEmbeddingAvailable(): Promise<boolean> {
  try {
    await getEmbeddingModel();
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Vector helpers                                                      */
/* ------------------------------------------------------------------ */

/** Copy a vector into a `Float32Array` regardless of the source type. */
function toFloat32(values: ArrayLike<number>): Float32Array {
  if (values instanceof Float32Array) return values;
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = Number(values[i]);
  return out;
}

/** Scale a vector to unit length. A zero vector is returned unchanged. */
export function normalizeVector(vector: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

/**
 * Cosine similarity of two vectors.
 *
 * Works for non-normalised inputs as well: both norms are applied
 * explicitly, so the result is always in [-1, 1].
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Split the flat pipeline output into one vector per input row.
 *
 * The pipeline hands back ONE `Float32Array` of `batch * dim` values plus
 * `dims: [batch, dim]`. Slicing per row is the only correct way to read it.
 */
export function rowsFromTensor(output: TensorLike): Float32Array[] {
  const data = toFloat32(output.data);
  const dims = output.dims ?? [];
  const dim = dims.length > 0 ? dims[dims.length - 1] : data.length;
  const batch = dims.length > 1 ? dims[0] : 1;
  const rows: Float32Array[] = [];
  for (let i = 0; i < batch; i++) {
    const row = data.slice(i * dim, (i + 1) * dim);
    rows.push(normalizeVector(toFloat32(row)));
  }
  return rows;
}

/**
 * Render a vector as a pgvector literal: `[0.1,0.2,...]`.
 *
 * pgvector parses the literal into a `vector` value; the column is declared
 * as `vector(384)`, so the length must match {@link EMBEDDING_DIM}.
 */
export function toVectorLiteral(vector: Float32Array): string {
  return `[${Array.from(vector).join(",")}]`;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Embed a batch of documents.
 *
 * @param texts the documents to embed
 * @returns one unit-normalised `Float32Array` of {@link EMBEDDING_DIM} values
 *          per input text, in the same order
 * @throws {EmbeddingUnavailableError} when the model cannot be loaded
 */
export async function embedDocuments(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await getEmbeddingModel();
  const output = await extractor(texts, { pooling: "mean", normalize: true });
  const rows = rowsFromTensor(output);
  if (rows.length !== texts.length) {
    throw new Error(
      `[retrieval] embedding batch mismatch: sent ${texts.length} texts, ` +
        `received ${rows.length} rows`,
    );
  }
  return rows;
}

/**
 * Embed a single query string.
 *
 * @throws {EmbeddingUnavailableError} when the model cannot be loaded
 */
export async function embedQuery(text: string): Promise<Float32Array> {
  const rows = await embedDocuments([text]);
  const row = rows[0];
  if (!row) {
    throw new Error("[retrieval] the embedding model returned no vector");
  }
  return row;
}
