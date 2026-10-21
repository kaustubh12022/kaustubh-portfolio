import "server-only";

/**
 * POST /api/chat
 *
 * The conversational portfolio's answer endpoint.
 *
 * WHAT HAPPENS HERE
 * -----------------
 *   1. Rate limit (per IP, in memory, 10 requests / 5 minutes).
 *   2. Read the conversation, cap the input, keep the last N turns.
 *   2b. Answer cache: an identical question against the same index is
 *       answered from memory. This is the largest cost saving in the
 *       system - see `lib/ai/cache.ts` for the measurement behind it.
 *   3. Run `streamText` with the twelve read-only tools, at most 4 steps.
 *   4. Stream the answer text to the browser as the model writes it.
 *   5. When the model finishes, validate every citation it declared against
 *      the index, downgrade the confidence if a citation did not resolve, and
 *      emit the validated visual + evidence as a `data-visual` part.
 *   6. Log the three-rate cost into `answer_log`.
 *
 * THE ORDER MATTERS
 * ------------------
 * The citation check happens AFTER the text, on purpose: the reader gets the
 * answer immediately, and the honesty gate still decides which citations
 * survive. A citation that does not resolve is dropped, the confidence drops
 * with it, and the client is told how many were dropped.
 *
 * NOTHING IN THIS FILE CAN 500
 * ----------------------------
 * The embedding model may be unavailable, the database may hiccup, the model
 * provider may be down. Every one of those is turned into a normal answer
 * with an honest caveat, never into an error status.
 */

import { deepseek } from "@ai-sdk/deepseek";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";

import {
  downgradeConfidence,
  validateEvidence,
} from "@/lib/ai/citations";
import { cacheKey, readCache, writeCache } from "@/lib/ai/cache";
import { computeCost, logAnswer, readTokenUsage } from "@/lib/ai/cost";
import { getProjects } from "@/lib/content/load";
import { SYSTEM_PROMPT } from "@/lib/ai/prompt";
import { isOverDailySpendCeiling, recordSpend } from "@/lib/ai/spend";
import {
  checkRateLimit,
  clientKey,
  pruneRateLimitBuckets,
  RATE_LIMIT_MAX,
} from "@/lib/ai/ratelimit";
import {
  createToolState,
  createTools,
  type ToolState,
} from "@/lib/ai/tools";
import type { EvidenceRef, VisualSpec } from "@/lib/types/chat";

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

/**
 * `deepseek-flash` is the cheap tier: $0.003/M on a cache hit against
 * $0.15/M on a miss, $0.60/M for the completion, 1M tokens of context.
 * `deepseek-v4-pro` exists but costs 50x more on a cache miss.
 */
export const MODEL_ID = "deepseek-flash";

/** The maximum number of characters accepted from ONE message. */
export const MAX_INPUT_CHARS = 500;

/**
 * The maximum number of output tokens PER MODEL STEP.
 *
 * This was 700. It was raised to 1400 for a measured reason.
 *
 * A tool-calling step has to carry TWO things in one completion: the answer
 * prose AND the `render_visual` call. Measured in production traffic at 700:
 *
 *   - a 160 word answer is ~230 tokens,
 *   - the `render_visual` payload is ~120 tokens for a spec plus three
 *     citations, but ~350 tokens when the model writes two long caveats,
 *   - and the model pads the caveats with prose it does not need.
 *
 * At 700 the completion was cut off MID-JSON. The provider then rejects the
 * tool call with `AI_InvalidToolInputError: Unterminated string in JSON`,
 * which is UNRECOVERABLE: the model never sees a tool result, the structured
 * declaration is lost, and the answer ships with no visual and no citations.
 * That is the single worst failure mode in this pipeline, and it was firing
 * on roughly one request in fifteen.
 *
 * 1400 fits the prose plus the declaration with room to spare. The cost
 * impact is bounded: output tokens are $0.60/M, so 700 extra tokens on the
 * final step is $0.00042 - less than a tenth of the request's total.
 */
export const MAX_OUTPUT_TOKENS = 1400;

/** The maximum number of model steps (tool loop iterations). */
export const MAX_STEPS = 4;

