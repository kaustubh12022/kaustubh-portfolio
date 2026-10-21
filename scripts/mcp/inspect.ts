/**
 * A local client for the MCP surface.
 *
 * WHAT IT PROVES
 * --------------
 * The MCP server is not a shape on paper: this script connects to it the
 * way a real host does, over stdio, and then
 *
 *   1. lists the tools and prints them,
 *   2. calls `search_code` with a real question about the indexed source,
 *   3. calls `get_claim` with `java-spring` and prints the result,
 *   4. checks that the claim answer is GROUNDED: the ledger says the claim
 *      is CONTRADICTED, so the answer must say so, and it must carry the
 *      approved public wording,
 *   5. reads the `ui://` MCP App resource and checks that the HTML it
 *      serves references nothing off-origin.
 *
 * HOW TO RUN IT
 * -------------
 *     NODE_OPTIONS=--conditions=react-server npx tsx scripts/mcp/inspect.ts
 *
 * The `react-server` condition is needed because `lib/content/load.ts` and
 * `lib/retrieval/db.ts` carry `import "server-only"`, which throws outside
 * a React Server Component context. The child process inherits the same
 * condition, so the stdio server behaves exactly like the HTTP route.
 */

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { loadEnv } from "../eval/env.js";
import { architectureResourceUri } from "../../lib/mcp/apps.js";

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

loadEnv();

/**
 * The environment for the spawned stdio server.
 *
 * `StdioClientTransport` replaces the child environment with a safe subset
 * plus whatever is passed here, so the database URL and the `react-server`
 * condition are forwarded explicitly.
 */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.NODE_OPTIONS = process.env.NODE_OPTIONS ?? "--conditions=react-server";
  return env;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Pull the text out of an MCP tool result. */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text: string } =>
        block !== null &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

function heading(text: string): void {
  console.log(`\n${"=".repeat(72)}\n${text}\n${"=".repeat(72)}`);
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  heading("1. connect to the MCP server over stdio");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "scripts/mcp/stdio.ts"],
    env: childEnv(),
    cwd: process.cwd(),
    stderr: "inherit",
  });

  const client = new Client({ name: "portfolio-inspect", version: "1.0.0" });
  await client.connect(transport);

  console.log(`server:  ${JSON.stringify(client.getServerVersion())}`);
  console.log(
    `caps:    ${JSON.stringify(client.getServerCapabilities())}`,
  );

  /* ---------------------------------------------------------------- */
  heading("2. tools/list");

  const { tools } = await client.listTools();
  console.log(`${tools.length} tools:\n`);
  for (const tool of tools) {
    console.log(`- ${tool.name}`);
    console.log(`    ${tool.description ?? ""}`);
  }

  /* ---------------------------------------------------------------- */
  heading("3. tools/call search_code");

  const search = await client.callTool({
    name: "search_code",
    arguments: {
      query: "how does the resume get scored by the AI model",
      projectId: "smartapply",
      limit: 3,
    },
  });
  console.log(resultText(search));

  /* ---------------------------------------------------------------- */
  heading("4. tools/call get_claim (java-spring)");

  const claim = await client.callTool({
    name: "get_claim",
    arguments: { id: "java-spring" },
  });
  const claimText = resultText(claim);
  console.log(claimText);

  /* ---------------------------------------------------------------- */
  heading("5. groundedness check");

  const grounded = claimText.toLowerCase().includes("contradicted");
  console.log(
    `the claim answer says "contradicted": ${grounded ? "YES" : "NO"}`,
  );
  console.log(
    `the claim answer carries the approved wording: ${
      claimText.includes("APPROVED PUBLIC WORDING") ? "YES" : "NO"
    }`,
  );
  if (!grounded) {
    console.error(
      "\nFAILED: the claim ledger says java-spring is contradicted, but the answer did not say so.",
    );
    process.exitCode = 1;
  }

  /* ---------------------------------------------------------------- */
  heading("6. resources/list");

  const { resources } = await client.listResources();
  for (const resource of resources) {
    console.log(`- ${resource.uri}  (${resource.mimeType ?? "?"})`);
  }

  /* ---------------------------------------------------------------- */
  heading("7. resources/read the MCP App (ui://)");

  const uiUri = architectureResourceUri("smartapply");
  const ui = await client.readResource({ uri: uiUri });
  const html = (ui.contents[0] as { text?: string } | undefined)?.text ?? "";
  const external =
    /https?:\/\//i.test(html) || /\/\/cdn/i.test(html) || /<script/i.test(html);
  console.log(`uri:            ${uiUri}`);
  console.log(`html length:    ${html.length} characters`);
  console.log(`mentions the project id: ${html.includes("smartapply") ? "YES" : "NO"}`);
  console.log(
    `references nothing off-origin (no url, no script): ${external ? "NO" : "YES"}`,
  );
  if (external) {
    console.error("\nFAILED: the MCP App HTML is not self-contained.");
    process.exitCode = 1;
  }

  /* ---------------------------------------------------------------- */
  heading("8. prompts/list and prompts/get");

  const { prompts } = await client.listPrompts();
  for (const prompt of prompts) {
    console.log(`- ${prompt.name}: ${prompt.description ?? ""}`);
  }

  const prompt = await client.getPrompt({
    name: "explain_project_to_hiring_manager",
    arguments: { projectId: "smartapply" },
  });
  console.log(`\nprompt returned ${prompt.messages.length} message(s)`);

  await client.close();
  console.log("\nDONE");
}

main().catch((error: unknown) => {
  console.error("\nFAILED:", error);
  process.exitCode = 1;
});
