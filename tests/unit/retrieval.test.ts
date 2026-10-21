/**
 * Retrieval layer unit tests.
 *
 *   npx vitest run tests/unit/retrieval.test.ts
 *
 * These tests run WITHOUT a database. The `pg` layer is mocked, so nothing
 * here can write to (or even read from) Neon.
 *
 * The embedding tests need the model. It is fetched once from the Hugging
 * Face CDN and cached under the OS temp directory, so the first run needs a
 * network connection and every later run is offline. When the model cannot
 * be loaded at all the embedding tests are SKIPPED (never silently passed);
 * when it can be loaded the assertions are hard failures.
 */

import { describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/* Mocked database layer                                               */
/* ------------------------------------------------------------------ */

const fake = vi.hoisted(() => {
  const state = {
    fileChunks: [] as Array<{
      start_line: number;
      end_line: number;
      content: string;
      symbol: string;
      kind: string;
    }>,
    claims: [] as Array<Record<string, unknown>>,
    calls: [] as Array<{ sql: string; values: unknown[] }>,
  };

  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    state.calls.push({ sql, values });
    const text = sql.toLowerCase();

    if (text.includes("from claims")) {
      if (text.includes("where id = $1")) {
        const id = String(values[0] ?? "");
        const row = state.claims.find((claim) => claim.id === id);
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (text.includes("lower(topic)")) {
        const topic = String(values[0] ?? "").toLowerCase();
        const row = state.claims.find(
          (claim) => String(claim.topic).toLowerCase() === topic,
        );
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: state.claims, rowCount: state.claims.length };
    }

    if (text.includes("from chunks c") && text.includes("c.path = $2")) {
      return { rows: state.fileChunks, rowCount: state.fileChunks.length };
    }

    return { rows: [], rowCount: 0 };
  });

  const client = { query, release: vi.fn() };
  return { state, query, client };
});

vi.mock("@/lib/retrieval/db", () => ({
  query: fake.query,
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) =>
    fn(fake.client),
  setLocalSearchEffort: async () => undefined,
  closePool: async () => undefined,
}));

// `server-only` throws outside a React Server Component context. The mocked
// database module already keeps it out of the graph, this is the second line
// of defence for anything that reaches for it directly.
vi.mock("server-only", () => ({}));

import {
  CLAIM_STATUSES,
  readClaimsYaml,
  getAllClaims,
  getClaim,
} from "@/lib/retrieval/claims";
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  EmbeddingUnavailableError,
  cosineSimilarity,
  embedDocuments,
  embedQuery,
} from "@/lib/retrieval/embed";
import {
  RRF_K,
  extractKeywords,
  fuseReciprocalRankFusion,
  likeTokenPairs,
  readFile,
  reconstructFileBody,
  singularVariants,
} from "@/lib/retrieval/search";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function norm(vector: Float32Array): number {
  let sum = 0;
  for (const value of vector) sum += value * value;
  return Math.sqrt(sum);
}