/**
 * How many steps the model may spend exploring before it has to answer.
 *
 * After this, the four code-exploration tools are removed from the schema,
 * so the model has to write the answer instead of collecting more code.
 */
export const MAX_EXPLORATION_STEPS = 2;

/**
 * The tools that stay available in the final step.
 *
 * The cheap content-layer tools and the claim ledger stay (a few hundred
 * bytes each, and the prompt cache almost always hits them). The four
 * code-exploration tools go: they pull large source payloads, they are
 * uncacheable, and they are what turns an answer into a five-minute crawl.
 */
export const FINAL_STEP_TOOLS = [
  "get_claim",
  "get_profile",
  "get_project",
  "get_architecture",
  "get_metrics",
  "get_assets",
  "compare_projects",
  "render_visual",
] as const;

/** How many past turns are sent to the model. */
export const MAX_HISTORY_MESSAGES = 12;

/** Next.js: this route always runs on Node (it needs `pg` and ONNX). */
export const runtime = "nodejs";

/** The platform is allowed 60 seconds for one answer. */
export const maxDuration = 60;

/** The route reads a request body, so it can never be prerendered. */
export const dynamic = "force-dynamic";

/* ------------------------------------------------------------------ */
/* Request parsing                                                     */
/* ------------------------------------------------------------------ */

type IncomingMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

/**
 * Pull the conversation out of the request body.
 *
 * The AI SDK UI message shape is accepted (`parts: [{type:'text',text}]`),
 * and so is the flatter `{role, text}` shape. Anything else is ignored:
 * the input is untrusted.
 */
function extractMessages(body: unknown): IncomingMessage[] {
  if (!body || typeof body !== "object") return [];
  const raw = (body as { messages?: unknown }).messages;
  if (!Array.isArray(raw)) return [];

  const out: IncomingMessage[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as {
      id?: unknown;
      role?: unknown;
      text?: unknown;
      parts?: unknown;
    };

    const role =
      record.role === "assistant"
        ? "assistant"
        : record.role === "user"
          ? "user"
          : null;
    if (!role) continue;

    let text = typeof record.text === "string" ? record.text : "";
    if (!text && Array.isArray(record.parts)) {
      text = record.parts
        .map((part) => {
          if (!part || typeof part !== "object") return "";
          const candidate = part as { type?: unknown; text?: unknown };
          if (candidate.type !== "text" || typeof candidate.text !== "string") {
            return "";
          }
          return candidate.text;
        })
        .filter(Boolean)
        .join("\n");
    }

    text = text.trim();
    if (!text) continue;

    out.push({
      id: typeof record.id === "string" && record.id ? record.id : `m${out.length}`,
      role,
      text,
    });
  }
  return out;
}

/** Truncate a message to the input cap. */
function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_INPUT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_INPUT_CHARS), truncated: true };
}

/* ------------------------------------------------------------------ */
/* The daily spend ceiling                                             */
/* ------------------------------------------------------------------ */

/**
 * The spend ledger lives in `lib/ai/spend.ts` so the health endpoint can
 * report the same number without importing a route file. The ceiling is
 * checked before the model is called; see `docs/COST_POLICY.md` for the
 * measurement that motivated it.
 */

/* ------------------------------------------------------------------ */
/* The structured result                                               */
/* ------------------------------------------------------------------ */

/** The payload of the `data-visual` part. */
type VisualPayload = {
  visual: VisualSpec | null;
  evidence: Array<{
    label: string;
    projectId: string;
    path: string;
    startLine: number;
    endLine: number;
    symbol?: string;
  }>;
  followUps: string[];
  confidence: "high" | "medium" | "low";
  caveats: string[];
  /** `claims-only` when the source index could not be reached. */
  mode: "retrieval" | "claims-only";
  /** How many citations the model asked for that did not resolve. */
  droppedCitations: number;
};

/* ------------------------------------------------------------------ */
/* The route                                                           */
/* ------------------------------------------------------------------ */

// The bucket map grows with every unique IP; prune it periodically.
const pruneTimer = setInterval(pruneRateLimitBuckets, 60_000);
pruneTimer.unref?.();

/**
 * Stop the loop once the answer is COMPLETE.
 *
 * A step counts as the end of the answer when it both declared the
 * structured result (`render_visual`) and produced prose. A step that only
 * declared the result - the model called the tool before it wrote anything
 * - does not stop the loop: the next step has to write the answer.
 */
