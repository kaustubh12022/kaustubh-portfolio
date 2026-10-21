import type { Page } from "@playwright/test";

/**
 * A zero-cost stub of the portfolio's `/api/chat` route.
 *
 * WHY THIS EXISTS
 * ---------------
 * The real route calls DeepSeek. A test suite must never spend money, and
 * a test that depends on a model's mood is a test that fails on a Tuesday.
 * So the chat route is replaced by a canned UI MESSAGE STREAM: the exact
 * `data: {json}` frames the real route emits, delivered through a real
 * `ReadableStream` so the app's own stream reader is exercised end to end.
 *
 * The suite therefore proves the CLIENT: streaming, the visual card, the
 * citation chip, the conversation context. The MODEL is measured by
 * `scripts/eval/golden-eval.ts`, which is where the money is (and where it
 * is accounted for).
 */

/** One citation, in the shape the route's `data-visual` part carries. */
export type MockEvidence = {
  label: string;
  projectId: string;
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
};

/** The `data-visual` payload the route emits. */
export type MockVisualPayload = {
  visual: Record<string, unknown> | null;
  evidence: MockEvidence[];
  followUps: string[];
  confidence: "high" | "medium" | "low";
  caveats: string[];
  mode: "retrieval" | "claims-only";
  droppedCitations: number;
};

/** One message of the conversation the client sent. */
export type MockChatMessage = {
  id?: string;
  role: string;
  parts: Array<{ type: string; text?: string }>;
};

/** One request the client made to `/api/chat`. */
export type MockChatRequest = {
  messages: MockChatMessage[];
};

export type ChatMockOptions = {
  /**
   * The answer, one entry per streamed frame.
   *
   * More than one entry is how the suite proves the answer is STREAMED and
   * not painted in one go.
   */
  deltas: string[];
  /**
   * The answers of the FOLLOW-UP requests, in order.
   *
   * Without them every request gets the same answer, and the thread would
   * show the same sentence twice - which makes it impossible to tell a new
   * answer from the old one.
   */
  followUpDeltas?: string[];
  /** The `data-visual` payload. Omitted means "no visual". */
  payload?: MockVisualPayload;
  /** How long the stream pauses between two frames, in milliseconds. */
  delayMs?: number;
};

/** The window global the mock writes to. */
type ChatMockWindow = Window & {
  __chatRequests?: MockChatRequest[];
};

/**
 * Replace `window.fetch` so that `POST /api/chat` is answered locally.
 *
 * Must be called BEFORE the first navigation: it installs an init script,
 * so the override is in place before the app's own code runs.
 */
export async function installChatMock(
  page: Page,
  options: ChatMockOptions,
): Promise<void> {
  await page.addInitScript((opts: ChatMockOptions) => {
    const scope = window as ChatMockWindow;
    scope.__chatRequests = [];

    const originalFetch = window.fetch.bind(window);

    window.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;

      if (!url.includes("/api/chat")) {
        return originalFetch(input as RequestInfo, init);
      }

      let body: MockChatRequest = { messages: [] };
      try {
        body = init?.body
          ? (JSON.parse(String(init.body)) as MockChatRequest)
          : { messages: [] };
      } catch {
        body = { messages: [] };
      }
      scope.__chatRequests?.push(body);

      const requestIndex = (scope.__chatRequests?.length ?? 1) - 1;
      const deltas =
        requestIndex === 0
          ? opts.deltas
          : (opts.followUpDeltas?.[requestIndex - 1] ?? opts.deltas);

      const frames: string[] = [];
      for (const delta of deltas) {
        frames.push(
          `data: ${JSON.stringify({ type: "text-delta", id: "0", delta })}\n\n`,
        );
      }
      if (opts.payload) {
        frames.push(
          `data: ${JSON.stringify({ type: "data-visual", data: opts.payload })}\n\n`,
        );
      }
      frames.push("data: [DONE]\n\n");

      const encoder = new TextEncoder();
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (index >= frames.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(frames[index]));
          index += 1;
          await new Promise((resolve) =>
            setTimeout(resolve, opts.delayMs ?? 40),
          );
        },
      });

      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    }) as typeof window.fetch;
  }, options);
}

/** Every request the page made to `/api/chat`, in order. */
export async function chatRequests(page: Page): Promise<MockChatRequest[]> {
  return page.evaluate(() => {
    const scope = window as ChatMockWindow;
    return scope.__chatRequests ?? [];
  });
}

/** The text of one message of a captured request. */
export function messageText(message: MockChatMessage): string {
  return message.parts
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}
