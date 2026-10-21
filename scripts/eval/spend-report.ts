#!/usr/bin/env node
/**
 * Print the spend ledger: today's requests, the total cost, and the rows
 * that were written in the last hour.
 *
 *   npx tsx scripts/eval/spend-report.ts [minutes]
 *
 * NO LLM CALL. It only reads `answer_log`.
 */

import { loadEnv } from "./env.js";

loadEnv();

const { query, closePool } = await import("@/lib/retrieval/db.js");

const minutes = Number(process.argv[2] ?? 60);

const today = await query<{
  requests: number;
  cost: string;
  hit: string;
  miss: string;
  completion: string;
}>(`
  SELECT count(*)::int AS requests,
         coalesce(sum(cost_usd), 0)::text AS cost,
         coalesce(sum(cache_hit_tokens), 0)::text AS hit,
         coalesce(sum(cache_miss_tokens), 0)::text AS miss,
         coalesce(sum(completion_tokens), 0)::text AS completion
    FROM answer_log
   WHERE created_at >= date_trunc('day', now())`);

console.log("=== TODAY (server timezone) ===");
console.log(JSON.stringify(today.rows[0], null, 2));

const recent = await query<{
  created_at: Date;
  question: string;
  cost_usd: string;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  completion_tokens: number;
  confidence: string;
  citations: number;
  latency_ms: number;
}>(`
  SELECT created_at, left(question, 70) AS question, cost_usd,
         cache_hit_tokens, cache_miss_tokens, completion_tokens,
         confidence, citations, latency_ms
    FROM answer_log
   WHERE created_at >= now() - ($1 || ' minutes')::interval
   ORDER BY created_at DESC
   LIMIT 60`, [String(minutes)]);

console.log("");
console.log(`=== LAST ${minutes} MINUTES (${recent.rows.length} rows shown) ===`);
for (const row of recent.rows) {
  console.log(
    `${row.created_at.toISOString().slice(11, 19)}  $${Number(row.cost_usd).toFixed(6)}  ` +
      `h=${row.cache_hit_tokens} m=${row.cache_miss_tokens} c=${row.completion_tokens} ` +
      `cit=${row.citations} ${row.latency_ms}ms  ${row.question}`,
  );
}

const allTime = await query<{ requests: number; cost: string }>(`
  SELECT count(*)::int AS requests, coalesce(sum(cost_usd), 0)::text AS cost FROM answer_log`);
console.log("");
console.log(`=== ALL TIME === ${JSON.stringify(allTime.rows[0])}`);

await closePool();
process.exit(0);
