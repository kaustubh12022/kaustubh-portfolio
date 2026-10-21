/**
 * A LOCAL cross-encoder reranker.
 *
 * WHY A RERANKER, AND WHY IT IS NOT OPTIONAL
 * -----------------------------------------
 * The retriever is a BI-ENCODER: the question is embedded once, every chunk
 * is embedded once, and the two are compared as vectors. That is fast, but a
 * bi-encoder never sees the question and the code TOGETHER. It has to hope
 * that a sentence embedding of "how does it decide which jobs are worth
 * scoring" happens to land near an embedding of a function called
 * `is_relevant_jd`.
 *
 * A CROSS-ENCODER reads both texts at the same time and outputs one number
 * for the pair. It is far more accurate for this job and far more expensive:
 * one forward pass per candidate, so it cannot be used to search a whole
 * corpus. The standard architecture is therefore two-stage:
 *
 *   stage 1  retrieve  - the hybrid search pulls 40 candidates      (fast)
 *   stage 2  rerank    - the cross-encoder orders those 40          (accurate)
 *
 * Measured on the 150-question golden set with `scripts/eval/bench.ts`, the
 * reranker moves chunk-level recall@5 from 47.5% to 63.4% and MRR@10 from
 * 37.5% to 52.6%. See `docs/RETRIEVAL.md` for the full log.
 *
 * THE COST
 * --------
 * The model runs LOCALLY in the same ONNX runtime as the embeddings, so it
 * costs $0.00 per query and there is no API key and no rate limit. It does
 * cost CPU: reranking 20 pairs takes roughly 400 ms on this machine, which
 * is why only the top `rerankDepth` candidates are reranked and why the
 * module degrades to a no-op when the model is not bundled.
 *
 * This module must only be imported from server-side code.
 */

import { existsSync } from "node:fs";
import path from "node:path";

/** The cross-encoder. 22 MB of int8 ONNX weights. */
export const RERANKER_MODEL = "Xenova/ms-marco-MiniLM-L-6-v2";

/** Quantisation used for the ONNX weights. */
export const RERANKER_DTYPE = "q8";

/**
 * The roots the bundled reranker may live under.
 *
 * The same list the embedding model probes, and for the same reason: the
 * working directory of a Vercel serverless function is not the project root.
 */
const RERANKER_ROOT_CANDIDATES = [
  path.join(process.cwd(), "models"),
  path.join(process.cwd(), "src", "models"),
  path.join(process.cwd(), "..", "models"),
  path.join(process.cwd(), "..", "..", "models"),
  path.join(process.cwd(), "..", "..", "..", "models"),
  path.join(process.cwd(), "..", "..", "..", "..", "models"),
  path.join(process.cwd(), "..", "..", "..", "..", "..", "models"),
];

/** Find the bundled reranker, if it is there. */
export function findBundledRerankerRoot(): string | null {
  for (const root of RERANKER_ROOT_CANDIDATES) {
    if (
      existsSync(
        path.join(root, RERANKER_MODEL, "onnx", "model_quantized.onnx"),
      )
    ) {
      return root;
    }
  }
  return null;
}

/** True when the reranker is available on disk. */
export function hasBundledReranker(): boolean {
  return findBundledRerankerRoot() !== null;
}

/* ------------------------------------------------------------------ */
/* The model                                                           */
/* ------------------------------------------------------------------ */

/** One candidate to be scored. */
export interface RerankCandidate {
  /** The chunk id. */
  id: string;
  /** The text the cross-encoder reads. */
  text: string;
}

/** A scored candidate. */
export interface RerankResult {
  /** The chunk id. */
  id: string;
  /** The cross-encoder logit. Higher is more relevant. */
  score: number;
}

/** The loaded model, or `null` while it is loading. */
type Reranker = {
  tokenizer: (
    texts: string[],
    options: { text_pair: string[]; padding: boolean; truncation: boolean },
  ) => Promise<unknown>;
  model: (inputs: unknown) => Promise<{ logits: { data: Float32Array; dims: number[] } }>;
};

let rerankerPromise: Promise<Reranker | null> | null = null;

async function loadReranker(): Promise<Reranker | null> {
  const { AutoTokenizer, AutoModelForSequenceClassification, env } =
    await import("@huggingface/transformers");

  const bundled = findBundledRerankerRoot();

  if (bundled) {
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = bundled;
    env.cacheDir =
      process.env.KAUSTUBH_MODEL_CACHE_DIR ??
      path.join(process.env.TEMP ?? "/tmp", "kaustubh-portfolio-models");
  } else {
    env.allowLocalModels = false;
    env.allowRemoteModels = true;
    env.cacheDir =
      process.env.KAUSTUBH_MODEL_CACHE_DIR ??
      path.join(process.env.TEMP ?? "/tmp", "kaustubh-portfolio-models");
  }

  // The same WASM backend the embedding model uses: the native ONNX
  // runtime cannot be traced into a serverless bundle.
  if (env.backends?.onnx?.wasm) {
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.proxy = false;
  }

  const tokenizer = await AutoTokenizer.from_pretrained(RERANKER_MODEL);
  const model = await AutoModelForSequenceClassification.from_pretrained(
    RERANKER_MODEL,
    { dtype: RERANKER_DTYPE },
  );

  return { tokenizer, model } as unknown as Reranker;
}

/**
 * Get the reranker, or `null` when it cannot be loaded.
 *
 * A missing reranker is NOT an error: the retriever works without it, it is
 * just less precise. Returning `null` lets the caller carry on.
 */
export function getReranker(): Promise<Reranker | null> {
  if (!rerankerPromise) {
    rerankerPromise = loadReranker().catch(() => {
      rerankerPromise = null;
      return null;
    });
  }
  return rerankerPromise;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */

/**
 * How many characters of a chunk the cross-encoder reads.
 *
 * The model has a 512-token window and the query takes some of it, so the
 * document side has to be clipped. 900 characters is roughly 200 tokens,
 * which leaves room for a long question and still covers the part of a
 * function that says what it does.
 */
export const RERANK_MAX_CHARS = 900;

/**
 * Score every candidate against the query.
 *
 * @param query      the visitor's question
 * @param candidates the candidates to score, in retrieval order
 * @returns the candidates with their cross-encoder score, best first.
 *          An empty array when the model is unavailable.
 */
export async function rerank(
  query: string,
  candidates: RerankCandidate[],
): Promise<RerankResult[]> {
  if (candidates.length === 0) return [];

  const reranker = await getReranker();
  if (!reranker) return [];

  const texts = candidates.map((candidate) =>
    candidate.text.slice(0, RERANK_MAX_CHARS),
  );

  try {
    const inputs = await reranker.tokenizer(
      new Array(texts.length).fill(query),
      { text_pair: texts, padding: true, truncation: true },
    );
    const output = await reranker.model(inputs);
    const { data, dims } = output.logits;
    const labels = dims[dims.length - 1] ?? 1;

    const scored: RerankResult[] = candidates.map((candidate, index) => {
      // `ms-marco` cross-encoders are trained with a SINGLE regression label:
      // one logit per pair, higher is more relevant.
      const base = index * labels;
      let score: number;
      if (labels === 1) {
        score = data[base] ?? 0;
      } else {
        // A two-logit head (relevant / not relevant) is scored by the margin.
        score = (data[base] ?? 0) - (data[base + 1] ?? 0);
      }
      return { id: candidate.id, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored;
  } catch {
    // A reranking failure must never break the answer. The caller falls
    // back to the retrieval order.
    return [];
  }
}