/** Skip the test when the model cannot be loaded (offline machine). */
async function loadOrSkip(
  ctx: { skip: (note?: string) => never },
  run: () => Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EmbeddingUnavailableError) {
      ctx.skip(`embedding model unavailable: ${error.reason}`);
      return;
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* Embeddings                                                          */
/* ------------------------------------------------------------------ */

const DOC_A =
  "def calculate_deepseek_cost(model, cached_tokens, miss_tokens, completion_tokens): returns round(cost, 8)";
const DOC_B =
  "src/scorer.py: run_all() warms the provider cache with one serial call then fans out with asyncio.gather";
const DOC_C =
  "findZeroSumSubsets builds a subset-sum DP with Int32Array(1 << n) to find exact zero-sum groups";
const SEMANTIC_QUERY = "how is the cost of deepseek scoring calculated";

describe("embeddings", () => {
  it("exposes the model and its dimension", () => {
    expect(EMBEDDING_MODEL).toBe("Xenova/all-MiniLM-L6-v2");
    expect(EMBEDDING_DIM).toBe(384);
  });

  it("returns one unit-normalised 384 dimensional vector per document", async (ctx) => {
    await loadOrSkip(ctx, async () => {
      const documents = [DOC_A, DOC_B, DOC_C];
      const vectors = await embedDocuments(documents);

      expect(vectors).toHaveLength(documents.length);
      for (const vector of vectors) {
        expect(vector).toBeInstanceOf(Float32Array);
        expect(vector.length).toBe(EMBEDDING_DIM);
        expect(norm(vector)).toBeCloseTo(1, 5);
      }

      // The pipeline returns ONE flat buffer. If the rows are not sliced
      // per row, every vector is the same and every similarity collapses.
      expect(cosineSimilarity(vectors[0], vectors[1])).toBeLessThan(0.99);
      expect(cosineSimilarity(vectors[1], vectors[2])).toBeLessThan(0.99);
    });
  });

  it("returns an empty array for an empty batch", async () => {
    expect(await embedDocuments([])).toEqual([]);
  });

  it("computes the cosine similarity of a vector with itself", async (ctx) => {
    await loadOrSkip(ctx, async () => {
      const [vector] = await embedDocuments([DOC_A]);
      expect(cosineSimilarity(vector, vector)).toBeCloseTo(1, 6);
    });
  });

  it("computes the cosine similarity of orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0, 0]);
    const b = new Float32Array([0, 1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
    expect(cosineSimilarity(a, new Float32Array([2, 0, 0, 0]))).toBeCloseTo(1, 6);
    expect(cosineSimilarity(new Float32Array([0, 0]), b)).toBe(0);
  });

  it("ranks the deepseek cost snippet highest for a cost question", async (ctx) => {
    await loadOrSkip(ctx, async () => {
      const documents = [DOC_A, DOC_B, DOC_C];
      const [vectorA, vectorB, vectorC] = await embedDocuments(documents);
      const query = await embedQuery(SEMANTIC_QUERY);

      const scoreA = cosineSimilarity(query, vectorA);
      const scoreB = cosineSimilarity(query, vectorB);
      const scoreC = cosineSimilarity(query, vectorC);

      console.log(
        `      scores: A=${scoreA.toFixed(4)} B=${scoreB.toFixed(4)} C=${scoreC.toFixed(4)}`,
      );

      expect(scoreA).toBeGreaterThan(scoreB);
      expect(scoreA).toBeGreaterThan(scoreC);
      // Measured reference values: A=0.7166 B=0.1807 C=0.1708
      expect(scoreA).toBeGreaterThan(0.5);
      expect(scoreB).toBeLessThan(0.5);
      expect(scoreC).toBeLessThan(0.5);
    });
  });
});

/* ------------------------------------------------------------------ */
/* RRF fusion                                                          */
/* ------------------------------------------------------------------ */

describe("reciprocal rank fusion", () => {
  it("sums 1/(k + rank) over the legs", () => {
    const fused = fuseReciprocalRankFusion([
      { name: "vector", ids: ["a", "b"] },
      { name: "keyword", ids: ["c"] },
    ]);

    const byId = new Map(fused.map((hit) => [hit.id, hit]));
    expect(byId.get("a")?.score).toBeCloseTo(1 / (RRF_K + 1), 12);
    expect(byId.get("b")?.score).toBeCloseTo(1 / (RRF_K + 2), 12);
    expect(byId.get("c")?.score).toBeCloseTo(1 / (RRF_K + 1), 12);
  });

  it("puts a document found by both legs above one found by a single leg", () => {
    const fused = fuseReciprocalRankFusion([
      { name: "vector", ids: ["both", "vector-only"] },
      { name: "keyword", ids: ["both", "keyword-only"] },
    ]);

    const byId = new Map(fused.map((hit) => [hit.id, hit]));
    const both = byId.get("both");
    const vectorOnly = byId.get("vector-only");
    const keywordOnly = byId.get("keyword-only");

    expect(fused[0].id).toBe("both");
    expect(both?.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 1), 12);
    expect(both?.score).toBeGreaterThan(vectorOnly?.score ?? 0);
    expect(both?.score).toBeGreaterThan(keywordOnly?.score ?? 0);
  });

  it("records the rank of every leg a document appeared in", () => {
    const fused = fuseReciprocalRankFusion([
      { name: "vector", ids: ["x", "y"] },
      { name: "keyword", ids: ["y", "z"] },
    ]);

    const byId = new Map(fused.map((hit) => [hit.id, hit]));
    expect(byId.get("x")?.ranks).toEqual({ vector: 1, keyword: null });
    expect(byId.get("y")?.ranks).toEqual({ vector: 2, keyword: 1 });
    expect(byId.get("z")?.ranks).toEqual({ vector: null, keyword: 2 });
  });

  it("orders the fused list by descending score", () => {
    const fused = fuseReciprocalRankFusion([
      { name: "vector", ids: ["a", "b", "c"] },
      { name: "keyword", ids: ["c", "a"] },
    ]);
    for (let i = 1; i < fused.length; i++) {
      expect(fused[i - 1].score).toBeGreaterThanOrEqual(fused[i].score);
    }
    // a: 1/61 (vector rank 1) + 1/62 (keyword rank 2) = 0.032522
    // c: 1/63 (vector rank 3) + 1/61 (keyword rank 1) = 0.032266
    expect(fused[0].id).toBe("a");
    expect(fused[0].score).toBeGreaterThan(
      fused.find((hit) => hit.id === "c")?.score ?? 0,
    );
  });
});

/* ------------------------------------------------------------------ */
/* Keyword extraction                                                  */
/* ------------------------------------------------------------------ */

describe("keyword extraction", () => {
  it("keeps identifiers intact and drops stop words", () => {
    const keywords = extractKeywords(
      "where is the calculate_deepseek_cost function in src/ai_engine.py",
    );
    expect(keywords).toContain("calculate_deepseek_cost");
    expect(keywords).toContain("ai_engine");
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("where");
    expect(keywords).not.toContain("is");
  });

  it("derives singular forms so plurals still match identifiers", () => {
    expect(singularVariants("overlaps")).toContain("overlap");
    expect(singularVariants("bookings")).toContain("booking");
    expect(singularVariants("policies")).toContain("policy");
    expect(singularVariants("cost")).toEqual([]);
  });

  it("keeps the token and the pattern arrays aligned", () => {
    const tokens = ["booking", "overlaps"];
    const { tokens: matchTokens, patterns } = likeTokenPairs(tokens);
    expect(matchTokens).toHaveLength(patterns.length);
    matchTokens.forEach((token, index) => {
      expect(patterns[index]).toBe(`%${token}%`);
    });
    expect(matchTokens).toContain("overlap");
  });
});

/* ------------------------------------------------------------------ */
/* File reconstruction                                                 */
/* ------------------------------------------------------------------ */

describe("file reconstruction", () => {
  it("rebuilds the exact source lines from overlapping chunks", () => {
    const body = reconstructFileBody([
      { startLine: 1, endLine: 3, content: "alpha\nbravo\ncharlie" },
      // The sliding window fallback overlaps by WINDOW_OVERLAP lines.
      { startLine: 3, endLine: 5, content: "charlie\ndelta\necho" },
      { startLine: 6, endLine: 7, content: "foxtrot\ngolf" },
    ]);

    expect(body.startLine).toBe(1);
    expect(body.endLine).toBe(7);
    expect(body.lines).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
    ]);
    expect(body.text).toBe(
      "alpha\nbravo\ncharlie\ndelta\necho\nfoxtrot\ngolf",
    );
  });

  it("keeps the CRLF line ending of the source", () => {
    const body = reconstructFileBody([
      { startLine: 1, endLine: 2, content: "alpha\r\nbravo\r" },
    ]);
    expect(body.lines).toEqual(["alpha\r", "bravo\r"]);
  });

  it("clips the reconstruction to the requested window", () => {
    const body = reconstructFileBody(
      [{ startLine: 1, endLine: 4, content: "one\ntwo\nthree\nfour" }],
      { start: 2, end: 3 },
    );
    expect(body.startLine).toBe(2);
    expect(body.endLine).toBe(3);
    expect(body.lines).toEqual(["two", "three"]);
    expect(body.text).toBe("two\nthree");
  });

  it("reads a file through the mocked database layer", async () => {
    fake.state.fileChunks = [
      {
        start_line: 1,
        end_line: 2,
        content: "import os\nprint(os.name)",
        symbol: "",
        kind: "block",
      },
      {
        start_line: 2,
        end_line: 3,
        content: "print(os.name)\nprint('done')",
        symbol: "",
        kind: "block",
      },
    ];

    const slice = await readFile("smartapply", "src/demo.py");
    expect(slice.projectId).toBe("smartapply");
    expect(slice.path).toBe("src/demo.py");
    expect(slice.chunkCount).toBe(2);
    expect(slice.startLine).toBe(1);
    expect(slice.endLine).toBe(3);
    expect(slice.lines).toEqual(["import os", "print(os.name)", "print('done')"]);
    // The text at line N is exactly the source line N.
    expect(slice.text.split("\n")[1]).toBe("print(os.name)");
  });
});