function isAnswerComplete(steps: Array<{
  text: string;
  toolCalls: Array<{ toolName: string }>;
}>): boolean {
  const last = steps[steps.length - 1];
  if (!last) return false;
  const declared = last.toolCalls.some(
    (call) => call.toolName === "render_visual",
  );
  if (!declared) return false;
  return last.text.trim().length > 0;
}

export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();

  // 1. Rate limit ------------------------------------------------------
  const limit = checkRateLimit(clientKey(request));
  if (!limit.allowed) {
    return Response.json(
      {
        error:
          "Too many questions. The assistant is rate limited to a handful of requests per minute so it stays fast for everyone.",
      },
      {
        status: 429,
        headers: {
          "retry-after": String(limit.retryAfterSeconds),
          "x-ratelimit-limit": String(RATE_LIMIT_MAX),
          "x-ratelimit-remaining": "0",
        },
      },
    );
  }

  // 2. Read the conversation -------------------------------------------
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "The request body must be JSON." },
      { status: 400 },
    );
  }

  const incoming = extractMessages(body);
  if (incoming.length === 0) {
    return Response.json(
      { error: "Send at least one non-empty user message." },
      { status: 400 },
    );
  }

  // Only the turns up to the last user message matter.
  let lastUserIndex = -1;
  for (let index = incoming.length - 1; index >= 0; index -= 1) {
    if (incoming[index].role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  if (lastUserIndex === -1) {
    return Response.json(
      { error: "The last message must come from the user." },
      { status: 400 },
    );
  }

  const window = incoming.slice(
    Math.max(0, lastUserIndex - (MAX_HISTORY_MESSAGES - 1)),
    lastUserIndex + 1,
  );

  let truncated = false;
  const capped = window.map((message) => {
    const result = capText(message.text);
    if (result.truncated) truncated = true;
    return { ...message, text: result.text };
  });

  const question = capped[capped.length - 1]?.text ?? "";

  // 3. The answer cache --------------------------------------------------
  //
  // The same question against the same index produces the same grounded
  // answer, so it is served from memory instead of paying for the model
  // again. Measured on this deployment, repeating one question nine times
  // cost $0.018 - this line removes that.
  const cacheId = cacheKey(
    question,
    capped.slice(0, -1).map((message) => ({
      role: message.role,
      text: message.text,
    })),
  );
  const cached = readCache(cacheId);
  const replay = cached ? replayCachedAnswer(cached) : null;
  if (replay) {
    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        async execute({ writer }) {
          writer.write({ type: "start" });
          writer.write({ type: "text-start", id: "0" });
          writer.write({ type: "text-delta", id: "0", delta: replay.text });
          writer.write({ type: "text-end", id: "0" });
          writer.write({ type: "data-visual", data: replay.payload });
        },
      }),
      headers: {
        "x-ratelimit-limit": String(RATE_LIMIT_MAX),
        "x-ratelimit-remaining": String(limit.remaining),
        "x-cache": "HIT",
        "cache-control": "no-store",
      },
    });
  }

  // 3b. The daily spend ceiling ------------------------------------------
  //
  // When the day's budget is gone, the model is not called at all. The
  // answer comes from the verified content layer, and it says plainly that
  // the assistant is running in its reduced mode. A portfolio that says "I
  // am out of budget" is more useful than one that returns a 500.
  if (isOverDailySpendCeiling()) {
    const fallback = buildBudgetFallback(question);
    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        async execute({ writer }) {
          writer.write({ type: "start" });
          writer.write({ type: "text-start", id: "0" });
          writer.write({ type: "text-delta", id: "0", delta: fallback.text });
          writer.write({ type: "text-end", id: "0" });
          writer.write({ type: "data-visual", data: fallback.payload });
        },
      }),
      headers: {
        "x-ratelimit-limit": String(RATE_LIMIT_MAX),
        "x-ratelimit-remaining": String(limit.remaining),
        "x-cache": "BUDGET",
        "cache-control": "no-store",
      },
    });
  }

  const modelMessages = await convertToModelMessages(
    capped.map((message) => ({
      id: message.id,
      role: message.role,
      parts: [{ type: "text" as const, text: message.text }],
    })) as Array<Omit<UIMessage, "id">>,
  );

  // 3. The tools --------------------------------------------------------
  const state: ToolState = createToolState();
  const tools = createTools(state);

  // 4. The model --------------------------------------------------------
  let firstTokenAt: number | null = null;

  const result = streamText({
    model: deepseek(MODEL_ID),
    instructions: SYSTEM_PROMPT,
    messages: modelMessages,
    tools,
    stopWhen: [
      isStepCount(MAX_STEPS),
      // The structured result is the last thing the model does. Stopping the
      // moment it is declared AND the answer has been written stops the loop
      // from spending another step (and another model call) on a reply
      // nobody asked for.
      ({ steps }) => isAnswerComplete(steps),
    ],
    /**
     * THE STEP BUDGET
     * ---------------
     * The model gets two exploration steps and then it has to answer.
     *
     * Without this, a model that likes to look at things can spend every one
     * of the four steps on tool calls and never write a single word - the
     * answer is then empty and the visitor gets nothing.
     *
     * WHY THE CHEAP TOOLS STAY AVAILABLE
     * ---------------------------------
     * An earlier version restricted the final step to `render_visual` ALONE.
     * That is a trap: the model still reaches for `get_claim` or
     * `read_file`, the provider rejects the call with
     * `AI_NoSuchToolError`, and the step is burned on an error the model
     * cannot recover from. Production traffic showed exactly that.
     *
     * So the final step keeps the tools that are cheap and fast - the
     * content layer and the claim ledger, which are a few hundred bytes each
     * and are almost always cache hits - and drops only the four tools that
     * pull megabytes of source code and burn the clock:
     * `search_code`, `read_file`, `find_symbol` and `get_data_model`.
     */
    prepareStep: ({ stepNumber }) => {
      if (stepNumber >= MAX_EXPLORATION_STEPS) {
        return { activeTools: [...FINAL_STEP_TOOLS] };
      }
      return {};
    },
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    providerOptions: {
      deepseek: {
        // Thinking mode is ON by default for the V4 models. It doubles the
        // output tokens (they are billed as completion tokens) and adds
        // seconds of latency before the first word, which is the wrong trade
        // for a grounded, retrieval-first assistant.
        thinking: { type: "disabled" },
      },
    },
    onChunk({ chunk }) {
      if (firstTokenAt === null && chunk.type === "text-delta") {
        firstTokenAt = Date.now();
      }
    },
    onError({ error }) {
      console.warn("[ai] model stream error:", error);
    },
  });

  // 5. The stream -------------------------------------------------------
  const stream = createUIMessageStream({
    async execute({ writer }) {
      // The outer stream owns the assistant message lifecycle.
      writer.write({ type: "start" });

      writer.merge(
        toUIMessageStream({
          stream: result.stream,
          sendStart: false,
          sendReasoning: false,
          onError: (error) => {
            console.warn("[ai] stream error:", error);
            return "A tool call was rejected. The answer below may be incomplete.";
          },
        }),
      );

      // Wait for the model run to finish, then publish the validated result.
      await Promise.resolve(result.finishReason).catch(() => undefined);

      const payload = await buildPayload(state, {
        truncated,
        retrievalUnavailable: state.retrievalUnavailable,
      });

      writer.write({ type: "data-visual", data: payload });

      // 5b. Store the answer in the cache ----------------------------------
      //
      // Only a COMPLETE answer is cached. A truncated or degraded answer
      // must not be replayed to the next visitor as if it were a good one.
      const answerText = await Promise.resolve(result.text).catch(() => "");
      if (answerText.trim() && payload.confidence !== "low") {
        writeCache(cacheId, JSON.stringify({ text: answerText, payload }));
      }

      // 6. The cost --------------------------------------------------------
      await logCost(result, {
        state,
        question,
        startedAt,
        firstTokenAt,
        confidence: payload.confidence,
        citations: payload.evidence.length,
      });
    },
    onError: (error) => {
      console.error("[ai] ui message stream error:", error);
      return "Something went wrong while producing the answer.";
    },
  });

  return createUIMessageStreamResponse({
    stream,
    headers: {
      "x-ratelimit-limit": String(RATE_LIMIT_MAX),
      "x-ratelimit-remaining": String(limit.remaining),
      "cache-control": "no-store",
    },
  });
}

