import "server-only";

/**
 * The twelve read-only tools.
 *
 * THE CONTRACT
 * ------------
 * Every tool in this file is READ ONLY. There is no shell, no filesystem
 * access at request time, no outbound URL fetching driven by user input and
 * no write path of any kind. The only things they touch are:
 *
 *   - the validated content layer (`content/*.yaml`, `content/architecture/*.json`)
 *   - the read-only retrieval index (`chunks`, `symbols`) in Neon
 *
 * WHY THE TOOLS ARE A FACTORY
 * ---------------------------
 * The tool SET is stable (same names, same schemas, same descriptions on
 * every request - that matters, because DeepSeek's prefix cache covers the
 * serialised tool schemas too). The tool BEHAVIOUR is not: each request needs
 * its own collector, so the server can record which chunks it actually
 * served and which structured result the model declared.
 *
 * `createTools(state)` therefore closes over a per-request {@link ToolState}.
 * Every Zod schema below is a MODULE level constant, so the serialised
 * schema - and therefore the cached prefix - is byte identical every time.
 *
 * PATH SAFETY
 * -----------
 * A model-supplied path never becomes a filesystem path. `read_file` looks
 * the path up in the `chunks` table first: if the exact (project_id, path)
 * pair does not exist in the index, the read is refused. The index only
 * contains repo-relative POSIX paths that were written by the indexer, so
 * there is no traversal surface at all. The extra syntactic guards below
 * (`..`, absolute paths, backslashes, NUL) are belt and braces.
 */

import { tool, type ToolSet } from "ai";
import { z } from "zod";

import {
  getArchitecture,
  getAssets,
  getAssetsForProject,
  getClaim,
  getClaims,
  getMetrics,
  getMetricsForProject,
  getProfile,
  getProject,
  getProjects,
} from "@/lib/content/load";
import { query } from "@/lib/retrieval/db";
import {
  EmbeddingUnavailableError,
  embedQuery,
} from "@/lib/retrieval/embed";
import { findSymbol, readFile, searchChunks } from "@/lib/retrieval/search";

/* ------------------------------------------------------------------ */
/* Per-request state                                                  */
/* ------------------------------------------------------------------ */

/** A chunk the server actually handed to the model during this request. */
export type ServedChunk = {
  projectId: string;
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
  /**
   * The exact text the model was shown for this chunk.
   *
   * It is kept so the route can fill in a missing `quote` from the server's
   * own copy: when the model cites a range that is exactly one served chunk,
   * the chunk content IS the evidence and no quote is needed.
   */
  content: string;
};

/** The structured result the model declared through `render_visual`. */
export type VisualDeclaration = {
  /** The spec exactly as the model wrote it (already Zod validated). */
  spec: Record<string, unknown> | null;
  /** The citations the model asked to show. */
  evidence: Array<{
    projectId: string;
    path: string;
    startLine: number;
    endLine: number;
    symbol?: string;
    quote?: string;
  }>;
  followUps: string[];
  confidence: "high" | "medium" | "low";
  caveats: string[];
};

/** One tool invocation the model made during this request. */
export type ToolCall = {
  tool: string;
  input: Record<string, unknown>;
};

/** Mutable state for one request. */
export type ToolState = {
  /** Every chunk the server served, keyed by `projectId::path::start::end`. */
  served: Map<string, ServedChunk>;
  /** True once the embedding model has failed to load in this request. */
  retrievalUnavailable: boolean;
  /** The last structured result the model declared. */
  declaration: VisualDeclaration | null;
  /** How many tool calls the model made. */
  toolCalls: number;
  /** Every tool call, in order. Used to derive a fallback visual. */
  calls: ToolCall[];
};

export function createToolState(): ToolState {
  return {
    served: new Map(),
    retrievalUnavailable: false,
    declaration: null,
    toolCalls: 0,
    calls: [],
  };
}

function servedKey(chunk: ServedChunk): string {
  return `${chunk.projectId}::${chunk.path}::${chunk.startLine}::${chunk.endLine}`;
}

function recordServed(
  state: ToolState,
  chunk: ServedChunk,
): void {
  const key = servedKey(chunk);
  if (!state.served.has(key)) state.served.set(key, chunk);
}