/* ------------------------------------------------------------------ */
/* Claim ledger                                                        */
/* ------------------------------------------------------------------ */

describe("claim ledger", () => {
  it("parses content/claims.yaml", () => {
    const claims = readClaimsYaml();
    expect(claims.length).toBeGreaterThan(0);

    for (const claim of claims) {
      expect(claim.id.length, claim.id).toBeGreaterThan(0);
      expect(CLAIM_STATUSES, claim.id).toContain(claim.status);
      expect(claim.publicWording.trim().length, claim.id).toBeGreaterThan(0);
      expect(claim.claim.trim().length, claim.id).toBeGreaterThan(0);
    }
  });

  it("keeps the ids unique", () => {
    const claims = readClaimsYaml();
    const ids = new Set(claims.map((claim) => claim.id));
    expect(ids.size).toBe(claims.length);
  });

  it("reads the claims back from the database layer", async () => {
    fake.state.claims = [
      {
        id: "smartapply-cost",
        topic: "SmartApply cost reduction",
        claim: "Ranking listings with >80% cost reduction.",
        status: "unverified",
        evidence: "The measurable result is 69.3% fewer LLM scoring calls.",
        source: "JobHunt-Automation/full_matrix_results.json",
        public_wording: "The filter cut scoring calls by 69% in the recorded batch.",
        created_at: "2026-10-19T00:00:00.000Z",
        updated_at: "2026-10-19T00:00:00.000Z",
      },
    ];

    const all = await getAllClaims();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe("smartapply-cost");
    expect(all[0].publicWording).toContain("69%");

    const byId = await getClaim("smartapply-cost");
    expect(byId?.topic).toBe("SmartApply cost reduction");

    const byTopic = await getClaim("SmartApply cost reduction");
    expect(byTopic?.id).toBe("smartapply-cost");

    expect(await getClaim("does-not-exist")).toBeNull();
  });
});
