/**
 * Unit tests for the retrieval metrics.
 *
 * EVERY CASE IS HAND COMPUTED. There is no fixture file and no snapshot: the
 * expected numbers are written out in the assertions so a reviewer can check
 * the arithmetic without running anything.
 *
 * The reference case the doc comment in `lib/eval/metrics.ts` talks about:
 * three hits, the relevant one at rank 2 -> recall@3 = 1, MRR@3 = 0.5.
 */

import { describe, expect, it } from "vitest";

import {
  aggregate,
  fuseScores,
  hitRate,
  isRelevantHit,
  lineRangesOverlap,
  mrrAtK,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  type HitLike,
  type RelevantRange,
} from "@/lib/eval/metrics";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const A: HitLike = { path: "a.ts", startLine: 1, endLine: 10 };
const B: HitLike = { path: "b.ts", startLine: 1, endLine: 10 };
const C: HitLike = { path: "c.ts", startLine: 1, endLine: 10 };

/** A hit that covers a range inside `a.ts`. */
const A_MID: HitLike = { path: "a.ts", startLine: 40, endLine: 60 };

describe("lineRangesOverlap", () => {
  it("treats a one line range as covering that line", () => {
    expect(lineRangesOverlap(5, 5, 1, 10)).toBe(true);
    expect(lineRangesOverlap(5, 5, 6, 10)).toBe(false);
  });

  it("detects a partial overlap in both directions", () => {
    expect(lineRangesOverlap(1, 5, 5, 9)).toBe(true);
    expect(lineRangesOverlap(5, 9, 1, 5)).toBe(true);
  });

  it("detects a gap", () => {
    expect(lineRangesOverlap(1, 4, 5, 9)).toBe(false);
  });
});

describe("isRelevantHit", () => {
  it("needs the same path", () => {
    expect(isRelevantHit(A, { path: "b.ts" })).toBe(false);
    expect(isRelevantHit(A, { path: "a.ts" })).toBe(true);
  });

  it("accepts a hit that CONTAINS the expected range", () => {
    expect(
      isRelevantHit(A, { path: "a.ts", startLine: 4, endLine: 6 }),
    ).toBe(true);
  });

  it("accepts a hit that is CONTAINED BY the expected range", () => {
    expect(
      isRelevantHit(A_MID, { path: "a.ts", startLine: 1, endLine: 100 }),
    ).toBe(true);
  });

  it("rejects a hit on the same file that does not overlap", () => {
    expect(
      isRelevantHit(A, { path: "a.ts", startLine: 50, endLine: 60 }),
    ).toBe(false);
  });

  it("falls back to the symbol when no range is given", () => {
    const hit: HitLike = { path: "a.ts", startLine: 1, endLine: 10, symbol: "run_all" };
    expect(isRelevantHit(hit, { path: "a.ts", symbol: "run_all" })).toBe(true);
    expect(isRelevantHit(hit, { path: "a.ts", symbol: "RUN_ALL" })).toBe(true);
    expect(isRelevantHit(hit, { path: "a.ts", symbol: "other" })).toBe(false);
  });
});

describe("recall / hit rate / MRR", () => {
  const relevant: RelevantRange[] = [{ path: "b.ts", startLine: 5, endLine: 7 }];

  it("scores the reference case: the relevant hit is at rank 2 of 3", () => {
    const hits = [A, B, C];
    expect(recallAtK(hits, relevant, 3)).toBe(1);
    expect(mrrAtK(hits, relevant, 3)).toBe(0.5);
    expect(hitRate(hits, relevant, 3)).toBe(1);
    expect(precisionAtK(hits, relevant, 3)).toBeCloseTo(1 / 3, 10);
  });

  it("misses when the relevant hit falls outside the cut-off", () => {
    const hits = [A, C, B];
    expect(recallAtK(hits, relevant, 2)).toBe(0);
    expect(mrrAtK(hits, relevant, 2)).toBe(0);
    expect(hitRate(hits, relevant, 2)).toBe(0);
    expect(precisionAtK(hits, relevant, 2)).toBe(0);
    expect(ndcgAtK(hits, relevant, 2)).toBe(0);
  });

  it("gives a perfect MRR when the relevant hit is first", () => {
    const hits = [B, A, C];
    expect(mrrAtK(hits, relevant, 3)).toBe(1);
    expect(recallAtK(hits, relevant, 3)).toBe(1);
  });

  it("counts each expected range separately", () => {
    const two: RelevantRange[] = [
      { path: "a.ts", startLine: 1, endLine: 10 },
      { path: "b.ts", startLine: 1, endLine: 10 },
    ];
    const hits = [A, C, B];
    // Both expected ranges are inside the top 3.
    expect(recallAtK(hits, two, 3)).toBe(1);
    // Only the first one is inside the top 2.
    expect(recallAtK(hits, two, 2)).toBe(0.5);
    expect(precisionAtK(hits, two, 3)).toBeCloseTo(2 / 3, 10);
  });

  it("returns 0 when there is nothing to find", () => {
    expect(recallAtK([A], [], 3)).toBe(0);
    expect(mrrAtK([A], [], 3)).toBe(0);
    expect(hitRate([A], [], 3)).toBe(0);
    expect(ndcgAtK([A], [], 3)).toBe(0);
  });

  it("returns 0 for k = 0", () => {
    expect(recallAtK([A], [{ path: "a.ts" }], 0)).toBe(0);
  });
});