/**
 * Find the served chunk that matches an exact (project, path, range).
 *
 * Used by the route to fill in a missing quote from the server's own copy of
 * the text, so a citation of a chunk the model really read does not need a
 * hand-typed quote.
 */
export function findServedChunk(
  state: ToolState,
  projectId: string,
  path: string,
  startLine: number,
  endLine: number,
): ServedChunk | undefined {
  return state.served.get(
    `${projectId}::${path}::${startLine}::${endLine}`,
  );
}

/* ------------------------------------------------------------------ */
/* Schemas (module level -> stable serialised prefix)                 */
/* ------------------------------------------------------------------ */

const FOCUS = z
  .string()
  .optional()
  .describe(
    "Optional narrowing: 'summary' | 'education' | 'experience' | 'skills' | 'links' | 'languages'.",
  );

const PROJECT_ID = z
  .string()
  .min(1)
  .max(200)
  .describe(
    "Project id. Known ids: smartapply, pawna, c54, aura, personal-ai-os, dayscore, copilot.",
  );

/**
 * A path the model wants to read.
 *
 * It is NOT trusted: the server checks the (projectId, path) pair against the
 * `chunks` table before a single line is read.
 */
const FILE_PATH = z
  .string()
  .min(1)
  .max(600)
  .describe(
    "Repo-relative POSIX path exactly as it appeared in a search_code or find_symbol result, e.g. 'src/ai_engine.py'.",
  );

/**
 * The evidence the model declares.
 *
 * There is deliberately NO `quote` field. The model used to copy source
 * lines into the tool call, and two things went wrong: the copy was often
 * wrong (so the citation was dropped for a reason the model could not see),
 * and it burned so many output tokens that the tool call itself was cut off
 * mid-JSON by the output cap, which lost the whole structured result.
 *
 * The server does not need the quote. It re-reads the index and checks that
 * the cited range really is covered by the indexed chunks of that file, and
 * when a quote IS present it has to match the indexed text exactly.
 *
 * Every field is OPTIONAL and permissive on purpose. A strict schema would
 * reject the whole tool call when the model gets one detail wrong, and a
 * rejected tool call is unrecoverable - the model never sees the result and
 * the structured declaration is lost. The real validation happens inside
 * `execute`, which returns a message the model can act on.
 */
const EVIDENCE_ITEM = z.object({
  projectId: z.string().max(200).optional(),
  path: z.string().max(600).optional(),
  startLine: z.coerce.number().int().optional(),
  endLine: z.coerce.number().int().optional(),
  symbol: z.string().max(400).optional(),
});

/**
 * The declaration the model makes at the end of an answer.
 *
 * As permissive as the evidence: the shape is checked inside `execute`, not
 * by the schema, so a slightly wrong declaration still produces a tool
 * result (and therefore a usable answer).
 *
 * NOTE ON THE LIMITS: there is deliberately NO `max()` on any array and no
 * minimum on `spec`. A schema that rejects the call is worse than a schema
 * that accepts a bad value, because a rejected call is UNRECOVERABLE - the
 * model never sees a tool result and the whole structured declaration is
 * lost. Every bound is applied inside `execute` instead, where it becomes a
 * friendly message the model can act on.
 */
const RENDER_INPUT = z.object({
  spec: z
    .unknown()
    .describe(
      "The visual spec object. One of: {kind:'profile'} | {kind:'education'} | {kind:'skills'} | {kind:'project',projectId} | {kind:'architecture',projectId} | {kind:'flow',projectId} | {kind:'data-model',projectId} | {kind:'code',projectId,path,startLine,endLine} | {kind:'comparison',projectIds,dimension?} | {kind:'metrics',projectId?} | {kind:'claims',claimIds} | {kind:'contact'}",
    ),
  evidence: z
    .array(EVIDENCE_ITEM)
    .default([])
    .describe(
      "The citations you used. Each needs projectId, path, startLine and endLine - the line range of a chunk you read. Do not paste source text into the tool call.",
    ),
  followUps: z
    .array(z.string().max(400))
    .default([])
    .describe("Up to three short follow-up questions."),
  confidence: z
    .string()
    .max(40)
    .default("medium")
    .describe("'high' | 'medium' | 'low'."),
  caveats: z
    .array(z.string().max(600))
    .default([])
    .describe("The honest limits of the answer."),
});

