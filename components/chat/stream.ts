"use client";

/**
 * A tiny hand-rolled reader for the AI SDK UI message stream.
 *
 * WHY NOT `useChat`
 * -----------------
 * `useChat` from `@ai-sdk/react` owns the message state: it keeps its own
 * `UIMessage[]`, it decides the shape of a message, and it renders parts
 * rather than text. The existing `Message.tsx` and `VisualRenderer.tsx`
 * components in this repo take a `ChatMessage` (a flat record with a `text`
 * string, a `visual` spec and an `evidence` list) and render it with the
 * `motion` transitions that the hero -> thread morph depends on. Migrating
 * to `useChat` would mean rewriting both of them, which is exactly the
 * change the brief says to avoid.
 *
 * So the client keeps its own `messages` state and reads the SSE stream
 * directly. The wire format is the documented UI message stream protocol:
 *
 *   data: {"type":"text-delta","id":"0","delta":"Hello"}
 *   data: {"type":"data-visual","data":{...}}
 *   data: [DONE]
 *
 * The parser is deliberately tolerant: an unknown chunk type is ignored, a
 * malformed JSON frame is skipped, and a missing body is an error the caller
 * can fall back from.
 */

import type { VisualSpec } from "@/lib/types/chat";

/** The payload of the server's `data-visual` part. */
export type VisualPayload = {
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
  mode: "retrieval" | "claims-only";
  droppedCitations: number;
};

/** The callbacks the reader drives. */
export type StreamHandlers = {
  /** A chunk of answer text arrived. */
  onTextDelta: (delta: string) => void;
  /** The validated visual + evidence arrived. */
  onVisual: (payload: VisualPayload) => void;
  /** The server reported an error inside the stream. */
  onError: (message: string) => void;
};

/**
 * Pull the `data:` payload out of one SSE event.
 *
 * @returns the raw JSON text, or `null` when the event carries no data.
 */
function eventPayload(raw: string): string | null {
  const lines = raw.split("\n");
  const data: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (data.length === 0) return null;
  const joined = data.join("\n").trim();
  if (!joined || joined === "[DONE]") return null;
  return joined;
}

/** Dispatch one SSE event. */
function handleEvent(raw: string, handlers: StreamHandlers): void {
  const payload = eventPayload(raw);
  if (!payload) return;

  let chunk: { type?: string; delta?: unknown; data?: unknown; errorText?: unknown };
  try {
    chunk = JSON.parse(payload) as typeof chunk;
  } catch {
    return; // a malformed frame must not kill the stream
  }

  switch (chunk.type) {
    case "text-delta": {
      const delta = typeof chunk.delta === "string" ? chunk.delta : "";
      if (delta) handlers.onTextDelta(delta);
      return;
    }
    case "data-visual": {
      const data = chunk.data as VisualPayload | undefined;
      if (data && typeof data === "object") handlers.onVisual(data);
      return;
    }
    case "error": {
      handlers.onError(
        typeof chunk.errorText === "string"
          ? chunk.errorText
          : "The answer stream reported an error.",
      );
      return;
    }
    default:
      // start / text-start / text-end / finish / tool parts are not needed
      // by this client.
      return;
  }
}

/**
 * Read a chat response and dispatch its parts.
 *
 * @throws when the response has no readable body.
 */
export async function readChatStream(
  response: Response,
  handlers: StreamHandlers,
): Promise<void> {
  if (!response.body) {
    throw new Error("The response had no body to stream.");
  }

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
      handleEvent(raw, handlers);
      boundary = buffer.indexOf("\n\n");
    }
  }

  // A last event that was not terminated by a blank line.
  if (buffer.trim()) handleEvent(buffer, handlers);
}
