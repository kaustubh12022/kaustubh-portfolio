/**
 * The MCP server factory.
 *
 * WHAT THIS IS
 * ------------
 * One factory that builds a fresh `McpServer` per serving unit: once per
 * HTTP request behind `createMcpHandler`, once per stdio connection behind
 * `serveStdio`. The factory holds NOTHING between requests, which is what
 * makes the endpoint stateless - the property the 2026-07-28 revision of the
 * protocol is built around.
 *
 * WHAT IT SERVES
 * --------------
 *   - the ten read-only tools of `lib/mcp/tools.ts`, each one a thin adapter
 *     over the matching website tool;
 *   - the knowledge base as MCP RESOURCES: one resource per project summary,
 *     plus the claim ledger, the profile and the verified metrics;
 *   - one PROMPT template ("explain this project to a hiring manager");
 *   - the MCP APP of `lib/mcp/apps.ts`: the `ui://` architecture pages.
 *
 * CACHEABILITY (SEP-2549)
 * -----------------------
 * `tools/list`, `prompts/list`, `resources/list` and `resources/read` carry
 * `ttlMs` and `cacheScope` on the 2026-07-28 revision. The tool catalogue
 * and the project summaries are static content, so they are cacheable by a
 * SHARED cache for a long time; the reads are cacheable for a shorter
 * window because they can be invalidated by a re-index.
 *
 * The tools themselves are NEVER cached: every tool result is computed from
 * the live index.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import {
  getClaims,
  getMetrics,
  getProfile,
  getProject,
  getProjects,
} from "@/lib/content/load";
import { registerArchitectureApp } from "@/lib/mcp/apps";
import {
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  formatValue,
  MCP_PROTOCOL_VERSION,
} from "@/lib/mcp/tools";

/** The name this server reports in `serverInfo`. */
export const MCP_SERVER_NAME = "kaustubh-portfolio";

/** The version this server reports in `serverInfo`. */
export const MCP_SERVER_VERSION = "1.0.0";

/** The usage guide a host puts in the model's system prompt. */
export const MCP_INSTRUCTIONS = [
  "A grounded knowledge server for the portfolio of Kaustubh Kale (graduate engineer, B.E. Information Technology, 2026).",
  "",
  "It answers questions about his projects from two audited sources:",
  "  - the SOURCE INDEX: 2,864 line-exact chunks from six real GitHub repositories, searchable with search_code, read with read_file and find_symbol;",
  "  - the CLAIM LEDGER: every number, employer and capability with a status (verified | partial | unverified | contradicted) and an APPROVED public wording.",
  "",
  "Rules that keep the answers honest:",
  "  - quote a claim's publicWording verbatim; never paraphrase it;",
  "  - a CONTRADICTED claim must not be repeated - use the approved wording instead;",
  "  - cite the source: projectId, path and line range;",
  "  - when a tool says something was not captured, say that instead of describing it from memory.",
].join("\n");

/** The `portfolio://` scheme for the knowledge-base resources. */
export const PORTFOLIO_SCHEME = "portfolio";

/* ------------------------------------------------------------------ */
/* Resource renderers                                                  */
/* ------------------------------------------------------------------ */

function renderProfileResource(): string {
  const profile = getProfile();
  return [
    `# ${profile.name}`,
    "",
    profile.headline,
    "",
    formatValue(
      {
        location: profile.location,
        email: profile.email,
        links: profile.links,
        availability: profile.availability,
        summary: profile.summary,
        education: profile.education,
        experience: profile.experience,
        skills: profile.skills,
        languages: profile.languages,
      },
      0,
    ),
  ].join("\n");
}

function renderProjectResource(id: string): string | null {
  const project = getProject(id);
  if (!project) return null;
  return [
    `# ${project.name}`,
    "",
    project.tagline,
    "",
    formatValue(project, 0),
  ].join("\n");
}

function renderClaimsResource(): string {
  const claims = getClaims();
  const lines = [
    "# Claim ledger",
    "",
    "Every entry carries a status (verified | partial | unverified | contradicted), the evidence, the source and the APPROVED public wording.",
    "Quote the public wording verbatim.",
    "",
  ];
  for (const claim of claims) {
    lines.push(`## ${claim.topic}  [${claim.status.toUpperCase()}]`);
    lines.push(`id: ${claim.id}`);
    lines.push(`claim: ${claim.claim}`);
    lines.push(`evidence: ${claim.evidence}`);
    if (claim.source) lines.push(`source: ${claim.source}`);
    lines.push(`approved wording: "${claim.publicWording}"`);
    lines.push("");
  }
  return lines.join("\n");
}