/* ------------------------------------------------------------------ */
/* Visual spec validation                                             */
/* ------------------------------------------------------------------ */

/**
 * The twelve visual kinds.
 *
 * Kept next to {@link VisualSpecSchema} so the two cannot drift apart: the
 * schema below is built from these exact literals.
 */
const VISUAL_KINDS = [
  "profile",
  "education",
  "skills",
  "project",
  "architecture",
  "flow",
  "data-model",
  "code",
  "comparison",
  "metrics",
  "claims",
  "contact",
] as const;

/** True when the string is one of the twelve known visual kinds. */
export function isVisualKind(value: string): boolean {
  return (VISUAL_KINDS as readonly string[]).includes(value);
}

/**
 * The Zod mirror of `VisualSpec` in `lib/types/chat.ts`.
 *
 * The renderer on the client only accepts a spec that matches this shape,
 * so the server validates the model's spec BEFORE it is put on the wire. An
 * invalid spec becomes `null` and the client falls back to `UnknownCard`.
 */
export const VisualSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("profile") }),
  z.object({ kind: z.literal("education") }),
  z.object({ kind: z.literal("skills") }),
  z.object({ kind: z.literal("project"), projectId: z.string().min(1) }),
  z.object({ kind: z.literal("architecture"), projectId: z.string().min(1) }),
  z.object({ kind: z.literal("flow"), projectId: z.string().min(1) }),
  z.object({ kind: z.literal("data-model"), projectId: z.string().min(1) }),
  z.object({
    kind: z.literal("code"),
    projectId: z.string().min(1),
    path: z.string().min(1),
    startLine: z.number().int().min(1),
    endLine: z.number().int().min(1),
  }),
  z.object({
    kind: z.literal("comparison"),
    projectIds: z.array(z.string().min(1)).min(2).max(4),
    dimension: z.string().max(60).optional(),
  }),
  z.object({ kind: z.literal("metrics"), projectId: z.string().min(1).optional() }),
  z.object({ kind: z.literal("claims"), claimIds: z.array(z.string().min(1)).max(8) }),
  z.object({ kind: z.literal("contact") }),
]);

/**
 * Validate a model-supplied visual spec.
 *
 * @returns the parsed spec, or `null` when the spec is not one of the
 *          twelve known kinds.
 */
export function parseVisualSpec(
  raw: unknown,
): Record<string, unknown> | null {
  const result = VisualSpecSchema.safeParse(raw);
  if (!result.success) return null;
  return result.data as unknown as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Cap a chunk body so one huge file cannot blow the context window.
 *
 * WHY 2200 AND NOT 6000
 * --------------------
 * This number is the single biggest cost lever in the whole system, so it is
 * worth being precise about the arithmetic.
 *
 * DeepSeek bills a cache MISS at $0.15 per million input tokens and a cache
 * HIT at $0.003 - a 50x difference. The system prompt and the tool schemas
 * are byte-stable, so they always hit the cache and cost almost nothing.
 *
 * The tool RESULTS are not stable: the code chunks returned by `search_code`
 * are different for every question, so they are a cache MISS every single
 * time. They are therefore billed at the full 50x rate.
 *
 * Measured on this deployment: 516 requests cost $0.5156, of which
 * $0.313 (61%) was cache-miss input. Almost all of that miss was chunk
 * bodies. The average request carried ~4,042 uncached tokens.
 *
 * At 6,000 characters per chunk and 6 chunks per search, a single search
 * could inject ~36,000 characters - roughly 9,000 tokens - of uncached code
 * into the prompt. At 2,200 characters and 4 chunks the worst case is
 * ~2,200 tokens, a 4x reduction, and the model still sees the function
 * signature, the docstring and the body of every hit it needs to answer
 * "where is this implemented".
 *
 * A chunk is a function or a class, so 2,200 characters is usually the whole
 * thing. When it is not, `truncated: true` is returned and the model can ask
 * for a narrower range with `read_file`, which is charged the same but
 * returns only what was asked for.
 */
const MAX_CHUNK_CHARS = 2200;

/**
 * The default number of chunks `search_code` returns.
 *
 * Four is enough to answer the question and to see the surrounding
 * structure; six was paying for two chunks nobody read.
 */
export const DEFAULT_SEARCH_LIMIT = 4;

/**
 * The hard ceiling on chunks returned by `search_code`.
 *
 * The input schema accepts anything up to 30 so a "give me 20 chunks" call
 * is never REJECTED (a rejected tool call is unrecoverable), and the limit
 * is applied in `execute` instead.
 */
export const MAX_SEARCH_LIMIT = 6;

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_CHUNK_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_CHUNK_CHARS), truncated: true };
}

