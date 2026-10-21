/**
 * Retrieval metrics.
 *
 * PURE FUNCTIONS. No database, no embeddings, no I/O. Everything in this
 * file can be unit tested with nothing but an array literal, which is what
 * `tests/eval/metrics.test.ts` does.
 *
 * WHY A HIT IS "RELEVANT"
 * -----------------------
 * The golden set names the file (and often the function) that answers a
 * question. A retrieved chunk counts as relevant when it is the SAME FILE and
 * it OVERLAPS the expected line range:
 *
 *     hit.path === relevant.path
 *     && hit.startLine <= relevant.endLine
 *     && hit.endLine   >= relevant.startLine
 *
 * Overlap, not equality: the indexer chunks by AST, so a function usually
 * lives in a chunk that is a superset of the exact function body. An exact
 * range match would score a perfectly correct retrieval as a miss.
 *
 * When the expectation names a SYMBOL but no line range, the hit has to come
 * from the same file AND carry the same symbol. When it names only a path,
 * any chunk of that file counts.
 *
 * THE METRICS
 * -----------
 *   recall@k     fraction of the expected ranges that were retrieved in the
 *                top k. "Did we find everything we needed?"
 *   hitRate@k    1 when at least ONE expected range was retrieved in the top
 *                k, else 0. "Did we find anything?"
 *   precision@k  fraction of the top k that was relevant. "How much noise?"
 *   MRR@k        1 / (rank of the first relevant hit). "How fast did we get
 *                to the right answer?"
 *   nDCG@k       the position-aware version of hitRate: a relevant hit at
 *                rank 1 is worth much more than one at rank k.
 *
 * All of them take the ALREADY ORDERED hit list. The caller decides the
 * order (the live retriever orders by the fused RRF score).
 */

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** A retrieved chunk, reduced to what the metrics need. */
export interface HitLike {
  /** Repo-relative POSIX path of the chunk. */
  path: string;
  /** 1-based first line of the chunk. */
  startLine: number;
  /** 1-based last line of the chunk. */
  endLine: number;
  /** The function/class/method the chunk owns, when it has one. */
  symbol?: string;
}

/**
 * An expected range.
 *
 * `startLine` / `endLine` are optional so an expectation can name a file
 * (or a symbol) without pinning exact lines.
 */
export interface RelevantRange {
  /** Repo-relative POSIX path. */
  path: string;
  /** 1-based first expected line. */
  startLine?: number;
  /** 1-based last expected line. */
  endLine?: number;
  /** The expected symbol, when the expectation names one. */
  symbol?: string;
}

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

/**
 * Do two line ranges overlap?
 *
 * A one-line range (start === end) counts as covering that single line, so
 * `overlap({1,1}, {1,5})` is true and `overlap({1,1}, {2,5})` is false.
 */
export function lineRangesOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/**
 * Does a retrieved chunk satisfy an expectation?
 *
 * The path must always match. Beyond that:
 *
 *   - the expectation has a line range -> the ranges must overlap
 *   - the expectation has a symbol    -> the chunk must carry that symbol
 *   - the expectation has neither      -> any chunk of the file counts
 */
export function isRelevantHit(hit: HitLike, relevant: RelevantRange): boolean {
  if (hit.path !== relevant.path) return false;

  const hasRange =
    typeof relevant.startLine === "number" &&
    typeof relevant.endLine === "number";

  if (hasRange) {
    return lineRangesOverlap(
      hit.startLine,
      hit.endLine,
      relevant.startLine as number,
      relevant.endLine as number,
    );
  }

  if (relevant.symbol) {
    const hitSymbol = (hit.symbol ?? "").toLowerCase();
    return hitSymbol === relevant.symbol.toLowerCase();
  }

  return true;
}

/** Does the hit satisfy ANY of the expectations? */
export function isRelevantToAny(
  hit: HitLike,
  relevant: RelevantRange[],
): boolean {
  return relevant.some((range) => isRelevantHit(hit, range));
}

/**
 * The expectations that were satisfied by the given hits.
 *
 * @returns the subset of `relevant` that at least one hit overlaps.
 */
export function matchedRanges(
  hits: HitLike[],
  relevant: RelevantRange[],
): RelevantRange[] {
  return relevant.filter((range) =>
    hits.some((hit) => isRelevantHit(hit, range)),
  );
}

/* ------------------------------------------------------------------ */
/* The metrics                                                         */
/* ------------------------------------------------------------------ */

/**
 * Recall@k: the fraction of the expected ranges that were retrieved.
 *
 * @param hits      the retrieved hits, BEST FIRST
 * @param relevant  the expected ranges
 * @param k         how many of the hits to consider
 * @returns a number in [0, 1]; 0 when there is nothing to find
 */
export function recallAtK(
  hits: HitLike[],
  relevant: RelevantRange[],
  k: number,
): number {
  if (relevant.length === 0) return 0;
  const top = hits.slice(0, Math.max(0, k));
  const matched = matchedRanges(top, relevant);
  return matched.length / relevant.length;
}

/**
 * Hit rate@k: 1 when at least one expectation was met in the top k.
 *
 * @returns 0 or 1
 */
export function hitRate(
  hits: HitLike[],
  relevant: RelevantRange[],
  k: number,
): number {
  if (relevant.length === 0) return 0;
  const top = hits.slice(0, Math.max(0, k));
  return matchedRanges(top, relevant).length > 0 ? 1 : 0;
}