function renderMetricsResource(): string {
  const metrics = getMetrics();
  const lines = ["# Verified metrics", ""];
  for (const metric of metrics) {
    lines.push(`- ${metric.project} · ${metric.label}: ${metric.value}${metric.unit ? ` ${metric.unit}` : ""}`);
    lines.push(`  method: ${metric.method} · source: ${metric.source} · verified ${metric.verifiedAt}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* The factory                                                         */
/* ------------------------------------------------------------------ */

/**
 * Build one MCP server instance.
 *
 * The factory is cheap and side-effect free: the connection pools and the
 * caches live at module scope in the retrieval layer, and the instance
 * carries nothing between requests.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions: MCP_INSTRUCTIONS,
      // SEP-2549: cache hints for the cacheable results. The tool catalogue
      // and the content resources are static, so a shared cache may keep
      // them; the reads get a shorter window because a re-index invalidates
      // them.
      cacheHints: {
        "tools/list": { ttlMs: 600_000, cacheScope: "public" },
        "prompts/list": { ttlMs: 3_600_000, cacheScope: "public" },
        "resources/list": { ttlMs: 600_000, cacheScope: "public" },
        "resources/read": { ttlMs: 300_000, cacheScope: "public" },
      },
    },
  );

  /* ---------------------------------------------------------------- */
  /* Tools                                                            */
  /* ---------------------------------------------------------------- */

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      async (args, ctx) => tool.run(args, ctx),
    );
  }

  /* ---------------------------------------------------------------- */
  /* Resources                                                        */
  /* ---------------------------------------------------------------- */

  server.registerResource(
    "profile",
    `${PORTFOLIO_SCHEME}://profile`,
    {
      title: "Verified profile",
      description:
        "Name, headline, location, contact details, summary, education, experience, skills and languages.",
      mimeType: "text/markdown",
      cacheHint: { ttlMs: 600_000, cacheScope: "public" },
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: renderProfileResource() },
      ],
    }),
  );

  server.registerResource(
    "claim-ledger",
    `${PORTFOLIO_SCHEME}://claims`,
    {
      title: "Claim ledger",
      description:
        "Every number, employer and capability with its audit status, the evidence and the approved public wording.",
      mimeType: "text/markdown",
      cacheHint: { ttlMs: 600_000, cacheScope: "public" },
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: renderClaimsResource() },
      ],
    }),
  );

  server.registerResource(
    "metrics",
    `${PORTFOLIO_SCHEME}://metrics`,
    {
      title: "Verified metrics",
      description:
        "Every verified number with the unit, the method that produced it, the source and the verification date.",
      mimeType: "text/markdown",
      cacheHint: { ttlMs: 600_000, cacheScope: "public" },
    },
    async (uri) => ({
      contents: [
        { uri: uri.href, mimeType: "text/markdown", text: renderMetricsResource() },
      ],
    }),
  );

  for (const project of getProjects()) {
    const id = project.id;
    server.registerResource(
      `project-${id}`,
      `${PORTFOLIO_SCHEME}://project/${id}`,
      {
        title: `Project: ${project.name}`,
        description: `${project.tagline}`,
        mimeType: "text/markdown",
        cacheHint: { ttlMs: 600_000, cacheScope: "public" },
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text:
              renderProjectResource(id) ??
              `No verified project with the id "${id}".`,
          },
        ],
      }),
    );
  }

  // The MCP App: one `ui://` HTML resource per captured architecture diagram.
  registerArchitectureApp(server);

  /* ---------------------------------------------------------------- */
  /* Prompts                                                          */
  /* ---------------------------------------------------------------- */

  server.registerPrompt(
    "explain_project_to_hiring_manager",
    {
      title: "Explain a project to a hiring manager",
      description:
        "Brief a hiring manager on one of Kaustubh's projects: what it does, how it is built, what is proven and what is not.",
      argsSchema: z.object({
        projectId: z
          .string()
          .min(1)
          .max(64)
          .describe("The project id, e.g. 'smartapply'."),
      }),
    },
    ({ projectId }) => {
      const project = getProject(projectId);
      const summary = project
        ? renderProjectResource(projectId)
        : `No verified project with the id "${projectId}". Known ids: ${getProjects()
            .map((item) => item.id)
            .join(", ")}.`;

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "resource" as const,
              resource: {
                uri: `${PORTFOLIO_SCHEME}://project/${projectId}`,
                mimeType: "text/markdown",
                text: summary ?? "",
              },
            },
          },
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Brief a hiring manager on the project "${projectId}".`,
                "",
                "Use the tools, do not guess:",
                "1. call get_project for the verified summary, and get_architecture for the captured diagram;",
                "2. call search_code (and read_file / find_symbol) to show WHERE the behaviour is implemented - cite projectId, path and line range;",
                "3. call get_metrics for the numbers that are proven, and get_claim for any claim that may be overstated;",
                "4. quote a claim's approved public wording verbatim and say plainly when something is contradicted or unverified;",
                "5. finish with the caveats: what was NOT captured, what is resume-only, and what is still a prototype.",
                "",
                "Write for a busy engineering manager: at most 300 words, no adjectives that the evidence does not support.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  return server;
}

/**
 * Serve the MCP server over stdio.
 *
 * stdout is the protocol channel, so every diagnostic goes to stderr.
 */
export function serveMcpStdio(): void {
  void serveStdio(() => createMcpServer(), {
    onerror: (error: Error) => {
      console.error(`[mcp] stdio transport error: ${error.message}`);
    },
  });
  console.error(
    `[mcp] ${MCP_SERVER_NAME} ${MCP_SERVER_VERSION} running on stdio ` +
      `(protocol ${MCP_PROTOCOL_VERSION}, tools: ${MCP_TOOL_NAMES.join(", ")})`,
  );
}
