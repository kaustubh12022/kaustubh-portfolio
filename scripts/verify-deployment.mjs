#!/usr/bin/env node
/**
 * THE DEPLOYMENT SMOKE TEST
 *
 *   node scripts/verify-deployment.mjs [url]
 *
 * A local build passing is NOT a deployment working. Five times during this
 * project the build was green and the live site was broken, because the
 * serverless bundle was missing something the build did not care about.
 *
 * This script checks the LIVE deployment, over HTTP, the way a visitor sees
 * it. It is the gate between "it compiles" and "it is live".
 *
 * WHAT IT CHECKS
 *   1. the home page renders and is a real page, not an error
 *   2. /api/health reports every retrieval layer green
 *   3. the chat endpoint streams a real answer
 *   4. /mcp refuses an unauthenticated request
 *   5. /projects and a project page return 200
 *   6. llms.txt, robots.txt and sitemap.xml are served
 *
 * NO LLM SPEND. Step 3 makes exactly ONE chat request. Step 4 makes one
 * request that is expected to be rejected before it reaches the model.
 */

const BASE = (process.argv[2] ?? "https://kaustubh-portfolio-navy.vercel.app").replace(
  /\/$/,
  "",
);

const results = [];

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`${mark.padEnd(5)} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function get(path, init) {
  const response = await fetch(`${BASE}${path}`, init);
  const text = await response.text();
  return { status: response.status, text, headers: response.headers };
}

/* 1. the home page -------------------------------------------------- */
{
  const { status, text } = await get("/");
  const looksReal =
    status === 200 &&
    text.includes("Kaustubh") &&
    text.includes("textarea");
  record(
    "home page renders",
    looksReal,
    `status ${status}, ${text.length} bytes`,
  );
}

/* 2. the health endpoint -------------------------------------------- */
{
  const { status, text } = await get("/api/health");
  let health = null;
  try {
    health = JSON.parse(text);
  } catch {
    /* handled below */
  }
  if (!health) {
    record("health endpoint", false, `status ${status}, unparseable body`);
  } else {
    const r = health.retrieval ?? {};
    record(
      "health: embedding layer",
      r.embedding?.ok === true,
      r.embedding?.detail ?? "missing",
    );
    record(
      "health: database layer",
      r.database?.ok === true,
      r.database?.detail ?? "missing",
    );
    record(
      "health: search layer",
      r.search?.ok === true,
      r.search?.detail ?? "missing",
    );
    record(
      "health: reranker layer",
      r.reranker?.ok === true,
      r.reranker?.detail ?? "missing",
    );
    record(
      "health: overall ok",
      health.ok === true,
      `chunks=${health.chunks} projects=${health.projects}`,
    );
  }
}

/* 3. the chat endpoint streams a real answer ------------------------- */
{
  const body = JSON.stringify({
    messages: [
      {
        role: "user",
        text: "In one sentence, what is this portfolio and what does it do?",
      },
    ],
  });
  try {
    const { status, text } = await get("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const streamed = text.includes("text-delta");
    const hasText = text.includes('"delta"');
    record(
      "chat streams an answer",
      status === 200 && streamed && hasText,
      `status ${status}, ${text.length} bytes of SSE`,
    );
  } catch (error) {
    record("chat streams an answer", false, String(error));
  }
}

/* 4. /mcp refuses an unauthenticated request -------------------------- */
{
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1" },
    },
  });
  const { status } = await get("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  record(
    "/mcp refuses unauthenticated requests",
    status === 401,
    `status ${status} (expected 401)`,
  );
}

/* 5. the static pages ------------------------------------------------ */
for (const path of ["/projects", "/projects/smartapply"]) {
  const { status } = await get(path);
  record(`${path} returns 200`, status === 200, `status ${status}`);
}

/* 6. the crawler surface ---------------------------------------------- */
for (const path of ["/llms.txt", "/robots.txt", "/sitemap.xml"]) {
  const { status } = await get(path);
  record(`${path} returns 200`, status === 200, `status ${status}`);
}

/* ------------------------------------------------------------------ */

const failed = results.filter((result) => !result.ok);
console.log("");
console.log(
  `${results.length - failed.length}/${results.length} checks passed on ${BASE}`,
);
if (failed.length > 0) {
  console.log("");
  console.log("FAILED:");
  for (const result of failed) {
    console.log(`  - ${result.name}: ${result.detail}`);
  }
  process.exit(1);
}
process.exit(0);