/* ------------------------------------------------------------------ */
/* The validated result                                                */
/* ------------------------------------------------------------------ */

/**
 * Answer without the model when the daily budget is exhausted.
 *
 * This path costs nothing: it reads the verified content layer, matches the
 * question against the project list, and returns an honest summary with the
 * real links. It never invents an answer, and it always says that the
 * assistant is in its reduced mode so the reader knows why the answer is
 * thinner than usual.
 */
function buildBudgetFallback(question: string): {
  text: string;
  payload: VisualPayload;
} {
  const lower = question.toLowerCase();
  const projects = getProjects();

  const match = projects.find((project) =>
    lower.includes(project.name.toLowerCase()) ||
    lower.includes(project.id.toLowerCase()),
  );

  const text = match
    ? `I am running in reduced mode right now: the assistant's daily model budget is used up, so I am answering from the verified content layer instead of the live model. ` +
      `**${match.name}** — ${match.tagline}. ${match.summary}\n\n` +
      `The repository is public: ${match.repo ?? "see the project index"}.\n\n` +
      (match.caveats.length
        ? `What it does not do: ${match.caveats.join(" ")}\n\n`
        : "") +
      `Browse the full project page for the screenshots, the measured numbers and the source paths.`
    : `I am running in reduced mode right now: the assistant's daily model budget is used up, so I am answering from the verified content layer instead of the live model.\n\n` +
      `The portfolio covers ${projects.length} audited projects. ` +
      `Ask about one by name - ${projects
        .map((project) => project.name)
        .join(", ")} - or browse the project index for the source code, the measured numbers and the caveats.`;

  return {
    text,
    payload: {
      visual: match ? { kind: "project", projectId: match.id } : { kind: "profile" },
      evidence: [],
      followUps: ["Browse the project index", "What can you prove with numbers?"],
      confidence: "low",
      caveats: [
        "The assistant is in reduced mode: the daily model budget is exhausted, so this answer comes from the verified content layer and the source code was not checked for this question.",
      ],
      mode: "claims-only",
      droppedCitations: 0,
    },
  };
}

