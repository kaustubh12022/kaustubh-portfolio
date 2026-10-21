import "server-only";

/**
 * GET /api/health
 *
 * A liveness and readiness probe that names the failing layer.
 *
 * It answers:
 *   - is the app up?                    -> `ok`
 *   - is the source index populated?    -> `chunks`
 *   - which embedding model wrote it?   -> `embeddingModel`
 *   - can the assistant actually search?-> `retrieval`
 *   - how much of the daily budget is left? -> `spend`
 *
 * The `retrieval` block is the important one. The index can be populated and
 * the app can still be unable to search it: the embedding model may fail to
 * load, the pooled connection may be refused, or the ANN index may be
 * unusable through the pooler. Each of those has a different fix, so the
 * probe reports which one it is rather than a single boolean.
 *
 * The route never throws: a failure is reported as `ok: false` with the
 * reason, so a monitor gets a readable body instead of a stack trace.
 */

import { cacheSize } from "@/lib/ai/cache";
import {
  dailyCeilingUsd,
  spendRemainingUsd,
  spendTodayUsd,
} from "@/lib/ai/spend";
import { EMBEDDING_MODEL, embedQuery } from "@/lib/retrieval/embed";
import { rerank } from "@/lib/retrieval/rerank";
import { getProjectStats, searchChunks } from "@/lib/retrieval/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LayerState = {
  ok: boolean;
  detail: string;
};

/**
 * Exercise the retrieval path end to end, one layer at a time.
 *
 * This is a real query against the real index with a real embedding. It
 * costs no LLM tokens and takes a few milliseconds.
 */
async function probeRetrieval(): Promise<{
  embedding: LayerState;
  database: LayerState;
  search: LayerState;
  reranker: LayerState;
}> {
  let embedding: LayerState = { ok: false, detail: "not attempted" };
  let database: LayerState = { ok: false, detail: "not attempted" };
  let search: LayerState = { ok: false, detail: "not attempted" };
  let reranker: LayerState = { ok: false, detail: "not attempted" };

  let vector: Float32Array | null = null;
  try {
    const started = Date.now();
    vector = await embedQuery("health check: a function that returns a cost");
    embedding = {
      ok: vector.length > 0,
      detail: `loaded and embedded in ${Date.now() - started}ms, ${vector.length} dims`,
    };
  } catch (error) {
    embedding = {
      ok: false,
      detail: `the embedding model could not be loaded: ${(error as Error).message}`,
    };
  }

  if (!vector) {
    return {
      embedding,
      database: { ok: false, detail: "skipped: no embedding" },
      search: { ok: false, detail: "skipped: no embedding" },
      reranker: { ok: false, detail: "skipped: no embedding" },
    };
  }

  try {
    const started = Date.now();
    const stats = await getProjectStats();
    database = {
      ok: stats.length > 0,
      detail: `read ${stats.length} manifest rows in ${Date.now() - started}ms`,
    };
  } catch (error) {
    database = { ok: false, detail: (error as Error).message };
    return {
      embedding,
      database,
      search: { ok: false, detail: "skipped: the database is unreachable" },
      reranker: { ok: false, detail: "skipped: the database is unreachable" },
    };
  }

  try {
    const started = Date.now();
    const hits = await searchChunks({ query: "cost calculation", limit: 3 }, vector);
    search = {
      ok: hits.length > 0,
      detail: `${hits.length} hits in ${Date.now() - started}ms` +
        (hits.length ? `, top=${hits[0].path}:${hits[0].startLine}` : ""),
    };
  } catch (error) {
    search = { ok: false, detail: (error as Error).message };
  }

  /**
   * The cross-encoder is the SECOND stage of the retrieval pipeline.
   * It runs after the fusion, so a failure there is invisible in the search
   * layer: the search still returns hits, they are just ranked badly.
   * That is exactly the kind of silent degradation a health check has to
   * name, so it gets its own probe.
   */
  try {
    const started = Date.now();
    const scored = await rerank("health check: a function that returns a cost", [
      { id: "probe-1", text: "def calculate_deepseek_cost(usage):\n    return usage.total * 0.27" },
      { id: "probe-2", text: "const button = document.querySelector('.menu');" },
    ]);
    reranker = scored.length > 0
      ? {
          ok: true,
          detail: `scored ${scored.length} pairs in ${Date.now() - started}ms, ` +
            `top=${scored[0]?.id}`,
        }
      : {
          ok: false,
          detail: "the cross-encoder could not be loaded; the retriever is " +
            "running without a reranker and ranks the right file less precisely",
        };
  } catch (error) {
    reranker = { ok: false, detail: (error as Error).message };
  }

  return { embedding, database, search, reranker };
}

export async function GET(): Promise<Response> {
  try {
    const stats = await getProjectStats();

    const chunks = stats.reduce((total, row) => total + row.liveChunkCount, 0);
    const files = stats.reduce((total, row) => total + row.fileCount, 0);
    const models = [...new Set(stats.map((row) => row.embeddingModel).filter(Boolean))];

    const retrieval = await probeRetrieval();

    return Response.json(
      {
        ok: chunks > 0 && retrieval.search.ok,
        chunks,
        projects: stats.length,
        embeddingModel: models[0] ?? EMBEDDING_MODEL,
        files,
        /**
         * Each layer of the retrieval path, so a failure names itself.
         */
        retrieval,
        /**
         * The spend guard. `usdToday` is what this instance has spent
         * today, `remainingUsd` is what is left of the ceiling, and
         * `cachedAnswers` is how many answers are being served from memory
         * instead of the model.
         */
        spend: {
          usdToday: Number(spendTodayUsd().toFixed(6)),
          ceilingUsd: dailyCeilingUsd(),
          remainingUsd: Number(spendRemainingUsd().toFixed(6)),
          cachedAnswers: cacheSize(),
        },
        indexedAt:
          stats.length > 0
            ? stats.map((row) => ({
                projectId: row.projectId,
                repoSha: row.repoSha.slice(0, 12),
                indexedAt: row.indexedAt,
                liveChunkCount: row.liveChunkCount,
              }))
            : [],
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json(
      {
        ok: false,
        chunks: 0,
        projects: 0,
        embeddingModel: EMBEDDING_MODEL,
        error: (error as Error).message,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