describe("nDCG", () => {
  it("is 1 / log2(3) when the single relevant hit is at rank 2 of 3", () => {
    const hits = [A, B, C];
    const relevant: RelevantRange[] = [{ path: "b.ts" }];
    // DCG@3 = 1/log2(3) = 0.6309297535714574
    // IDCG@3 = 1/log2(2) = 1
    expect(ndcgAtK(hits, relevant, 3)).toBeCloseTo(0.6309297535714574, 12);
  });

  it("is 1 when the relevant hit is first", () => {
    const hits = [B, A, C];
    const relevant: RelevantRange[] = [{ path: "b.ts" }];
    expect(ndcgAtK(hits, relevant, 3)).toBeCloseTo(1, 12);
  });

  it("is 1.5 / 1.6309297535714574 for two relevant hits at ranks 1 and 3", () => {
    const hits = [A, C, B];
    const relevant: RelevantRange[] = [{ path: "a.ts" }, { path: "b.ts" }];
    // DCG@3  = 1/log2(2) + 1/log2(4) = 1 + 0.5            = 1.5
    // IDCG@3 = 1/log2(2) + 1/log2(3) = 1 + 0.63092975357  = 1.63092975357
    const expected = 1.5 / 1.6309297535714574;
    expect(ndcgAtK(hits, relevant, 3)).toBeCloseTo(expected, 12);
    expect(expected).toBeCloseTo(0.9197207891481877, 12);
  });

  it("is 0 when nothing relevant was retrieved", () => {
    expect(ndcgAtK([A, C], [{ path: "b.ts" }], 3)).toBe(0);
  });
});

describe("fuseScores", () => {
  it("fuses two legs with RRF and keeps the per-leg ranks", () => {
    const fused = fuseScores(
      [
        { name: "vector", ids: ["a", "b", "c"] },
        { name: "keyword", ids: ["b", "a", "d"] },
      ],
      60,
    );

    // a: 1/61 + 1/62 = 0.0325224795449613...
    // b: 1/62 + 1/61 = the same
    // c: 1/63 = 0.015873015873015872
    // d: 1/63 = the same
    expect(fused.map((hit) => hit.id)).toEqual(["a", "b", "c", "d"]);
    expect(fused[0]?.score).toBeCloseTo(1 / 61 + 1 / 62, 12);
    expect(fused[2]?.score).toBeCloseTo(1 / 63, 12);

    expect(fused[0]?.ranks).toEqual({ vector: 1, keyword: 2 });
    expect(fused[1]?.ranks).toEqual({ vector: 2, keyword: 1 });
    expect(fused[2]?.ranks).toEqual({ vector: 3, keyword: null });
    expect(fused[3]?.ranks).toEqual({ vector: null, keyword: 3 });
  });

  it("returns nothing for no legs", () => {
    expect(fuseScores([])).toEqual([]);
  });
});

describe("aggregate", () => {
  it("averages the metrics over the questions", () => {
    const scored = [
      {
        id: "q001",
        bucket: "code_explanation",
        metrics: {
          recallAt5: 1,
          recallAt10: 1,
          mrrAt10: 1,
          ndcgAt10: 1,
          hitRateAt10: 1,
          precisionAt10: 1,
        },
        topHits: [],
      },
      {
        id: "q002",
        bucket: "code_explanation",
        metrics: {
          recallAt5: 0,
          recallAt10: 0,
          mrrAt10: 0,
          ndcgAt10: 0,
          hitRateAt10: 0,
          precisionAt10: 0,
        },
        topHits: [],
      },
    ];
    const result = aggregate(scored);
    expect(result.count).toBe(2);
    expect(result.recallAt5).toBe(0.5);
    expect(result.mrrAt10).toBe(0.5);
    expect(result.ndcgAt10).toBe(0.5);
  });
});
