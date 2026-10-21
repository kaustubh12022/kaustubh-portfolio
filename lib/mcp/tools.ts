/**
 * The MCP tool set.
 *
 * WHAT THIS FILE IS
 * -----------------
 * The website answers questions with twelve read-only tools (`lib/ai/tools.ts`).
 * This file exposes the SAME knowledge through the Model Context Protocol, so
 * a recruiter with Claude Desktop, VS Code or Cursor can ask "what did
 * Kaustubh build?" and get a grounded, cited answer from the same index the
 * website uses.
 *
 * REUSE, NOT REIMPLEMENTATION
 * ---------------------------
 * Every MCP tool here DELEGATES to the website tool of the same name. The
 * retrieval, the hybrid search, the path existence check and the claim ledger
 * are NOT reimplemented: the MCP layer only
 *
 *   1. validates the arguments with a Zod v4 schema (Standard Schema), and
 *   2. renders the website tool's result as compact, LLM-readable text.
 *
 * That is why the answers cannot drift away from the website: there is one
 * implementation of "what is true" and one implementation of "how do we find
 * it".
 *
 * PATH SAFETY
 * -----------
 * A model-supplied path never becomes a filesystem path. `read_file` is the
 * website tool, unchanged: it refuses a path that is not repo-relative and
 * then looks the (project, path) pair up in the `chunks` table before a
 * single line is read. The index only contains repo-relative POSIX paths
 * written by the indexer, so there is no traversal surface at all. The extra
 * syntactic guards (`..`, absolute paths, backslashes, NUL) are belt and
 * braces - and they are mirrored here, in {@link pathLooksUnsafe}, so the
 * MCP layer can answer "is this path safe?" without touching the database.
 *
 * READ ONLY
 * ---------
 * There is no shell, no filesystem access at request time, no outbound URL
 * fetching driven by user input and no write path of any kind. The only
 * things the tools touch are the validated content layer (`content/*.yaml`,
 * `content/architecture/*.json`) and the read-only retrieval index
 * (`chunks`, `symbols`) in Neon.
 */