/**
 * Precision@k: the fraction of the top k that was relevant.
 *
 * @returns a number in [0, 1]; 0 when there is nothing to find
 */
export function precisionAtK(
  hits: HitLike[],
  relevant: RelevantRange[],
  k: number,
): number {
  if (relevant.length === 0) return 0;
  const top = hits.slice(0, Math.max(0, k));
  if (top.length === 0) return 0;
  const relevantCount = top.filter((hit) => isRelevantToAny(hit, relevant))
    .length;
  return relevantCount / top.length;
}

/**
 * MRR@k: the reciprocal of the rank of the FIRST relevant hit.
 *
 * @returns a number in [0, 1]; 0 when nothing relevant was retrieved
 */
export function mrrAtK(
  hits: HitLike[],
  relevant: RelevantRange[],
  k: number,
): number {
  if (relevant.length === 0) return 0;
  const top = hits.slice(0, Math.max(0, k));
  for (let index = 0; index < top.length; index++) {
    const hit = top[index];
    if (hit && isRelevantToAny(hit, relevant)) return 1 / (index + 1);
  }
  return 0;
}

/**
 * nDCG@k: the normalised discounted cumulative gain.
 *
 * Gain is BINARY (a hit either satisfies an expectation or it does not), the
 * discount is `1 / log2(rank + 1)`, and the ideal ordering puts
 * `min(k, |relevant|)` relevant hits first.
 *
 * @returns a number in [0, 1]; 0 when there is nothing to find
 */
export function ndcgAtK(
  hits: HitLike[],
  relevant: RelevantRange[],
  k: number,
): number {
  if (relevant.length === 0) return 0;
  const top = hits.slice(0, Math.max(0, k));
  if (top.length === 0) return 0;

  let dcg = 0;
  for (let index = 0; index < top.length; index++) {
    const hit = top[index];
    if (hit && isRelevantToAny(hit, relevant)) {
      dcg += 1 / Math.log2(index + 2);
    }
  }

  const idealHits = Math.min(Math.max(0, k), relevant.length);
  let idcg = 0;
  for (let index = 0; index < idealHits; index++) {
    idcg += 1 / Math.log2(index + 2);
  }

  if (idcg === 0) return 0;
  return dcg / idcg;
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

/** The mean of a list of numbers. Returns 0 for an empty list. */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

/** One scored question. */
export interface ScoredQuestion {
  /** The id of the golden-set question. */
  id: string;
  /** The bucket it belongs to. */
  bucket: string;
  /** The project it is scoped to, when it is scoped to one. */
  project?: string;
  /** The metrics computed for it. */
  metrics: {
    recallAt5: number;
    recallAt10: number;
    mrrAt10: number;
    ndcgAt10: number;
    hitRateAt10: number;
    precisionAt10: number;
  };
  /** The top hits, for the report. */
  topHits: HitLike[];
}

/** The aggregate numbers of a set of scored questions. */
export interface AggregateMetrics {
  /** How many questions went into the aggregate. */
  count: number;
  recallAt5: number;
  recallAt10: number;
  mrrAt10: number;
  ndcgAt10: number;
  hitRateAt10: number;
  precisionAt10: number;
}

/**
 * Average the metrics of a set of scored questions.
 */
export function aggregate(
  scored: ScoredQuestion[],
): AggregateMetrics {
  const count = scored.length;
  return {
    count,
    recallAt5: mean(scored.map((item) => item.metrics.recallAt5)),
    recallAt10: mean(scored.map((item) => item.metrics.recallAt10)),
    mrrAt10: mean(scored.map((item) => item.metrics.mrrAt10)),
    ndcgAt10: mean(scored.map((item) => item.metrics.ndcgAt10)),
    hitRateAt10: mean(scored.map((item) => item.metrics.hitRateAt10)),
    precisionAt10: mean(scored.map((item) => item.metrics.precisionAt10)),
  };
}

/* ------------------------------------------------------------------ */
/* Fusion helper                                                       */
/* ------------------------------------------------------------------ */

/** One ranked leg of a fusion. */
export interface RankedLeg {
  /** The leg name. */
  name: string;
  /** The identifiers, best first. */
  ids: string[];
}

/** One fused document. */
export interface FusedScore {
  /** The document id. */
  id: string;
  /** The fused score. */
  score: number;
  /** The 1-based rank in each leg, `null` when the leg missed it. */
  ranks: Record<string, number | null>;
}

/**
 * Fuse ranked lists with Reciprocal Rank Fusion.
 *
 * `score(d) = sum over legs of 1 / (k + rank_in_leg(d))`
 *
 * This mirrors `fuseReciprocalRankFusion` in `lib/retrieval/search.ts`. It is
 * re-declared here so this module stays dependency free and unit testable
 * without the database.
 *
 * @param legs the ranked lists, best first
 * @param k    the damping constant, 60 by default
 */
export function fuseScores(
  legs: RankedLeg[],
  k = 60,
): FusedScore[] {
  const scores = new Map<string, number>();
  const ranks = new Map<string, Record<string, number | null>>();

  for (const leg of legs) {
    leg.ids.forEach((id, index) => {
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
      const entry = ranks.get(id) ?? {};
      for (const other of legs) entry[other.name] ??= null;
      entry[leg.name] = rank;
      ranks.set(id, entry);
    });
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, ranks: ranks.get(id) ?? {} }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