const PATH_REJECT = /(\.\.|\\|\0|^\/|^[a-zA-Z]:)/;

function pathLooksUnsafe(path: string): boolean {
  return PATH_REJECT.test(path);
}

/** Does the index know this exact (project, path) pair? */
const PATH_EXISTS_SQL = `
  SELECT 1
    FROM chunks
   WHERE project_id = $1 AND path = $2
   LIMIT 1`;

const CHUNK_ROWS_SQL = `
  SELECT start_line, end_line, content, symbol, kind, header, path
    FROM chunks
   WHERE project_id = $1 AND path = $2
   ORDER BY start_line, end_line`;

const DATA_MODEL_SQL = `
  SELECT path, symbol, kind, start_line, end_line, header, content
    FROM chunks
   WHERE project_id = $1
     AND (
          path ILIKE '%/models/%'
       OR path ILIKE '%/model/%'
       OR path ILIKE '%/schema%'
       OR path ILIKE '%schema.%'
       OR path ILIKE '%migrations/%'
       OR path ILIKE '%init_tables%'
       OR path ILIKE '%.sql'
       OR path ILIKE '%entities/%'
     )
   ORDER BY path, start_line
   LIMIT 60`;

/* ------------------------------------------------------------------ */
/* The tools                                                          */
/* ------------------------------------------------------------------ */

/**
 * Build the tool set for one request.
 *
 * @param state the per-request collector
 */
