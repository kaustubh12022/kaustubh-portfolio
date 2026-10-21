import "server-only";

/**
 * A tiny in-memory rate limiter.
 *
 * THIS IS PER INSTANCE. It is a courtesy limit, not a security boundary:
 * the state lives in the Node process, so it resets on every deploy and it
 * is not shared between instances. On a serverless platform each cold start
 * gets a fresh budget and a warm instance keeps one.
 *
 * The production version is Upstash Redis (the REST API is already in
 * `.env.example` as `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`),
 * which gives a shared, atomic, TTL-based counter across every instance.
 * The interface below is deliberately the shape such a backend would need:
 * `check(key)` returns whether the request may proceed and how long the
 * caller has to wait.
 */

/** How many requests one client may make inside the window. */
export const RATE_LIMIT_MAX = 10;

/** Rate limit ceiling for the MCP endpoint (60 requests per 5 minutes). */
export const MCP_RATE_LIMIT_MAX = 60;

/** The window, in milliseconds. */
export const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

type Bucket = {
  count: number;
  resetAt: number;
};

const buckets = new Map<string, Bucket>();

/** The outcome of a rate limit check. */
export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfterSeconds: number;
};

/**
 * Consume one unit of the budget for `key`.
 *
 * @param key a stable identifier for the client (normally the IP)
 * @param max the maximum requests allowed in the window (defaults to RATE_LIMIT_MAX)
 * @param windowMs the window duration in milliseconds (defaults to RATE_LIMIT_WINDOW_MS)
 */
export function checkRateLimit(
  key: string,
  max: number = RATE_LIMIT_MAX,
  windowMs: number = RATE_LIMIT_WINDOW_MS,
): RateLimitResult {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return {
      allowed: true,
      remaining: max - 1,
      retryAfterSeconds: Math.ceil(windowMs / 1000),
    };
  }

  if (existing.count >= max) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  existing.count += 1;
  return {
    allowed: true,
    remaining: max - existing.count,
    retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
  };
}

/**
 * Drop the buckets that have expired.
 *
 * Without this the map grows with every unique IP for the lifetime of the
 * process. It is called on a timer from the route module.
 */
export function pruneRateLimitBuckets(): void {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * The client key for a request.
 *
 * The first `x-forwarded-for` entry is the original client when the app runs
 * behind a proxy. It is only used as a bucket key - never logged, never
 * stored.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return (
    request.headers.get("x-real-ip") ??
    request.headers.get("cf-connecting-ip") ??
    "unknown"
  );
}
