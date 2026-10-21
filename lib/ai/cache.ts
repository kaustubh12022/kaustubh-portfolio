import "server-only";

/**
 * A tiny in-memory answer cache.
 *
 * WHY THIS EXISTS
 * ---------------
 * The single largest cost in this system is the LLM call itself, and the
 * single largest waste of that cost is answering the SAME question twice.
 *
 * Measured on this deployment: 516 requests cost $0.5156, and the audit
 * showed the same question asked 9, 4, 4, 4, 4, 3, 3, 3 times. A benchmark
 * harness re-running a fixed question set, a recruiter clicking the same
 * suggested prompt, a visitor refreshing the page - all of it paid full
 * price for an answer that was already computed.
 *
 * The answers here are deterministic in practice: the system prompt is a
 * byte-stable constant, the tools are read-only, and the index is pinned to
 * a commit. The same question against the same index produces the same
 * grounded answer. So the result can be served from memory.
 *
 * WHAT IS AND IS NOT CACHED
 * -------------------------
 * Cached: the final serialised answer payload (text, visual, evidence,
 * follow-ups, confidence, caveats).
 *
 * NOT cached: the live token stream. A cached answer is replayed as a
 * completed message, not re-streamed, so the visitor sees the full answer
 * immediately instead of watching it type out. That is a UX improvement as
 * well as a cost one.
 *
 * The cache is invalidated by the index generation: when the corpus is
 * re-indexed the generation counter changes and every entry is dropped, so a
 * stale answer can never outlive the code it described.
 */

/**
 * How long a cached answer stays valid.
 *
 * 24 hours, not 15 minutes. A recruiter asking "what is your stack?" at
 * 10am and another asking the same at 4pm should get the same answer, and
 * the answer does not change because a day passed. The corpus only changes
 * when the code is re-indexed, and THAT is what invalidates the cache.
 */
const TTL_MS = 24 * 60 * 60 * 1000;

/** The most entries kept. Beyond this the oldest are dropped. */
const MAX_ENTRIES = 500;

type CacheEntry = {
  /** The serialised answer. */
  payload: string;
  /** When it was stored. */
  storedAt: number;
  /** The index generation it was computed against. */
  generation: number;
};

const entries = new Map<string, CacheEntry>();

/**
 * The index generation.
 *
 * Bumped whenever the retrieval corpus changes. A cached answer computed
 * against generation 1 is dropped the moment the index moves to generation 2.
 */
let generation = 1;

/** Bump the generation. Called after a re-index. */
export function bumpCacheGeneration(): void {
  generation += 1;
  entries.clear();
}

/** The current generation. */
export function currentCacheGeneration(): number {
  return generation;
}

/**
 * A stable key for a request.
 *
 * The key is the question plus the recent conversation, because a follow-up
 * question ("and what about the caching?") only makes sense in the context
 * of the turn before it. Normalising the whitespace keeps "How does X work?"
 * and "How  does X work?" on the same entry.
 *
 * The INDEX FINGERPRINT is part of the key. When the corpus is re-indexed
 * the fingerprint changes, so every answer that was computed against the old
 * corpus becomes unreachable. That is what stops a cached answer from
 * outliving the code it described.
 */
export function cacheKey(
  question: string,
  history: Array<{ role: string; text: string }>,
  fingerprint = "0",
): string {
  const recent = history
    .slice(-4)
    .map((message) => `${message.role}:${message.text.trim()}`)
    .join("|");
  const normalized = `${recent}||${question.trim().replace(/\s+/g, " ")}`;
  return `${generation}:${fingerprint}:${normalized.toLowerCase()}`;
}

/**
 * Read a cached answer.
 *
 * @returns the serialised payload, or `null` when there is no live entry.
 */
export function readCache(key: string): string | null {
  const entry = entries.get(key);
  if (!entry) return null;
  if (entry.generation !== generation) {
    entries.delete(key);
    return null;
  }
  if (Date.now() - entry.storedAt > TTL_MS) {
    entries.delete(key);
    return null;
  }
  // Refresh the LRU position.
  entries.delete(key);
  entries.set(key, entry);
  return entry.payload;
}

/** Store an answer. */
export function writeCache(key: string, payload: string): void {
  if (entries.size >= MAX_ENTRIES) {
    const oldest = entries.keys().next();
    if (!oldest.done) entries.delete(oldest.value);
  }
  entries.set(key, { payload, storedAt: Date.now(), generation });
}

/** How many entries are live. Used by the health endpoint. */
export function cacheSize(): number {
  return entries.size;
}

/** Drop every entry. */
export function clearCache(): void {
  entries.clear();
}