export function createTools(state: ToolState): ToolSet {
  /**
   * Record one tool invocation.
   *
   * The call log is what lets the server derive a FALLBACK visual when the
   * model forgets to call `render_visual`: if the model asked for the
   * architecture of "smartapply", the honest fallback visual is the
   * architecture card of "smartapply" - it is derived from what the model
   * actually did, never invented.
   */
  const note = (tool: string, input: Record<string, unknown>): void => {
    state.toolCalls += 1;
    state.calls.push({ tool, input });
  };

  const getProfileTool = tool({
    description:
      "The verified profile: name, headline, location, email, links, summary, education, experience, skills and languages. Use it for questions about who Kaustubh is, his degree, his internship, his location or his skills.",
    inputSchema: z.object({ focus: FOCUS }),
    execute: async ({ focus }: { focus?: string }) => {
      note("get_profile", focus ? { focus } : {});
      const profile = getProfile();
      const base = {
        name: profile.name,
        headline: profile.headline,
        location: profile.location,
        email: profile.email,
        links: profile.links,
        summary: profile.summary,
        availability: profile.availability,
      };
      if (!focus) {
        return {
          ...base,
          education: profile.education,
          experience: profile.experience,
          skills: profile.skills,
          languages: profile.languages,
        };
      }
      switch (focus) {
        case "education":
          return { education: profile.education };
        case "experience":
          return { experience: profile.experience };
        case "skills":
          return { skills: profile.skills, languages: profile.languages };
        case "links":
          return { links: profile.links, email: profile.email };
        case "languages":
          return { languages: profile.languages };
        default:
          return base;
      }
    },
  });

  const getProjectTool = tool({
    description:
      "One verified project: tagline, status, role, timeline, stack, summary, highlights, features, metrics, caveats and assets. Use it for 'what is X' and 'what did you build'.",
    inputSchema: z.object({ id: PROJECT_ID }),
    execute: async ({ id }: { id: string }) => {
      note("get_project", { id });
      const project = getProject(id);
      if (!project) {
        return {
          found: false,
          message: `No project with id "${id}" exists in the verified project index. Known ids: ${getProjects()
            .map((item) => item.id)
            .join(", ")}.`,
        };
      }
      return { found: true, project };
    },
  });

  const getArchitectureTool = tool({
    description:
      "The captured architecture diagram of a project: the stages, the nodes, the edges and the notes. Use it for 'show me the X architecture'.",
    inputSchema: z.object({ projectId: PROJECT_ID }),
    execute: async ({ projectId }: { projectId: string }) => {
      note("get_architecture", { projectId });
      try {
        const architecture = getArchitecture(projectId);
        return { found: true, architecture };
      } catch {
        return {
          found: false,
          message: `The architecture diagram for "${projectId}" is not captured yet. Do not describe one from memory.`,
        };
      }
    },
  });

  const getDataModelTool = tool({
    description:
      "The real data model of a project, read from the schema files in the indexed repository (Mongoose models, SQL migrations, table initialisers). Use it for 'what does the X data model look like'. If the model was never captured it says so - do not invent one.",
    inputSchema: z.object({ projectId: PROJECT_ID }),
    execute: async ({ projectId }: { projectId: string }) => {
      note("get_data_model", { projectId });
      const result = await query<{
        path: string;
        symbol: string;
        kind: string;
        start_line: number;
        end_line: number;
        header: string;
        content: string;
      }>(DATA_MODEL_SQL, [projectId]);

      if (result.rows.length === 0) {
        return {
          captured: false,
          projectId,
          marker:
            "NOT CAPTURED: no schema, model, migration or table definition for this project exists in the indexed source. Say that it was not captured; do not describe a data model from memory.",
        };
      }

      // One entry per file, with the schema lines of that file.
      const byPath = new Map<
        string,
        { symbol: string; kind: string; startLine: number; endLine: number; header: string; content: string }[]
      >();
      for (const row of result.rows) {
        const list = byPath.get(row.path) ?? [];
        list.push({
          symbol: row.symbol,
          kind: row.kind,
          startLine: row.start_line,
          endLine: row.end_line,
          header: row.header,
          content: row.content,
        });
        byPath.set(row.path, list);
      }

      const files = [...byPath.entries()].map(([path, parts]) => {
        const startLine = Math.min(...parts.map((part) => part.startLine));
        const endLine = Math.max(...parts.map((part) => part.endLine));
        const body = parts
          .sort((a, b) => a.startLine - b.startLine)
          .map((part) => part.content)
          .join("\n");
        const clipped = clip(body);
        recordServed(state, {
          projectId,
          path,
          startLine,
          endLine,
          symbol: parts[0]?.symbol ?? "",
          content: clipped.text,
        });
        return {
          path,
          startLine,
          endLine,
          symbol: parts[0]?.symbol ?? "",
          header: parts[0]?.header ?? "",
          content: clipped.text,
          truncated: clipped.truncated,
        };
      });

      return { captured: true, projectId, files };
    },
  });

  const searchCodeTool = tool({
    description:
      "Hybrid search over the indexed source repositories (semantic + keyword, fused). Returns the matching chunks with their exact file path, line range and source text. Use it to find WHERE something is implemented before you explain it.",
    inputSchema: z.object({
      query: z
        .string()
        .min(1)
        .max(600)
        .describe("A natural language question or a bare identifier."),
      projectId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Restrict the search to one project."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(30)
        .optional()
        .describe(
          "How many chunks to return. Default 4, hard maximum 6. More chunks means more uncached input tokens, so prefer 4 and use read_file for detail.",
        ),
    }),
    execute: async ({
      query: q,
      projectId,
      limit,
    }: {
      query: string;
      projectId?: string;
      limit?: number;
    }) => {
      note("search_code", { query: q, projectId, limit });
      try {
        const embedding = await embedQuery(q);
        // The SCHEMA accepts a large limit so the call is never rejected;
        // the real cap is applied here. A rejected tool call is
        // unrecoverable, a clamped one is not.
        const capped = Math.min(limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
        const hits = await searchChunks(
          {
            query: q,
            projectId,
            limit: capped,
          },
          embedding,
        );
        const results = hits.map((hit) => {
          const clipped = clip(hit.content);
          recordServed(state, {
            projectId: hit.projectId,
            path: hit.path,
            startLine: hit.startLine,
            endLine: hit.endLine,
            symbol: hit.symbol,
            content: clipped.text,
          });
          return {
            projectId: hit.projectId,
            path: hit.path,
            startLine: hit.startLine,
            endLine: hit.endLine,
            symbol: hit.symbol,
            kind: hit.kind,
            lang: hit.lang,
            header: hit.header,
            content: clipped.text,
            truncated: clipped.truncated,
          };
        });
        if (results.length === 0) {
          return {
            hits: [],
            message:
              "No chunk matched. Try a different identifier, a shorter query, or drop the projectId filter.",
          };
        }
        return { hits: results };
      } catch (error) {
        if (error instanceof EmbeddingUnavailableError) {
          state.retrievalUnavailable = true;
          return {
            hits: [],
            retrievalUnavailable: true,
            message:
              "The source index is unavailable for this request (the local embedding model could not be loaded). Answer from the claim ledger and the content layer instead, and say that the source index was unavailable.",
          };
        }
        // Any other failure (a database hiccup, a network error) must not
        // kill the stream: the model can still answer from the ledger.
        state.retrievalUnavailable = true;
        return {
          hits: [],
          retrievalUnavailable: true,
          message: `The code search failed: ${
            error instanceof Error ? error.message : String(error)
          }. Answer from the claim ledger and the content layer instead, and say that the source index was unavailable.`,
        };
      }
    },
  });

  const readFileTool = tool({
    description:
      "Read the exact source lines of a file that exists in the indexed repository. The path must be one the index already knows - a path that is not in the index is refused. Use it after search_code or find_symbol gave you a real path.",
    inputSchema: z.object({
      projectId: PROJECT_ID,
      path: FILE_PATH,
      startLine: z.number().int().min(1).optional(),
      endLine: z.number().int().min(1).optional(),
    }),
    execute: async ({
      projectId,
      path,
      startLine,
      endLine,
    }: {
      projectId: string;
      path: string;
      startLine?: number;
      endLine?: number;
    }) => {
      note("read_file", { projectId, path, startLine, endLine });

      if (pathLooksUnsafe(path)) {
        return {
          ok: false,
          message:
            "That path is not a repo-relative index path. Use the exact path from a search_code or find_symbol result.",
        };
      }

      const exists = await query<{ one: number }>(PATH_EXISTS_SQL, [
        projectId,
        path,
      ]);
      if (exists.rows.length === 0) {
        return {
          ok: false,
          message: `The path "${path}" does not exist in the index for project "${projectId}". Use search_code to find the real path; do not guess one.`,
        };
      }

      const slice = await readFile(projectId, path, startLine, endLine);
      if (slice.lines.length === 0) {
        return {
          ok: false,
          message: `The path "${path}" has no readable lines in the index.`,
        };
      }

      // Record the chunks that cover the returned range so the citation
      // validator can confirm them later.
      const rows = await query<{
        start_line: number;
        end_line: number;
        symbol: string;
      }>(CHUNK_ROWS_SQL, [projectId, path]);
      for (const row of rows.rows) {
        if (row.start_line > slice.endLine || row.end_line < slice.startLine) {
          continue;
        }
        recordServed(state, {
          projectId,
          path,
          startLine: row.start_line,
          endLine: row.end_line,
          symbol: row.symbol,
          content: "",
        });
      }

      return {
        ok: true,
        projectId,
        path,
        startLine: slice.startLine,
        endLine: slice.endLine,
        chunkCount: slice.chunkCount,
        lines: slice.lines,
      };
    },
  });

  const findSymbolTool = tool({
    description:
      "Find a named function, class or method in the indexed repositories by exact name (with a fuzzy fallback). Returns the file, the line range and the source. Use it when the question names an identifier.",
    inputSchema: z.object({
      projectId: PROJECT_ID,
      name: z.string().min(1).max(400).describe("The identifier, e.g. 'calculate_deepseek_cost'."),
    }),
    execute: async ({ projectId, name }: { projectId: string; name: string }) => {
      note("find_symbol", { projectId, name });
      const lookup = await findSymbol(projectId, name);
      if (lookup.match === "none" || !lookup.symbol) {
        return {
          found: false,
          message: `No symbol named "${name}" in project "${projectId}". Try search_code with a natural language description instead.`,
        };
      }
      const chunks = lookup.chunks.map((chunk) => {
        const clipped = clip(chunk.content);
        recordServed(state, {
          projectId: chunk.projectId,
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          symbol: chunk.symbol,
          content: clipped.text,
        });
        return {
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          symbol: chunk.symbol,
          header: chunk.header,
          content: clipped.text,
          truncated: clipped.truncated,
        };
      });
      return {
        found: true,
        match: lookup.match,
        symbol: lookup.symbol,
        chunks,
      };
    },
  });

  const getMetricsTool = tool({
    description:
      "The verified metrics: the number, the unit, the method that produced it, the source and the date it was verified. Use it for 'what numbers can you prove'. Without a projectId it returns every metric.",
    inputSchema: z.object({
      projectId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Restrict to one project."),
    }),
    execute: async ({ projectId }: { projectId?: string }) => {
      note("get_metrics", projectId ? { projectId } : {});
      const metrics = projectId
        ? getMetricsForProject(projectId)
        : getMetrics();
      return { count: metrics.length, metrics };
    },
  });

  const getAssetsTool = tool({
    description:
      "The captured assets (screenshots, diagrams, photos) per project, with their caption and whether the asset is ready or still needed.",
    inputSchema: z.object({
      projectId: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe("Restrict to one project."),
    }),
    execute: async ({ projectId }: { projectId?: string }) => {
      note("get_assets", projectId ? { projectId } : {});
      const assets = projectId ? getAssetsForProject(projectId) : getAssets();
      return { count: assets.length, assets };
    },
  });

  const getClaimTool = tool({
    description:
      "One entry of the claim ledger: the claim, its status (verified | partial | unverified | contradicted), the evidence, the source and the APPROVED public wording. Use it for any question about a number, an employer or a capability that may be overstated. If a claim has publicWording, quote it verbatim.",
    inputSchema: z.object({
      id: z
        .string()
        .min(1)
        .max(300)
        .describe(
          "The claim id (e.g. 'smartapply-cost') or its topic (e.g. 'SmartApply cost reduction').",
        ),
    }),
    execute: async ({ id }: { id: string }) => {
      note("get_claim", { id });
      const claim = getClaim(id);
      if (!claim) {
        return {
          found: false,
          message: `No claim with id or topic "${id}". Known ids: ${getClaims()
            .map((item) => item.id)
            .join(", ")}.`,
        };
      }
      return { found: true, claim };
    },
  });

  const compareProjectsTool = tool({
    description:
      "Compare two to six projects side by side on one dimension: stack, status, features, metrics, caveats or everything. Use it for 'how do X and Y differ'.",
    inputSchema: z.object({
      projectIds: z
        .array(z.string().min(1).max(200))
        .min(1)
        .max(20)
        .describe("One to twenty project ids. The first six are compared."),
      dimension: z
        .string()
        .max(120)
        .optional()
        .describe(
          "Optional narrowing: 'stack' | 'status' | 'features' | 'metrics' | 'caveats' | 'summary'.",
        ),
    }),
    execute: async ({
      projectIds,
      dimension,
    }: {
      projectIds: string[];
      dimension?: string;
    }) => {
      note("compare_projects", { projectIds, dimension });
      // The SCHEMA is permissive so the call can never be rejected for being
      // too big; the limit is applied here, where a too-large request becomes
      // a note the model can act on rather than a dead tool call.
      const selected = projectIds.slice(0, 6);
      const rows = selected
        .map((id) => getProject(id))
        .filter((project): project is NonNullable<typeof project> => Boolean(project));

      if (rows.length === 0) {
        return {
          found: false,
          message: "None of those project ids exist in the verified project index.",
        };
      }

      const pick = (project: NonNullable<ReturnType<typeof getProject>>) => {
        switch (dimension) {
          case "stack":
            return { id: project.id, name: project.name, stack: project.stack };
          case "status":
            return {
              id: project.id,
              name: project.name,
              status: project.status,
              role: project.role,
              timeline: project.timeline,
            };
          case "features":
            return {
              id: project.id,
              name: project.name,
              features: project.features,
              highlights: project.highlights,
            };
          case "metrics":
            return { id: project.id, name: project.name, metrics: project.metrics };
          case "caveats":
            return {
              id: project.id,
              name: project.name,
              caveats: project.caveats,
              status: project.status,
            };
          case "summary":
            return {
              id: project.id,
              name: project.name,
              tagline: project.tagline,
              summary: project.summary,
              status: project.status,
            };
          default:
            return {
              id: project.id,
              name: project.name,
              tagline: project.tagline,
              status: project.status,
              stack: project.stack,
              highlights: project.highlights,
              metrics: project.metrics,
              caveats: project.caveats,
            };
        }
      };

      return { found: true, dimension: dimension ?? "everything", projects: rows.map(pick) };
    },
  });

  const renderVisualTool = tool({
    description:
      "Declare the structured result of the answer. Call this EXACTLY ONCE, at the very end, in the same message as the answer text. It carries the visual spec, the evidence you used, the follow-up questions, your confidence and your caveats.",
    inputSchema: RENDER_INPUT,
    execute: async (input: z.infer<typeof RENDER_INPUT>) => {
      note("render_visual", { spec: input.spec });

      const spec = parseVisualSpec(input.spec);

      const evidence = input.evidence
        .map((item) => ({
          projectId: (item.projectId ?? "").trim(),
          path: (item.path ?? "").trim(),
          startLine: Number(item.startLine ?? 0),
          endLine: Number(item.endLine ?? 0),
          symbol: item.symbol?.trim() || undefined,
        }))
        .filter(
          (item) =>
            item.projectId.length > 0 &&
            item.path.length > 0 &&
            Number.isInteger(item.startLine) &&
            Number.isInteger(item.endLine) &&
            item.startLine >= 1 &&
            item.endLine >= item.startLine,
        );

      const followUps = input.followUps
        .map((item) => item.trim().slice(0, 140))
        .filter((item) => item.length >= 3)
        .slice(0, 3);

      const confidenceRaw = input.confidence.trim().toLowerCase();
      const confidence: "high" | "medium" | "low" =
        confidenceRaw === "high" || confidenceRaw === "low"
          ? confidenceRaw
          : "medium";

      // Two caveats, one short line each. The model is told this in the
      // prompt; the clamp is here so a verbose model cannot turn the
      // declaration into a second essay (and blow the output cap).
      const caveats = input.caveats
        .map((item) => item.trim().slice(0, 200))
        .filter((item) => item.length >= 3)
        .slice(0, 2);

      state.declaration = {
        spec,
        evidence,
        followUps,
        confidence,
        caveats,
      };

      if (!spec) {
        return {
          accepted: false,
          message:
            "That visual spec is not one of the twelve known kinds. The client will show an honest 'no visual' card instead. Use one of: profile, education, skills, project, architecture, flow, data-model, code, comparison, metrics, claims, contact.",
        };
      }

      return {
        accepted: true,
        spec,
        evidenceCount: evidence.length,
        note: "The server now validates every citation against the index.",
      };
    },
  });

  return {
    get_profile: getProfileTool,
    get_project: getProjectTool,
    get_architecture: getArchitectureTool,
    get_data_model: getDataModelTool,
    search_code: searchCodeTool,
    read_file: readFileTool,
    find_symbol: findSymbolTool,
    get_metrics: getMetricsTool,
    get_assets: getAssetsTool,
    get_claim: getClaimTool,
    compare_projects: compareProjectsTool,
    render_visual: renderVisualTool,
  };
}

/** The names of the twelve tools, in a stable order. */
export const TOOL_NAMES = [
  "get_profile",
  "get_project",
  "get_architecture",
  "get_data_model",
  "search_code",
  "read_file",
  "find_symbol",
  "get_metrics",
  "get_assets",
  "get_claim",
  "compare_projects",
  "render_visual",
] as const;
