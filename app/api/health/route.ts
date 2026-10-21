import "server-only";

/**
 * GET /api/health
 *
 * A cheap liveness + readiness probe.
 *
 * It answers three questions:
 *   - is the app up?                       -> `ok`
 *   - is the source index populated?       -> `chunks`
 *   - which embedding model wrote it?      -> `embeddingModel`
 *
 * The index statistics come from `getProjectStats()`, which reads the
 * `index_manifest` table and counts the live rows in `chunks`. A non-zero
 * chunk count means retrieval will actually work; a zero means the site is
 * up but the assistant can only answer from the claim ledger.
 *
 * The route never throws: a database failure is reported as `ok: false`
 * with the reason, so a monitor gets a 200 with a readable body instead of a
 * stack trace.
 */

import { EMBEDDING_MODEL } from "@/lib/retrieval/embed";
import { getProjectStats } from "@/lib/retrieval/search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const stats = await getProjectStats();

    const chunks = stats.reduce((total, row) => total + row.liveChunkCount, 0);
    const files = stats.reduce((total, row) => total + row.fileCount, 0);
    const models = [...new Set(stats.map((row) => row.embeddingModel).filter(Boolean))];

    return Response.json(
      {
        ok: chunks > 0,
        chunks,
        projects: stats.length,
        embeddingModel: models[0] ?? EMBEDDING_MODEL,
        files,
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