import {
  acceptedContent,
  inputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { createToolState, createTools, TOOL_NAMES } from "@/lib/ai/tools";
import { ArchitectureSchema } from "@/lib/content/schemas";
import { architectureAppMeta } from "@/lib/mcp/apps";

/* ------------------------------------------------------------------ */
/* Protocol constants                                                  */
/* ------------------------------------------------------------------ */

/** The MCP protocol revision this surface speaks. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** Every protocol revision this surface understands. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2026-07-28"] as const;

/* ------------------------------------------------------------------ */
/* Path safety                                                         */
/* ------------------------------------------------------------------ */

/**
 * The syntactic path guard.
 *
 * It is deliberately identical to the one in `lib/ai/tools.ts`: `..`, a
 * backslash, a NUL byte, a leading slash and a drive letter are all refused
 * before the path reaches the index lookup.
 */
const PATH_REJECT = /(\.\.|\\|\0|^\/|^[a-zA-Z]:)/;

/**
 * Would this path be refused by the index lookup?
 *
 * Exported so the unit test can assert the guard without a database.
 */
export function pathLooksUnsafe(path: string): boolean {
  return PATH_REJECT.test(path);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

/** The hard cap on one tool result. Anything longer is cut and says so. */
export const MAX_RESULT_CHARS = 12_000;

/** The hard cap on one source chunk inside a tool result. */
export const MAX_SOURCE_CHARS = 3_500;

/** The hard cap on the number of source lines rendered by `read_file`. */
export const MAX_RENDERED_LINES = 400;

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/** Indent every line of `text` by `pad`. */
function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

/**
 * Render an arbitrary value as compact, readable lines.
 *
 * The point is to be legible to a language model without being a JSON dump:
 * `key: value` for scalars, a bullet per array entry, nested objects indented
 * under their key.
 */
export function formatValue(value: unknown, depth = 0): string {
  const pad = "  ".repeat(depth);

  if (value === null || value === undefined) return `${pad}—`;

  if (typeof value === "string") {
    if (value.length === 0) return `${pad}(empty)`;
    return indent(value, pad);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return `${pad}${String(value)}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}(none)`;
    return value
      .map((item) => {
        if (item !== null && typeof item === "object") {
          const body = formatValue(item, depth + 1);
          const [first, ...rest] = body.split("\n");
          const head = `${pad}- ${(first ?? "").trim()}`;
          return rest.length > 0 ? `${head}\n${rest.join("\n")}` : head;
        }
        return `${pad}- ${formatValue(item, 0).trim()}`;
      })
      .join("\n");
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}(empty)`;
    return entries
      .map(([key, item]) => {
        if (item !== null && typeof item === "object") {
          const body = formatValue(item, depth + 1);
          return `${pad}${key}:\n${body}`;
        }
        return `${pad}${key}: ${formatValue(item, 0).trim()}`;
      })
      .join("\n");
  }

  return `${pad}${String(value)}`;
}

/**
 * Wrap rendered text into an MCP text content block, capped.
 *
 * The cap is announced: a truncated result says so, so the model never
 * mistakes a cut-off answer for a complete one.
 */
export function textResult(text: string): CallToolResult {
  const clipped = clip(text, MAX_RESULT_CHARS);
  const body = clipped.truncated
    ? `${clipped.text}\n\n[truncated: the result was cut at ${MAX_RESULT_CHARS} characters]`
    : clipped.text;
  return { content: [{ type: "text", text: body }] };
}

/* ------------------------------------------------------------------ */
/* The website tool bridge                                             */
/* ------------------------------------------------------------------ */

type WebsiteTools = ReturnType<typeof createTools>;

/**
 * Run one website tool and return its raw result.
 *
 * The website tools are built per request because their behaviour (the
 * served-chunk log) is per request. The MCP surface does not need that log,
 * but it does need the SAME implementations, so it builds them the same way.
 */
async function runWebsiteTool(
  name: keyof WebsiteTools,
  input: Record<string, unknown>,
): Promise<unknown> {
  const tools = createTools(createToolState());
  const tool = tools[name] as unknown as {
    execute?: (args: unknown, options: unknown) => Promise<unknown>;
  };
  if (typeof tool.execute !== "function") {
    throw new Error(
      `the website tool "${String(name)}" has no execute function`,
    );
  }
  return tool.execute(input, { toolCallId: "mcp", messages: [] });
}

/** Narrow an unknown tool result to a record. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* Schemas (Zod v4 - Standard Schema)                                  */
/* ------------------------------------------------------------------ */

const PROJECT_ID = z
  .string()
  .min(1)
  .max(64)
  .describe(
    "Project id. Known ids: smartapply, pawna, c54, aura, personal-ai-os, dayscore.",
  );

const FILE_PATH = z
  .string()
  .min(1)
  .max(300)
  .describe(
    "Repo-relative POSIX path exactly as it appeared in a search_code or find_symbol result, e.g. 'src/ai_engine.py'.",
  );

const FOCUS = z
  .string()
  .optional()
  .describe(
    "Optional narrowing: 'summary' | 'education' | 'experience' | 'skills' | 'links' | 'languages'.",
  );

/**
 * The answer to an MRTR elicitation: which claim did the caller mean?
 *
 * A flat object of primitives, so it converts to the restricted elicitation
 * JSON Schema the 2026-07-28 wire format allows.
 */
const CLAIM_CHOICE = z.object({
  claimId: z
    .string()
    .min(1)
    .max(120)
    .describe("The id of the claim, e.g. 'java-spring'."),
});

/* ------------------------------------------------------------------ */
/* Renderers                                                           */
/* ------------------------------------------------------------------ */

function renderProject(project: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`## ${project.name ?? project.id}`);
  if (project.tagline) lines.push(String(project.tagline));
  lines.push("");
  lines.push(formatValue(project, 0));
  return lines.join("\n");
}

function renderClaim(claim: Record<string, unknown>): string {
  const status = String(claim.status ?? "unknown").toUpperCase();
  const lines: string[] = [];
  lines.push(`## ${claim.topic ?? claim.id}  [${status}]`);
  lines.push(`claim id: ${claim.id ?? ""}`);
  lines.push("");
  lines.push(`Claim: ${claim.claim ?? ""}`);
  if (claim.evidence) {
    lines.push("");
    lines.push(`Evidence: ${claim.evidence}`);
  }
  if (claim.source) {
    lines.push(`Source: ${claim.source}`);
  }
  lines.push("");
  lines.push("APPROVED PUBLIC WORDING (quote it verbatim):");
  lines.push(`"${claim.publicWording ?? ""}"`);
  if (status === "CONTRADICTED") {
    lines.push("");
    lines.push(
      "This claim is CONTRADICTED by the audit. Do not repeat the claim; use the approved wording instead.",
    );
  }
  return lines.join("\n");
}

function renderSearchHits(result: Record<string, unknown>): string {
  const hits = Array.isArray(result.hits) ? result.hits : [];
  if (hits.length === 0) {
    return [
      "No source chunk matched.",
      typeof result.message === "string" ? result.message : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const lines: string[] = [];
  lines.push(`${hits.length} matching chunk(s).`);
  lines.push("");

  hits.forEach((raw, index) => {
    const hit = asRecord(raw);
    const where = `${hit.projectId} · ${hit.path}:${hit.startLine}-${hit.endLine}`;
    const symbol = hit.symbol ? ` · ${hit.symbol}` : "";
    const lang = hit.lang ? ` · ${hit.lang}` : "";
    lines.push(`${index + 1}. ${where}${symbol}${lang}`);
    if (hit.header) lines.push(`   header: ${hit.header}`);
    const body = clip(String(hit.content ?? ""), MAX_SOURCE_CHARS);
    lines.push(indent(body.text, "   "));
    if (body.truncated) {
      lines.push(`   [chunk truncated at ${MAX_SOURCE_CHARS} characters]`);
    }
    lines.push(
      `   cite as: ${hit.projectId} ${hit.path} L${hit.startLine}-L${hit.endLine}`,
    );
    lines.push("");
  });

  return lines.join("\n").trimEnd();
}

function renderFileSlice(result: Record<string, unknown>): string {
  const lines = Array.isArray(result.lines) ? (result.lines as string[]) : [];
  const start = Number(result.startLine ?? 0);
  const shown = lines.slice(0, MAX_RENDERED_LINES);
  const body = shown
    .map((line, index) => `${String(start + index).padStart(5, " ")} | ${line}`)
    .join("\n");

  const head = [
    `## ${result.path}`,
    `project: ${result.projectId} · lines ${result.startLine}-${result.endLine} · rebuilt from ${result.chunkCount} indexed chunk(s)`,
    "",
  ].join("\n");

  const tail =
    lines.length > shown.length
      ? `\n[${lines.length - shown.length} more line(s) not rendered]`
      : "";

  return `${head}${body}${tail}`;
}

function renderSymbol(result: Record<string, unknown>): string {
  const chunks = Array.isArray(result.chunks) ? result.chunks : [];
  const lines: string[] = [];
  lines.push(`## ${result.symbol ?? ""}  (matched ${result.match ?? "none"})`);
  lines.push("");
  chunks.forEach((raw, index) => {
    const chunk = asRecord(raw);
    lines.push(
      `${index + 1}. ${chunk.path}:${chunk.startLine}-${chunk.endLine}${
        chunk.header ? ` · ${chunk.header}` : ""
      }`,
    );
    const body = clip(String(chunk.content ?? ""), MAX_SOURCE_CHARS);
    lines.push(indent(body.text, "   "));
    if (body.truncated) {
      lines.push(`   [chunk truncated at ${MAX_SOURCE_CHARS} characters]`);
    }
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

function renderArchitecture(architecture: Record<string, unknown>): string {
  const nodes = Array.isArray(architecture.nodes) ? architecture.nodes : [];
  const edges = Array.isArray(architecture.edges) ? architecture.edges : [];
  const notes = Array.isArray(architecture.notes) ? architecture.notes : [];

  const lines: string[] = [];
  lines.push(`## ${architecture.title ?? architecture.id}`);
  if (architecture.subtitle) lines.push(String(architecture.subtitle));
  lines.push("");
  lines.push("Nodes:");
  for (const raw of nodes) {
    const node = asRecord(raw);
    lines.push(
      `- ${node.label ?? node.id}${node.detail ? ` — ${node.detail}` : ""}`,
    );
  }
  lines.push("");
  lines.push("Edges:");
  for (const raw of edges) {
    const edge = asRecord(raw);
    lines.push(
      `- ${edge.from} → ${edge.to}${edge.label ? ` (${edge.label})` : ""}`,
    );
  }
  if (notes.length > 0) {
    lines.push("");
    lines.push("Notes:");
    for (const note of notes) lines.push(`- ${note}`);
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* The tool set                                                        */
/* ------------------------------------------------------------------ */

/**
 * One MCP tool: metadata, schema and handler.
 *
 * `run` receives the arguments ALREADY validated by the Zod schema (the MCP
 * SDK rejects a call whose arguments do not match the schema before the
 * handler runs), so the handler only has to narrow the shape it declared.
 */
export type McpTool = {
  name: string;
  title: string;
  /** Written for an LLM that has never seen this project. */
  description: string;
  /** Zod v4 object schema (Standard Schema). */
  inputSchema: z.ZodType;
  /** Optional Zod v4 output schema; when present the tool returns `structuredContent`. */
  outputSchema?: z.ZodType;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  run: (
    args: unknown,
    ctx?: ServerContext,
  ) => Promise<CallToolResult | InputRequiredResult>;
};

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const MCP_TOOLS: McpTool[] = [
  {
    name: "search_code",
    title: "Search the indexed source code",
    description:
      "Hybrid (semantic + keyword) search over six real GitHub repositories that were indexed line by line. Returns the matching chunks with their exact file path, line range and source text. Use it to find WHERE something is implemented before you explain it; it does not answer on its own.",
    inputSchema: z.object({
      query: z
        .string()
        .min(2)
        .max(200)
        .describe("A natural language question or a bare identifier."),
      projectId: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("Restrict the search to one project."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .describe("How many chunks to return. Default 6."),
    }),
    annotations: READ_ONLY,
    run: async (args: unknown) => {
      const a = args as { query: string; projectId?: string; limit?: number };
      const result = asRecord(
        await runWebsiteTool("search_code", {
          query: a.query,
          projectId: a.projectId,
          limit: a.limit,
        }),
      );
      return textResult(renderSearchHits(result));
    },
  },
  {
    name: "read_file",
    title: "Read an indexed source file",
    description:
      "Read the exact source lines of a file that exists in the indexed repository. The path must be one the index already knows - a path that is not in the index is refused, and a path that tries to escape the repository is refused too. Use it after search_code or find_symbol gave you a real path.",
    inputSchema: z.object({
      projectId: PROJECT_ID,
      path: FILE_PATH,
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    }),
    annotations: READ_ONLY,
    run: async (args: unknown) => {
      const a = args as {
        projectId: string;
        path: string;
        startLine?: number;
        endLine?: number;
      };
      // The guard runs BEFORE the index lookup, so an unsafe path never
      // reaches the database and never becomes a filesystem path.
      if (pathLooksUnsafe(a.path)) {
        return textResult(
          [
            "That path is not a repo-relative index path, so it was refused.",
            "Use the exact path from a search_code or find_symbol result.",
          ].join("\n"),
        );
      }
      const result = asRecord(
        await runWebsiteTool("read_file", {
          projectId: a.projectId,
          path: a.path,
          startLine: a.startLine,
          endLine: a.endLine,
        }),
      );
      if (result.ok !== true) {
        return textResult(
          typeof result.message === "string"
            ? result.message
            : "The file could not be read.",
        );
      }
      return textResult(renderFileSlice(result));
    },
  },
  {
    name: "find_symbol",
    title: "Find a named symbol",
    description:
      "Find a named function, class or method in the indexed repositories by exact name, with a trigram-similarity fallback. Returns the file, the line range and the source. Use it when the question names an identifier.",
    inputSchema: z.object({
      projectId: PROJECT_ID,
      name: z
        .string()
        .min(1)
        .max(200)
        .describe("The identifier, e.g. 'calculate_deepseek_cost'."),
    }),
    annotations: READ_ONLY,
    run: async (args: unknown) => {
      const a = args as { projectId: string; name: string };
      const result = asRecord(
        await runWebsiteTool("find_symbol", {
          projectId: a.projectId,
          name: a.name,
        }),
      );
      if (result.found !== true) {
        return textResult(
          typeof result.message === "string"
            ? result.message
            : "No symbol matched.",
        );
      }
      return textResult(renderSymbol(result));
    },
  },
  {
    name: "get_project",
    title: "Get one verified project",
    description:
      "One verified project: tagline, status, role, timeline, stack, summary, highlights, features, metrics, caveats and assets. Use it for 'what is X' and 'what did you build'.",
    inputSchema: z.object({ id: PROJECT_ID }),
    annotations: READ_ONLY,
    run: async (args: unknown) => {
      const a = args as { id: string };
      const result = asRecord(await runWebsiteTool("get_project", { id: a.id }));
      if (result.found !== true) {
        return textResult(
          typeof result.message === "string"
            ? result.message
            : "No such project.",
        );
      }
      return textResult(renderProject(asRecord(result.project)));
    },
  },
  {
    name: "get_architecture",
    title: "Get the architecture diagram of a project",
    description:
      "The captured architecture diagram of a project: the stages, the nodes, the edges and the notes. Use it for 'show me the X architecture'. When the diagram was never captured it says so - do not describe one from memory.",
    inputSchema: z.object({ projectId: PROJECT_ID }),
    outputSchema: ArchitectureSchema,
    annotations: READ_ONLY,
    run: async (args: unknown) => {
      const a = args as { projectId: string };
      const result = asRecord(
        await runWebsiteTool("get_architecture", { projectId: a.projectId }),
      );
      if (result.found !== true) {
        return textResult(
          typeof result.message === "string"
            ? result.message
            : "No architecture diagram was captured.",
        );
      }
      const architecture = asRecord(result.architecture);
      const rendered = textResult(renderArchitecture(architecture));

      // MCP APPS: the result points at the `ui://` HTML resource, so a host
      // that supports the extension renders the diagram inline next to this
      // answer.
      const meta = architectureAppMeta(a.projectId);
      if (!meta) return rendered;

      return {
        content: rendered.content,
        structuredContent: architecture,
        _meta: meta,
      };
    },
  },
  {
    name: "get_metrics",
    title: "Get the verified metrics",
    description:
      "The verified metrics: the number, the unit, the method that produced it, the source and the date it was verified. Use it for 'what numbers can you prove'. Without a projectId it returns every metric.",
    inputSchema: z.object({
      projectId: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("Restrict to one project."),
    }),
    annotations: READ_ONLY,
    run: async (args: unknown) => {
      const a = args as { projectId?: string };
      const result = asRecord(
        await runWebsiteTool("get_metrics", { projectId: a.projectId }),
      );
      const metrics = Array.isArray(result.metrics) ? result.metrics : [];
      const lines = [`${metrics.length} verified metric(s).`, ""];
      for (const raw of metrics) {
        const metric = asRecord(raw);
        lines.push(
          `- ${metric.label ?? metric.id}: ${metric.value ?? ""}${
            metric.unit ? ` ${metric.unit}` : ""
          }`,
        );
        lines.push(
          `  method: ${metric.method ?? "—"} · source: ${
            metric.source ?? "—"
          } · verified ${metric.verifiedAt ?? "—"}`,
        );
      }
      return textResult(lines.join("\n"));
    },
  },
  {
    name: "get_assets",
    title: "Get the captured assets",
    description:
      "The captured assets (screenshots, diagrams, photos) per project, with their caption and whether the asset is ready or still needed. Use it when someone asks what the project looks like.",
    inputSchema: z.object({
      projectId: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe("Restrict to one project."),
    }),
    annotations: READ_ONLY,
    run: async (args: unknown) => {
      const a = args as { projectId?: string };
      const result = asRecord(
        await runWebsiteTool("get_assets", { projectId: a.projectId }),
      );
      const assets = Array.isArray(result.assets) ? result.assets : [];
      const lines = [`${assets.length} captured asset(s).`, ""];
      for (const raw of assets) {
        const asset = asRecord(raw);
        lines.push(
          `- ${asset.project ?? ""} · ${asset.kind ?? ""} · ${
            asset.status ?? ""
          }: ${asset.caption ?? ""}`,
        );
        if (asset.alt) lines.push(`  alt: ${asset.alt}`);
      }
      return textResult(lines.join("\n"));
    },
  },
  {
    name: "get_claim",
    title: "Get one claim-ledger entry",
    description:
      "One entry of the claim ledger: the claim, its status (verified | partial | unverified | contradicted), the evidence, the source and the APPROVED public wording. Use it for any question about a number, an employer or a capability that may be overstated, and quote the approved wording verbatim. If the id matches nothing, the server asks you which claim you meant instead of guessing.",
    inputSchema: z.object({
      id: z
        .string()
        .min(1)
        .max(120)
        .describe(
          "The claim id (e.g. 'smartapply-cost') or its topic (e.g. 'SmartApply cost reduction').",
        ),
    }),
    annotations: READ_ONLY,
    run: async (args: unknown, ctx?: ServerContext) => {
      const a = args as { id: string };

      const first = asRecord(await runWebsiteTool("get_claim", { id: a.id }));
      if (first.found === true) {
        return textResult(renderClaim(asRecord(first.claim)));
      }

      // MULTI ROUND-TRIP REQUEST (SEP-2322).
      // The server needs one more piece of input from the caller: which claim
      // was meant. The client answers the embedded elicitation and retries
      // the same call with `inputResponses` attached.
      const answered = acceptedContent(
        ctx?.mcpReq?.inputResponses,
        "claimId",
        CLAIM_CHOICE,
      );
      if (answered?.claimId) {
        const second = asRecord(
          await runWebsiteTool("get_claim", { id: answered.claimId }),
        );
        if (second.found === true) {
          return textResult(renderClaim(asRecord(second.claim)));
        }
        return textResult(
          `No claim with id or topic "${answered.claimId}". Use one of the ids the ledger lists.`,
        );
      }

      const known =
        typeof first.message === "string" ? first.message : "No claim matched.";
      const knownIds = known.includes("Known ids:")
        ? (known.split("Known ids:")[1] ?? "").trim()
        : known;
      return inputRequired({
        inputRequests: {
          claimId: inputRequired.elicit({
            message: `No claim matches "${a.id}". Which claim did you mean? Known ids: ${knownIds}`,
            requestedSchema: CLAIM_CHOICE,
          }),
        },
      });
    },
  },
  {
    name: "get_profile",
    title: "Get the verified profile",
    description:
      "The verified profile: name, headline, location, email, links, summary, education, experience, skills and languages. Use it for questions about who Kaustubh is, his degree, his internship, his location or his skills.",
    inputSchema: z.object({ focus: FOCUS }),
    annotations: READ_ONLY,
    run: async (args: unknown) => {
      const a = args as { focus?: string };
      const result = asRecord(
        await runWebsiteTool("get_profile", { focus: a.focus }),
      );
      const lines = ["## Verified profile", "", formatValue(result, 0)];
      return textResult(lines.join("\n"));
    },
  },
  {
    name: "compare_projects",
    title: "Compare two to four projects",
    description:
      "Compare two to four projects side by side on one dimension: stack, status, features, metrics, caveats or everything. Use it for 'how do X and Y differ'.",
    inputSchema: z.object({
      projectIds: z
        .array(z.string().min(1).max(64))
        .min(2)
        .max(4)
        .describe("Two to four project ids."),
      dimension: z
        .string()
        .max(60)
        .optional()
        .describe(
          "Optional narrowing: 'stack' | 'status' | 'features' | 'metrics' | 'caveats' | 'summary'.",
        ),
    }),
    annotations: READ_ONLY,
    run: async (args: unknown) => {
      const a = args as { projectIds: string[]; dimension?: string };
      const result = asRecord(
        await runWebsiteTool("compare_projects", {
          projectIds: a.projectIds,
          dimension: a.dimension,
        }),
      );
      if (result.found !== true) {
        return textResult(
          typeof result.message === "string"
            ? result.message
            : "None of those project ids exist.",
        );
      }
      const rows = Array.isArray(result.projects) ? result.projects : [];
      const lines = [
        `Comparison on dimension: ${result.dimension ?? "everything"}`,
        "",
      ];
      for (const raw of rows) {
        lines.push(formatValue(raw, 0));
        lines.push("");
      }
      return textResult(lines.join("\n").trimEnd());
    },
  },
];

/** The names of the MCP tools, in a stable order. */
export const MCP_TOOL_NAMES = MCP_TOOLS.map((tool) => tool.name);

/**
 * The website tools this surface does NOT expose.
 *
 * `render_visual` is website-only: it declares which card the chat UI should
 * draw, which has no meaning over MCP. `get_data_model` reads the schema
 * files of the indexed repositories; it is deliberately left out of the
 * requested MCP tool set.
 */
export const WEBSITE_ONLY_TOOL_NAMES = TOOL_NAMES.filter(
  (name) => !MCP_TOOL_NAMES.includes(name),
);