/**
 * Rehydrate a cached answer for replay.
 *
 * A malformed cache entry is discarded rather than served: a cache that can
 * crash the endpoint is worse than no cache. `null` means "do not replay
 * this", and the caller falls through to a fresh answer.
 */
function replayCachedAnswer(raw: string): {
  text: string;
  payload: VisualPayload;
} | null {
  try {
    const parsed = JSON.parse(raw) as { text?: unknown; payload?: unknown };
    const text = typeof parsed.text === "string" ? parsed.text : "";
    const payload = parsed.payload as VisualPayload | undefined;
    if (!text.trim() || !payload || typeof payload !== "object") {
      return null;
    }
    return { text, payload };
  } catch {
    return null;
  }
}

/**
 * Derive a visual from the tools the model actually called.
 *
 * This is the fallback for the case where the model writes a good answer but
 * forgets the `render_visual` call. The visual is derived from what the
 * model DID (it asked for the architecture of "smartapply", so the
 * architecture card of "smartapply" is the honest card), never invented.
 */
function deriveFallbackVisual(state: ToolState): VisualSpec | null {
  for (let index = state.calls.length - 1; index >= 0; index -= 1) {
    const call = state.calls[index];
    if (!call) continue;

    if (call.tool === "get_architecture") {
      const projectId = call.input.projectId;
      if (typeof projectId === "string") {
        return { kind: "architecture", projectId };
      }
    }
    if (call.tool === "get_data_model") {
      const projectId = call.input.projectId;
      if (typeof projectId === "string") {
        return { kind: "data-model", projectId };
      }
    }
    if (call.tool === "get_project") {
      const id = call.input.id;
      if (typeof id === "string") return { kind: "project", projectId: id };
    }
    if (call.tool === "get_claim") {
      const id = call.input.id;
      if (typeof id === "string") return { kind: "claims", claimIds: [id] };
    }
    if (call.tool === "compare_projects") {
      const ids = call.input.projectIds;
      if (Array.isArray(ids) && ids.length >= 2) {
        const projectIds = ids.filter(
          (item): item is string => typeof item === "string",
        );
        if (projectIds.length >= 2) {
          return { kind: "comparison", projectIds: projectIds.slice(0, 4) };
        }
      }
    }
    if (call.tool === "get_metrics") {
      const projectId = call.input.projectId;
      return typeof projectId === "string"
        ? { kind: "metrics", projectId }
        : { kind: "metrics" };
    }
    if (call.tool === "get_profile") {
      return { kind: "profile" };
    }
  }
  return null;
}

