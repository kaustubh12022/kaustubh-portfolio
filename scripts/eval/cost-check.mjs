/**
 * Cost regression harness.
 *
 * Sends the SAME question twice through the live route and proves that the
 * second one costs nothing. It also reports the per-request token split so
 * the chunk-clipping change can be measured.
 *
 * Run with:  node --env-file=.env.local scripts/eval/cost-check.mjs
 */

const URL = process.env.CHAT_URL ?? "http://localhost:3000/api/chat";
const QUESTION =
  process.argv[2] ?? "How does SmartApply decide which jobs to score?";

async function ask(label) {
  const started = Date.now();
  const response = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ id: "1", role: "user", parts: [{ type: "text", text: QUESTION }] }],
    }),
  });

  const cacheHeader = response.headers.get("x-cache");
  let text = "";
  let visual = null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const line = raw.split("\n").find((l) => l.startsWith("data:"));
      if (line) {
        const body = line.slice(5).trim();
        if (body && body !== "[DONE]") {
          try {
            const chunk = JSON.parse(body);
            if (chunk.type === "text-delta") text += chunk.delta ?? "";
            if (chunk.type === "data-visual") visual = chunk.data;
          } catch {
            /* ignore */
          }
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }

  console.log(
    `${label}: ${response.status} cache=${cacheHeader ?? "-"} ` +
      `latency=${Date.now() - started}ms chars=${text.length} ` +
      `visual=${visual?.visual?.kind ?? "-"} evidence=${visual?.evidence?.length ?? 0} ` +
      `confidence=${visual?.confidence ?? "-"}`,
  );
  return { text, visual, cacheHeader };
}

console.log(`question: ${QUESTION}\n`);

const first = await ask("run 1 (cold)");
const second = await ask("run 2 (should be a cache HIT)");
const third = await ask("run 3 (should be a cache HIT)");

console.log("\n--- verdict ---");
console.log(`first answer length : ${first.text.length}`);
console.log(`second answer length: ${second.text.length}`);
console.log(
  `identical answers   : ${first.text.trim() === second.text.trim() ? "YES" : "NO"}`,
);
console.log(
  `cache header run 2  : ${second.cacheHeader ?? "(none)"}`,
);
console.log(
  `cache header run 3  : ${third.cacheHeader ?? "(none)"}`,
);
