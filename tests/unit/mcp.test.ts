import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";

/**
 * The MCP unit tests.
 *
 * They are FAST and LLM-FREE: no model is called, no embedding model is
 * loaded and the database is never touched. The `server-only` marker is
 * mocked out so the content layer and the website tool set can be imported
 * in a plain Node test environment.
 */
vi.mock("server-only", () => ({}));

const { TOOL_NAMES } = await import("@/lib/ai/tools");
const { MCP_TOOL_NAMES, MCP_TOOLS, pathLooksUnsafe } = await import(
  "@/lib/mcp/tools"
);
const {
  ARCHITECTURE_APP_PROJECT_ID,
  architectureResourceUri,
  buildArchitectureHtml,
  listArchitectureProjectIds,
} = await import("@/lib/mcp/apps");
const { createMcpServer, MCP_SERVER_NAME } = await import("@/lib/mcp/server");
const { POST, OPTIONS, GET } = await import("@/app/mcp/route");

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Connect a real client to a real server over an in-memory transport. */
async function connect(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  await server.connect(serverTransport);
  const client = new Client({ name: "mcp-unit-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

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

/* ------------------------------------------------------------------ */
/* The tool set                                                        */
/* ------------------------------------------------------------------ */

describe("the MCP tool set", () => {
  it("registers every tool with a non-empty description", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name).sort();

      expect(names).toEqual([...MCP_TOOL_NAMES].sort());

      for (const tool of tools) {
        expect(tool.description ?? "", tool.name).not.toBe("");
        expect((tool.description ?? "").length, tool.name).toBeGreaterThan(40);
      }
    } finally {
      await close();
    }
  });

  it("marks every tool read-only", async () => {
    const { client, close } = await connect();
    try {
      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
        expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      }
    } finally {
      await close();
    }
  });

  it("is a SUBSET of the website tool set and names the difference", () => {
    const mcpNames = new Set(MCP_TOOL_NAMES);
    const websiteNames = new Set<string>(TOOL_NAMES);

    const notOnTheWebsite = MCP_TOOL_NAMES.filter((name) => !websiteNames.has(name));
    const missingFromMcp = TOOL_NAMES.filter((name) => !mcpNames.has(name));

    console.log(
      [
        "",
        "MCP tool set vs the website tool set",
        `  website tools : ${TOOL_NAMES.join(", ")}`,
        `  MCP tools     : ${MCP_TOOL_NAMES.join(", ")}`,
        `  exposed only on the website (not on MCP): ${
          missingFromMcp.join(", ") || "(none)"
        }`,
        `  exposed only on MCP (not on the website): ${
          notOnTheWebsite.join(", ") || "(none)"
        }`,
        "",
      ].join("\n"),
    );

    expect(notOnTheWebsite).toEqual([]);
    expect(MCP_TOOL_NAMES.length).toBeLessThanOrEqual(TOOL_NAMES.length);
    // The website-only tools are `render_visual` (declares which card the
    // chat UI draws) and `get_data_model`.
    expect(missingFromMcp.sort()).toEqual(["get_data_model", "render_visual"]);
  });

  it("gives every tool a non-empty description in the source of truth", () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.description.length, tool.name).toBeGreaterThan(40);
      expect(tool.inputSchema, tool.name).toBeTruthy();
      expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Path safety                                                         */
/* ------------------------------------------------------------------ */

describe("read_file path safety", () => {
  const unsafe = [
    ["parent directory", "../../../etc/passwd"],
    ["absolute posix path", "/etc/passwd"],
    ["absolute windows path", "C:\\Windows\\system32\\config\\sam"],
    ["backslash separator", "src\\..\\..\\secrets.txt"],
    ["embedded traversal", "src/../../secrets.txt"],
    ["NUL byte", "src/ai_engine.py\u0000.txt"],
  ] as const;

  it("rejects every unsafe path shape", () => {
    for (const [label, path] of unsafe) {
      expect(pathLooksUnsafe(path), label).toBe(true);
    }
  });

  it("accepts a repo-relative index path", () => {
    expect(pathLooksUnsafe("src/ai_engine.py")).toBe(false);
    expect(pathLooksUnsafe("backend/app/main.py")).toBe(false);
    expect(pathLooksUnsafe("a-b_c/d.e/f.py")).toBe(false);
  });

  it("refuses an unsafe path BEFORE any index lookup", async () => {
    const tool = MCP_TOOLS.find((item) => item.name === "read_file");
    expect(tool).toBeTruthy();

    for (const [label, path] of unsafe) {
      const result = await tool!.run({
        projectId: "smartapply",
        path,
      });
      const text = resultText(result);
      expect(text, label).toContain("refused");
      expect(text, label).not.toContain("does not exist in the index");
    }
  });
});

/* ------------------------------------------------------------------ */
/* The MCP App                                                         */
/* ------------------------------------------------------------------ */

describe("the ui:// MCP App resource", () => {
  it("builds a non-empty page for the published project", () => {
    const html = buildArchitectureHtml(ARCHITECTURE_APP_PROJECT_ID);
    expect(html).toBeTruthy();
    expect(html!.length).toBeGreaterThan(500);
    expect(html).toContain(ARCHITECTURE_APP_PROJECT_ID);
    expect(html).toContain("smartapply");
  });

  it("references nothing off-origin", () => {
    const html = buildArchitectureHtml(ARCHITECTURE_APP_PROJECT_ID) ?? "";
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toMatch(/\/\/cdn/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
  });

  it("uses the ui:// scheme with the project id in the URI", () => {
    expect(architectureResourceUri("smartapply")).toBe(
      "ui://portfolio/architecture/smartapply",
    );
    expect(listArchitectureProjectIds()).toContain(
      ARCHITECTURE_APP_PROJECT_ID,
    );
  });

  it("is registered as a resource a client can read", async () => {
    const { client, close } = await connect();
    try {
      const { resources } = await client.listResources();
      const uris = resources.map((resource) => resource.uri);
      expect(uris).toContain(
        architectureResourceUri(ARCHITECTURE_APP_PROJECT_ID),
      );

      const read = await client.readResource({
        uri: architectureResourceUri(ARCHITECTURE_APP_PROJECT_ID),
      });
      const text = (read.contents[0] as { text?: string } | undefined)?.text ?? "";
      expect(text.length).toBeGreaterThan(500);
      expect(text).toContain(ARCHITECTURE_APP_PROJECT_ID);
      expect(text).not.toMatch(/https?:\/\//i);
    } finally {
      await close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* The server surface                                                  */
/* ------------------------------------------------------------------ */

describe("the MCP server surface", () => {
  it("exposes the knowledge base as resources", async () => {
    const { client, close } = await connect();
    try {
      const { resources } = await client.listResources();
      const uris = resources.map((resource) => resource.uri);
      expect(uris).toContain("portfolio://profile");
      expect(uris).toContain("portfolio://claims");
      expect(uris).toContain("portfolio://metrics");
      expect(uris.some((uri) => uri.startsWith("portfolio://project/"))).toBe(
        true,
      );
    } finally {
      await close();
    }
  });

  it("exposes at least one prompt template", async () => {
    const { client, close } = await connect();
    try {
      const { prompts } = await client.listPrompts();
      const names = prompts.map((prompt) => prompt.name);
      expect(names).toContain("explain_project_to_hiring_manager");

      const prompt = await client.getPrompt({
        name: "explain_project_to_hiring_manager",
        arguments: { projectId: "smartapply" },
      });
      expect(prompt.messages.length).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it("answers a content-only tool without touching the database", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: "get_claim",
        arguments: { id: "java-spring" },
      });
      const text = resultText(result);
      expect(text).toContain("CONTRADICTED");
      expect(text).toContain("APPROVED PUBLIC WORDING");
    } finally {
      await close();
    }
  });

  it("reports its server name", async () => {
    const { client, close } = await connect();
    try {
      expect(client.getServerVersion()?.name).toBe(MCP_SERVER_NAME);
    } finally {
      await close();
    }
  });
});

/* ------------------------------------------------------------------ */
/* The HTTP transport                                                  */
/* ------------------------------------------------------------------ */

describe("the /mcp route", () => {
  const URL = "http://localhost:3000/mcp";

  function post(
    body: unknown,
    headers: Record<string, string> = {},
  ): Request {
    return new Request(URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  it("answers the CORS preflight", async () => {
    const response = await OPTIONS();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain(
      "POST",
    );
    expect(response.headers.get("access-control-allow-headers")).toContain(
      "mcp-method",
    );
  });

  it("refuses GET, because the GET stream was removed in 2026-07-28", async () => {
    const response = await GET();
    expect(response.status).toBe(405);
  });

  it("routes on the Mcp-Method header and answers with a JSON body", async () => {
    const response = await POST(
      post(
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/list",
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("mcp-protocol-version")).toBe("2026-07-28");

    const body = (await response.json()) as {
      result: { tools: unknown[]; ttlMs: number; cacheScope: string };
    };
    expect(body.result.tools.length).toBe(MCP_TOOL_NAMES.length);
    // SEP-2549: the list result is cacheable.
    expect(body.result.ttlMs).toBeGreaterThan(0);
    expect(body.result.cacheScope).toBe("public");
  });

  it("falls back to the body when the headers are missing", async () => {
    const response = await POST(
      post({ jsonrpc: "2.0", id: 2, method: "prompts/list", params: {} }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: { prompts: unknown[] } };
    expect(body.result.prompts.length).toBeGreaterThan(0);
  });

  it("refuses a header that disagrees with the body (-32020)", async () => {
    const response = await POST(
      post(
        { jsonrpc: "2.0", id: 3, method: "prompts/list", params: {} },
        { "mcp-method": "tools/list" },
      ),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: number; message: string };
    };
    expect(body.error.code).toBe(-32020);
    expect(body.error.message).toContain("Mcp-Method");
  });

  it("refuses an unsupported protocol version (-32022)", async () => {
    const response = await POST(
      post(
        { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
        { "mcp-protocol-version": "1999-01-01" },
      ),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error: { code: number; data: { supported: string[] } };
    };
    expect(body.error.code).toBe(-32022);
    expect(body.error.data.supported).toContain("2026-07-28");
  });

  it("answers `initialize`, which the 2026 revision made optional", async () => {
    const response = await POST(
      post({ jsonrpc: "2.0", id: 5, method: "initialize", params: {} }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } };
    };
    expect(body.result.protocolVersion).toBe("2026-07-28");
    expect(body.result.serverInfo.name).toBe(MCP_SERVER_NAME);
  });

  it("answers `ping`", async () => {
    const response = await POST(
      post(
        { jsonrpc: "2.0", id: 6, method: "ping", params: {} },
        { "mcp-method": "ping" },
      ),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: Record<string, unknown> };
    expect(body.result.resultType).toBe("complete");
  });

  it("refuses a malformed body with a parse error", async () => {
    const request = new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
  });

  it("enforces bearer auth when MCP_AUTH_TOKEN is configured", async () => {
    const originalToken = process.env.MCP_AUTH_TOKEN;
    try {
      process.env.MCP_AUTH_TOKEN = "secret-test-token-123";

      // 1. Missing Authorization header -> 401
      const noAuthResponse = await POST(
        post({ jsonrpc: "2.0", id: 7, method: "ping", params: {} }),
      );
      expect(noAuthResponse.status).toBe(401);

      // 2. Wrong Authorization bearer -> 401
      const wrongAuthResponse = await POST(
        post(
          { jsonrpc: "2.0", id: 8, method: "ping", params: {} },
          { authorization: "Bearer wrong-token" },
        ),
      );
      expect(wrongAuthResponse.status).toBe(401);

      // 3. Correct Authorization bearer -> 200
      const correctAuthResponse = await POST(
        post(
          { jsonrpc: "2.0", id: 9, method: "ping", params: {} },
          { authorization: "Bearer secret-test-token-123" },
        ),
      );
      expect(correctAuthResponse.status).toBe(200);
    } finally {
      if (originalToken !== undefined) {
        process.env.MCP_AUTH_TOKEN = originalToken;
      } else {
        delete process.env.MCP_AUTH_TOKEN;
      }
    }
  });

  it("enforces per-IP rate limiting (429 on request 61 within window)", async () => {
    const testIp = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    let rateLimited = false;

    for (let i = 0; i < 61; i++) {
      const response = await POST(
        post(
          { jsonrpc: "2.0", id: 100 + i, method: "ping", params: {} },
          { "x-forwarded-for": testIp, "mcp-method": "ping" },
        ),
      );
      if (response.status === 429) {
        rateLimited = true;
        const body = (await response.json()) as {
          error: { code: number; message: string };
        };
        expect(body.error.message).toContain("rate limit exceeded");
        expect(response.headers.get("retry-after")).toBeDefined();
        break;
      }
    }
    expect(rateLimited).toBe(true);
  });
});
