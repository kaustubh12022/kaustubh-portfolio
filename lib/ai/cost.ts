import "server-only";

/**
 * Cost accounting.
 *
 * THREE RATES, NOT ONE
 * --------------------
 * DeepSeek bills the request prefix at a CACHE HIT rate and a CACHE MISS
 * rate, and the completion at its own rate. A single "input tokens" number
 * therefore cannot price a request.
 *
 *   cache hit   : $0.003 / M tokens   (off peak)
 *   cache miss  : $0.15  / M tokens   (off peak)
 *   completion  : $0.60  / M tokens   (off peak)
 *
 * TIME OF DAY
 * -----------
 * These are the OFF-PEAK rates. DeepSeek's peak window (16:00-00:00 UTC)
 * roughly DOUBLES the input rates; the output rate is unchanged. The rates
 * below are the conservative off-peak numbers, so a logged cost is a lower
 * bound rather than a guess.
 *
 * The token counts come from the provider's own `usage` payload:
 * `prompt_cache_hit_tokens`, `prompt_cache_miss_tokens` and
 * `completion_tokens`. The AI SDK exposes them as
 * `usage.raw.prompt_cache_hit_tokens` (and the derived
 * `usage.inputTokenDetails.cacheReadTokens` / `noCacheTokens`).
 */

/** USD per million tokens, off peak. */
export const DEEPSEEK_RATES = {
  /** Per million prompt tokens that hit the prefix cache. */
  cacheHit: 0.003,
  /** Per million prompt tokens that missed the prefix cache. */
  cacheMiss: 0.15,
  /** Per million completion tokens. */
  completion: 0.6,
} as const;

/** The three token counts of one request. */
export type TokenUsage = {
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
};

/** The cost of one request, in USD. */
export type CostBreakdown = {
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  cacheHitCost: number;
  cacheMissCost: number;
  completionCost: number;
  totalCost: number;
};

/**
 * Read the three token counts out of an AI SDK usage object.
 *
 * The provider's raw payload is preferred, because DeepSeek reports the
 * cache hit and the cache miss as SEPARATE numbers, and the derived
 * `noCacheTokens` is only `prompt_tokens - cacheReadTokens` - which is not
 * the same thing when the provider counts a partial prefix.
 */
export function readTokenUsage(usage: unknown): TokenUsage {
  const raw = (usage as { raw?: Record<string, unknown> } | undefined)?.raw;
  const details = (
    usage as
      | {
          inputTokenDetails?: {
            cacheReadTokens?: number;
            noCacheTokens?: number;
          };
          outputTokenDetails?: { textTokens?: number };
        }
      | undefined
  );

  const number = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;

  const cacheHitTokens = number(raw?.prompt_cache_hit_tokens);
  const cacheMissTokens = number(raw?.prompt_cache_miss_tokens);

  if (cacheHitTokens > 0 || cacheMissTokens > 0) {
    return {
      cacheHitTokens,
      cacheMissTokens,
      completionTokens:
        number(raw?.completion_tokens) ?? number(details?.outputTokenDetails?.textTokens),
    };
  }

  // Fallback for a provider that does not report the split.
  return {
    cacheHitTokens: number(details?.inputTokenDetails?.cacheReadTokens),
    cacheMissTokens: number(details?.inputTokenDetails?.noCacheTokens),
    completionTokens: number(details?.outputTokenDetails?.textTokens),
  };
}

/**
 * Price a request with the three-rate accounting.
 *
 * @param usage the token counts of the request
 */
export function computeCost(usage: TokenUsage): CostBreakdown {
  const cacheHitCost = (usage.cacheHitTokens / 1_000_000) * DEEPSEEK_RATES.cacheHit;
  const cacheMissCost = (usage.cacheMissTokens / 1_000_000) * DEEPSEEK_RATES.cacheMiss;
  const completionCost =
    (usage.completionTokens / 1_000_000) * DEEPSEEK_RATES.completion;

  return {
    ...usage,
    cacheHitCost,
    cacheMissCost,
    completionCost,
    totalCost: cacheHitCost + cacheMissCost + completionCost,
  };
}

/** A row of the `answer_log` table. */
export type AnswerLogRow = {
  question: string;
  intent: string;
  model: string;
  toolSteps: number;
  citations: number;
  confidence: string;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  firstTokenMs: number;
};

const INSERT_ANSWER_LOG_SQL = `
  INSERT INTO answer_log (
    question, intent, model, tool_steps, citations, confidence,
    cache_hit_tokens, cache_miss_tokens, completion_tokens,
    cost_usd, latency_ms, first_token_ms
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;

/**
 * Write one row to `answer_log`.
 *
 * Logging must never break the answer, so every failure is swallowed after
 * a warning.
 */
export async function logAnswer(row: AnswerLogRow): Promise<void> {
  try {
    const { query } = await import("@/lib/retrieval/db");
    await query(INSERT_ANSWER_LOG_SQL, [
      row.question.slice(0, 1000),
      row.intent.slice(0, 120),
      row.model.slice(0, 120),
      row.toolSteps,
      row.citations,
      row.confidence.slice(0, 40),
      row.cacheHitTokens,
      row.cacheMissTokens,
      row.completionTokens,
      row.costUsd,
      row.latencyMs,
      row.firstTokenMs,
    ]);
  } catch (error) {
    console.warn(
      "[ai] could not write the answer_log row:",
      (error as Error).message,
    );
  }
}