/**
 * The chunks the model actually read, as citations.
 *
 * These are verified by construction: the server read them out of the index
 * and handed them to the model. They are only used when the model did not
 * declare its own citations.
 */
function servedEvidence(state: ToolState): VisualPayload["evidence"] {
  const out: VisualPayload["evidence"] = [];
  for (const chunk of state.served.values()) {
    out.push({
      label:
        chunk.startLine === chunk.endLine
          ? `${chunk.path}:${chunk.startLine}`
          : `${chunk.path}:${chunk.startLine}-${chunk.endLine}`,
      projectId: chunk.projectId,
      path: chunk.path,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      symbol: chunk.symbol || undefined,
    });
    if (out.length >= 3) break;
  }
  return out;
}

/**
 * Was a citation range actually opened during this answer?
 *
 * The server records every chunk it hands to the model. A citation that
 * points outside that set still resolves in the index, but the assistant
 * did not read it - which is worth telling the reader.
 */
function wasServed(state: ToolState, ref: EvidenceRef): boolean {
  for (const chunk of state.served.values()) {
    if (chunk.projectId !== ref.projectId) continue;
    if (chunk.path !== ref.path) continue;
    if (chunk.startLine <= ref.startLine && chunk.endLine >= ref.endLine) {
      return true;
    }
  }
  return false;
}

/**
 * Turn the model's declaration into a validated, honest payload.
 *
 * The citations the model asked for are re-read from the index. One that
 * does not resolve is dropped, the confidence is downgraded, and the reader
 * is told how many were dropped.
 */
