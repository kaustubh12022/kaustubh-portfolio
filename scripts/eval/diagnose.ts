#!/usr/bin/env node
/**
 * Retrieval diagnostics: is the retriever broken, or is it just hard?
 *
 *   npx tsx scripts/eval/diagnose.ts
 *
 * Runs a handful of hand written queries through the live retriever and
 * prints the top 5, so the behaviour can be eyeballed.
 */

import { loadEnv } from "./env.js";

loadEnv();

const { embedQuery } = await import("@/lib/retrieval/embed.js");
const { searchChunks } = await import("@/lib/retrieval/search.js");

const QUERIES: Array<{ q: string; project?: string; want: string }> = [
  { q: "calculate_deepseek_cost", project: "smartapply", want: "src/ai_engine.py" },
  { q: "is_relevant_jd", project: "smartapply", want: "src/scorer.py" },
  { q: "generate_pdf", project: "smartapply", want: "src/pdf_generator.py" },
  { q: "audit_resume_pdf", project: "smartapply", want: "ats_verifier.py" },
  { q: "createBooking", project: "pawna", want: "backend/controllers/bookingController.js" },
  { q: "tryParseQuickExpense", project: "personal-ai-os", want: "supabase/functions/chat/index.ts" },
  { q: "handleGeminiLiveRelay", project: "aura", want: "server/geminiLiveRelay.js" },
  { q: "How does SmartApply decide which job postings are worth sending to the LLM?", project: "smartapply", want: "src/scorer.py" },
  { q: "How does the Pawna booking controller work out the total price of a booking?", project: "pawna", want: "backend/controllers/bookingController.js" },
  { q: "How does SmartApply strip HR boilerplate out of a job description before it costs tokens?", project: "smartapply", want: "src/scorer.py" },
  { q: "Where is the job relevance filter for SmartApply implemented?", project: "smartapply", want: "src/scorer.py" },
  { q: "How does Aura handle the caller interrupting the voice agent mid-sentence?", project: "aura", want: "src/audio/audioPlayer.js" },
];

for (const item of QUERIES) {
  const embedding = await embedQuery(item.q);
  const hits = await searchChunks(
    { query: item.q, projectId: item.project, limit: 5 },
    embedding,
  );
  const top = hits[0];
  const rank = hits.findIndex((hit) => hit.path === item.want) + 1;
  console.log("");
  console.log(`Q: ${item.q}`);
  console.log(`   want ${item.want} -> rank ${rank === 0 ? "NOT IN TOP 5" : rank}`);
  for (const [index, hit] of hits.entries()) {
    console.log(
      `   ${index + 1}. ${hit.path}:${hit.startLine}-${hit.endLine}` +
        `${hit.symbol ? ` (${hit.symbol})` : ""} score=${hit.score.toFixed(5)}` +
        ` v=${hit.vectorRank ?? "-"} k=${hit.keywordRank ?? "-"}`,
    );
  }
  void top;
}

process.exit(0);
