import { loadEnv } from "./env.js";

loadEnv();

const { closePool } = await import("@/lib/retrieval/db.js");
const { embedQuery } = await import("@/lib/retrieval/embed.js");
const { searchChunks } = await import("@/lib/retrieval/search.js");
const { readGoldenSet, scorableQuestions } = await import("@/lib/eval/golden.js");

const questions = scorableQuestions(readGoldenSet()).slice(0, 3);

for (const question of questions) {
  const embedding = await embedQuery(question.question);
  const hits = await searchChunks(
    { query: question.question, projectId: question.project, limit: 80, candidates: 40 },
    embedding,
  );
  console.log(question.id, "hits:", hits.length);
  console.log("  expected:", JSON.stringify(question.expect.evidence));
  console.log("  top3:", hits.slice(0, 3).map((h) => `${h.path}:${h.startLine}-${h.endLine} v=${h.vectorRank} k=${h.keywordRank}`));
  const withVector = hits.filter((h) => h.vectorRank !== null);
  const withKeyword = hits.filter((h) => h.keywordRank !== null);
  console.log("  withVector:", withVector.length, "withKeyword:", withKeyword.length);
  const expected = question.expect.evidence[0];
  const hit = hits.find((h) => h.path === expected.path);
  console.log("  expected path present in hits?", Boolean(hit), hit ? `${hit.startLine}-${hit.endLine}` : "");
}

await closePool();
process.exit(0);