async function buildPayload(
  state: ToolState,
  context: { truncated: boolean; retrievalUnavailable: boolean },
): Promise<VisualPayload> {
  const declaration = state.declaration;

  const visual = (declaration?.spec ??
    deriveFallbackVisual(state)) as VisualSpec | null;

  const caveats: string[] = [...(declaration?.caveats ?? [])];

  let confidence: "high" | "medium" | "low" = declaration?.confidence ?? "low";
  let evidence: VisualPayload["evidence"] = [];
  let droppedCitations = 0;

  if (declaration && declaration.evidence.length > 0) {
    // The citations are validated as the model wrote them.
    //
    // There is deliberately NO quote auto-fill here. An earlier version
    // filled a missing quote from the server's own copy of the chunk it had
    // served - and that copy is the CLIPPED text (the model only ever sees
    // the first 2200 characters of a chunk), while the validator compares
    // against the FULL indexed chunk. Every citation to a chunk larger than
    // the clip limit therefore failed the exact-match test and was dropped,
    // which is what the production log showed.
    //
    // The index-resolution rule (the range really exists in the indexed
    // source) is the gate. A quote the model supplies itself is still
    // checked, exactly, when it supplies one.
    const candidates: EvidenceRef[] = declaration.evidence.map((ref) => ({
      projectId: ref.projectId,
      path: ref.path,
      startLine: ref.startLine,
      endLine: ref.endLine,
      symbol: ref.symbol,
      label: "",
      verified: false,
      ...(ref.quote && ref.quote.trim().length > 0
        ? { quote: ref.quote }
        : {}),
    }));

    const validation = await validateEvidence(candidates);
    evidence = validation.verified.map((ref) => ({
      label: ref.label,
      projectId: ref.projectId,
      path: ref.path,
      startLine: ref.startLine,
      endLine: ref.endLine,
      symbol: ref.symbol,
    }));
    droppedCitations = validation.rejected.length;
    confidence = downgradeConfidence(confidence, droppedCitations);

    if (droppedCitations > 0) {
      console.warn(
        "[ai] dropped citations:",
        JSON.stringify(
          validation.rejected.map((ref) => ({
            projectId: ref.projectId,
            path: ref.path,
            startLine: ref.startLine,
            endLine: ref.endLine,
            hasQuote: Boolean(ref.quote),
          })),
        ),
      );
      caveats.push(
        `${droppedCitations} citation${
          droppedCitations === 1 ? "" : "s"
        } could not be verified against the source index and ${
          droppedCitations === 1 ? "was" : "were"
        } dropped.`,
      );
    }

    // PROVENANCE: a citation can resolve in the index and still point at
    // lines this answer never opened. That is not a rejection - the line
    // really exists and a reader can check it - but it is worth saying.
    const unread = validation.verified.filter(
      (ref) => !wasServed(state, ref),
    );
    if (unread.length > 0) {
      console.warn(
        "[ai] citations that were not read in this answer:",
        JSON.stringify(
          unread.map((ref) => ({
            projectId: ref.projectId,
            path: ref.path,
            startLine: ref.startLine,
            endLine: ref.endLine,
          })),
        ),
      );
      caveats.push(
        `${unread.length} citation${
          unread.length === 1 ? "" : "s"
        } point at source lines that were not opened in this answer; they resolve in the index, but the assistant did not read them.`,
      );
    }
  } else if (state.served.size > 0) {
    // The model did not declare citations. The chunks it actually read are
    // still evidence, and they are verified by construction.
    evidence = servedEvidence(state);
    caveats.push(
      "The assistant did not return its own citation list; the sources shown are the ones it actually read.",
    );
  }

  if (context.retrievalUnavailable) {
    caveats.push(
      "The source index was unavailable for this answer, so it is based on the claim ledger and the verified content only - the code was not checked.",
    );
    confidence = downgradeConfidence(confidence, 1);
  }

  if (context.truncated) {
    caveats.push(
      `The question was longer than ${MAX_INPUT_CHARS} characters and was truncated.`,
    );
  }

  if (!declaration) {
    caveats.push(
      "The assistant did not return a structured result for this answer, so the visual and the citations were derived from the tools it used.",
    );
  }

  return {
    visual,
    evidence,
    followUps: (declaration?.followUps ?? []).slice(0, 3),
    confidence,
    caveats: caveats.slice(0, 8),
    mode: context.retrievalUnavailable ? "claims-only" : "retrieval",
    droppedCitations,
  };
}

/* ------------------------------------------------------------------ */
/* The cost log                                                        */
/* ------------------------------------------------------------------ */

async function logCost(
  result: { usage: PromiseLike<unknown> },
  context: {
    state: ToolState;
    question: string;
    startedAt: number;
    firstTokenAt: number | null;
    confidence: string;
    citations: number;
  },
): Promise<void> {
  try {
    const usage = await result.usage;
    const tokens = readTokenUsage(usage);
    const cost = computeCost(tokens);
    const latencyMs = Date.now() - context.startedAt;

    // The in-process daily ceiling is fed by the real cost of every request.
    recordSpend(cost.totalCost);

    await logAnswer({
      question: context.question,
      intent: "",
      model: MODEL_ID,
      toolSteps: context.state.toolCalls,
      citations: context.citations,
      confidence: context.confidence,
      cacheHitTokens: tokens.cacheHitTokens,
      cacheMissTokens: tokens.cacheMissTokens,
      completionTokens: tokens.completionTokens,
      costUsd: cost.totalCost,
      latencyMs,
      firstTokenMs:
        context.firstTokenAt === null
          ? latencyMs
          : context.firstTokenAt - context.startedAt,
    });

    console.info(
      `[ai] ${MODEL_ID} ${tokens.cacheHitTokens} cache-hit + ` +
        `${tokens.cacheMissTokens} cache-miss + ${tokens.completionTokens} output tokens ` +
        `= $${cost.totalCost.toFixed(6)} (${latencyMs}ms, first token ${
          context.firstTokenAt === null
            ? "n/a"
            : `${context.firstTokenAt - context.startedAt}ms`
        })`,
    );
  } catch (error) {
    console.warn("[ai] could not price the request:", (error as Error).message);
  }
}
