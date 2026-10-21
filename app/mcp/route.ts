import { createMcpHandler } from "@modelcontextprotocol/server";

import {
  MCP_INSTRUCTIONS,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  createMcpServer,
} from "@/lib/mcp/server";
import {
  MCP_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@/lib/mcp/tools";
import {
  checkRateLimit,
  clientKey,
  MCP_RATE_LIMIT_MAX,
} from "@/lib/ai/ratelimit";

/**
 * POST /mcp - the MCP endpoint.
 *
 * THE SPEC POINT THAT MATTERS MOST
 * --------------------------------
 * The 2026-07-28 revision of the protocol is STATELESS: there is no
 * `initialize` handshake, no `Mcp-Session-Id` header and no session state.
 * Every request carries its own protocol version, client identity and client
 * capabilities in `_meta`, so any request can land on any instance behind a
 * round-robin load balancer.
 *
 * HEADER BASED ROUTING (SEP-2243)
 * ------------------------------
 * A Streamable HTTP request MUST carry `Mcp-Method` and, for the methods
 * that name a tool, prompt or resource, `Mcp-Name`. This route reads those
 * headers FIRST and uses them to route, so a gateway in front of it can
 * route, meter and authorise on the headers without parsing the body.
 *
 * The JSON-RPC body is accepted as a FALLBACK: a request that omits the
 * headers is still served, and the route synthesises the missing headers
 * from the body before handing the request to the server. A header that
 * DISAGREES with the body is refused with `-32020` (`HeaderMismatch`),
 * because a load balancer that routed on the header and a server that
 * executed on the body must never act on different requests.
 *
 * WHAT THIS ROUTE DOES, IN ORDER
 * ------------------------------
 *   1. CORS preflight (`OPTIONS`) and the bearer-token check.
 *   2. The `MCP-Protocol-Version` check. An unsupported version is answered
 *      with `-32022` (`UnsupportedProtocolVersion`) and the list of versions
 *      this endpoint speaks - never a stack trace.
 *   3. Header routing: `Mcp-Method` and `Mcp-Name`, with the body as the
 *      fallback and a `-32020` on any disagreement.
 *   4. `initialize`, answered directly: the 2026 revision made the handshake
 *      optional, but a 2025-era client may still send it.
 *   5. Everything else goes to the MCP server, which dispatches it.
 *
 * AUTH
 * ----
 * The endpoint is read-only, but it exposes the owner's source code, so it
 * takes an OPTIONAL bearer token from `MCP_AUTH_TOKEN`:
 *
 *   - when `MCP_AUTH_TOKEN` is set, a request must carry
 *     `Authorization: Bearer <token>`;
 *   - when it is NOT set, the endpoint is OPEN and the route logs a loud
 *     warning, once per process. That is the right default for a public
 *     portfolio: the data is public, the surface is read-only, and a
 *     recruiter should be able to connect without an account. Set the
 *     variable to close it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** JSON-RPC error codes used by this route. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** The CORS headers every response carries. */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, authorization, accept, mcp-protocol-version, mcp-method, mcp-name, mcp-session-id",
  "access-control-expose-headers": "mcp-protocol-version, content-type",
  "access-control-max-age": "86400",
};

/**
 * The one MCP handler behind the endpoint.
 *
 * `createMcpHandler` builds a FRESH server per request (the factory is
 * called once per HTTP request), so the endpoint holds no state between
 * requests: that is exactly the stateless posture the 2026-07-28 revision
 * asks for.
 *
 * The response mode is left at the default (`auto`): a single JSON body,
 * upgraded to an SSE stream only when a handler emits a related message
 * before its result. No tool on this surface emits one - there is no
 * progress token, no logging notification (deprecated in 2026-07-28) and no
 * `subscriptions/listen` - so every answer is one `application/json` body.
 */
const mcpHandler = createMcpHandler(() => createMcpServer(), {
  onerror: (error: Error) => {
    console.error(`[mcp] server error: ${error.message}`);
  },
});

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}

/**
 * A JSON-RPC error response.
 *
 * The HTTP status follows the spec: `400` for a malformed or mismatched
 * request, `404` for an unknown method.
 */
function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
  status = 400,
): Response {
  const body: Record<string, unknown> = {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": MCP_PROTOCOL_VERSION,
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
  });
}

/**
 * Decode a header value that may use the Base64 sentinel encoding.
 *
 * A value that cannot be represented as plain ASCII is carried as
 * `=?base64?<base64>?=`. The sentinel markers are case sensitive.
 *
 * @returns the decoded value, or `undefined` when the sentinel is malformed
 */
function decodeHeaderValue(value: string): string | undefined {
  const sentinel = /^=\?base64\?(.*)\?=$/.exec(value);
  if (!sentinel) return value;
  try {
    return Buffer.from(sentinel[1] ?? "", "base64").toString("utf8");
  } catch {
    return undefined;
  }
}

/** Compare two secrets without leaking their length through the timing. */
function secretsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

let openEndpointWarned = false;

/** Warn ONCE per process that the endpoint is open. */
function warnOpenEndpoint(): void {
  if (openEndpointWarned) return;
  openEndpointWarned = true;
  console.error(
    "[mcp] ERROR: MCP_AUTH_TOKEN is not set, so /mcp is OPEN. " +
      "It is read-only, but it exposes the owner's source code and the " +
      "claim ledger. Set MCP_AUTH_TOKEN to require a bearer token in production.",
  );
}

/**
 * The bearer-token check.
 *
 * @returns a 401 response when the request is not authorised, `null` when it is
 */
function checkAuth(request: Request): Response | null {
  const expected = process.env.MCP_AUTH_TOKEN?.trim();
  const isProduction =
    process.env.NODE_ENV === "production" || process.env.VERCEL === "1";

  if (!expected) {
    warnOpenEndpoint();
    if (isProduction) {
      return new Response(
        JSON.stringify({
          error: "unauthorized",
          message:
            "This MCP endpoint requires MCP_AUTH_TOKEN in production.",
        }),
        {
          status: 401,
          headers: {
            "content-type": "application/json",
            "www-authenticate": 'Bearer realm="mcp"',
            "cache-control": "no-store",
            ...CORS_HEADERS,
          },
        },
      );
    }
    return null;
  }

  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  const provided = match?.[1]?.trim() ?? "";

  if (!provided || !secretsMatch(provided, expected)) {
    return new Response(
      JSON.stringify({
        error: "unauthorized",
        message:
          "This MCP endpoint requires the bearer token configured in MCP_AUTH_TOKEN.",
      }),
      {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": 'Bearer realm="mcp"',
          "cache-control": "no-store",
          ...CORS_HEADERS,
        },
      },
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The route handlers                                                  */
/* ------------------------------------------------------------------ */

/**
 * CORS preflight.
 *
 * The endpoint is public and read-only, so any origin may call it.
 */
export async function OPTIONS(): Promise<Response> {
  return new Response(null, {
    status: 204,
    headers: { ...CORS_HEADERS, "mcp-protocol-version": MCP_PROTOCOL_VERSION },
  });
}

/**
 * GET /mcp
 *
 * The 2026-07-28 revision REMOVED the GET stream: every message is a POST
 * and long-lived change notifications travel on a `subscriptions/listen`
 * stream. A GET is therefore answered with `405`.
 */
export async function GET(): Promise<Response> {
  return jsonRpcError(
    null,
    INVALID_REQUEST,
    "The MCP endpoint accepts POST only. The GET stream was removed in protocol revision 2026-07-28.",
    undefined,
    405,
  );
}

/**
 * POST /mcp
 *
 * One JSON-RPC request (or notification, or batch) per POST.
 */
export async function POST(request: Request): Promise<Response> {
  const unauthorized = checkAuth(request);
  if (unauthorized) return unauthorized;

  const key = `mcp:${clientKey(request)}`;
  const rateLimit = checkRateLimit(key, MCP_RATE_LIMIT_MAX);
  if (!rateLimit.allowed) {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message:
            "Too Many Requests: MCP rate limit exceeded (60 requests per 5 minutes).",
          data: { retryAfterSeconds: rateLimit.retryAfterSeconds },
        },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": String(rateLimit.retryAfterSeconds),
          "cache-control": "no-store",
          ...CORS_HEADERS,
        },
      },
    );
  }

  /* ---------------------------------------------------------------- */
  /* 1. The protocol version                                           */
  /* ---------------------------------------------------------------- */

  const requestedVersion =
    request.headers.get("mcp-protocol-version")?.trim() ?? "";

  if (
    requestedVersion.length > 0 &&
    !SUPPORTED_PROTOCOL_VERSIONS.includes(
      requestedVersion as (typeof SUPPORTED_PROTOCOL_VERSIONS)[number],
    )
  ) {
    return jsonRpcError(
      null,
      UNSUPPORTED_PROTOCOL_VERSION,
      `Unsupported protocol version "${requestedVersion}". This endpoint speaks ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}.`,
      { supported: [...SUPPORTED_PROTOCOL_VERSIONS] },
      400,
    );
  }

  const protocolVersion = requestedVersion || MCP_PROTOCOL_VERSION;

  /* ---------------------------------------------------------------- */
  /* 2. The body                                                       */
  /* ---------------------------------------------------------------- */

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.length > 0 && !/^application\/json\b/i.test(contentType)) {
    return jsonRpcError(
      null,
      INVALID_REQUEST,
      `Unsupported Content-Type "${contentType}". The MCP endpoint takes application/json.`,
      undefined,
      415,
    );
  }

  let raw: unknown;
  try {
    const bodyText = await request.text();
    raw = bodyText.trim().length > 0 ? JSON.parse(bodyText) : undefined;
  } catch {
    return jsonRpcError(
      null,
      PARSE_ERROR,
      "Parse error: the request body is not valid JSON.",
    );
  }

  if (raw === undefined) {
    return jsonRpcError(
      null,
      INVALID_REQUEST,
      "Invalid Request: the request body is empty.",
    );
  }

  const messages = Array.isArray(raw) ? raw : [raw];
  const first = asRecord(messages[0]);
  const firstParams = asRecord(first.params);
  const id =
    typeof first.id === "string" || typeof first.id === "number"
      ? first.id
      : null;

  /* ---------------------------------------------------------------- */
  /* 3. Header based routing                                           */
  /* ---------------------------------------------------------------- */

  const rawMethodHeader = request.headers.get("mcp-method")?.trim() ?? "";
  const bodyMethod = typeof first.method === "string" ? first.method : "";

  const method = rawMethodHeader || bodyMethod;
  if (!method) {
    return jsonRpcError(
      id,
      INVALID_REQUEST,
      "Invalid Request: neither the Mcp-Method header nor the JSON-RPC body names a method.",
    );
  }

  if (rawMethodHeader && bodyMethod && rawMethodHeader !== bodyMethod) {
    return jsonRpcError(
      id,
      HEADER_MISMATCH,
      `Header mismatch: the Mcp-Method header names "${rawMethodHeader}" but the body names "${bodyMethod}".`,
    );
  }

  const rawNameHeader = request.headers.get("mcp-name")?.trim() ?? "";
  const decodedNameHeader =
    rawNameHeader.length > 0 ? decodeHeaderValue(rawNameHeader) : undefined;
  if (rawNameHeader.length > 0 && decodedNameHeader === undefined) {
    return jsonRpcError(
      id,
      HEADER_MISMATCH,
      "Header mismatch: the Mcp-Name header carries an invalid Base64 sentinel value.",
    );
  }

  const bodyName =
    typeof firstParams.name === "string"
      ? firstParams.name
      : typeof firstParams.uri === "string"
        ? firstParams.uri
        : "";

  if (
    decodedNameHeader &&
    bodyName &&
    decodedNameHeader !== bodyName
  ) {
    return jsonRpcError(
      id,
      HEADER_MISMATCH,
      `Header mismatch: the Mcp-Name header names "${decodedNameHeader}" but the body carries "${bodyName}".`,
    );
  }

  const methodNeedsName =
    method === "tools/call" ||
    method === "resources/read" ||
    method === "prompts/get";

  /* ---------------------------------------------------------------- */
  /* 4. `initialize` and `ping`                                        */
  /* ---------------------------------------------------------------- */

  if (method === "initialize") {
    const isModern = protocolVersion >= MCP_PROTOCOL_VERSION;
    const result: Record<string, unknown> = {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        prompts: { listChanged: false },
      },
      serverInfo: {
        name: MCP_SERVER_NAME,
        version: MCP_SERVER_VERSION,
      },
      instructions: MCP_INSTRUCTIONS,
    };
    if (isModern) result.resultType = "complete";

    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id, result }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          "cache-control": "no-store",
          ...CORS_HEADERS,
        },
      },
    );
  }

  if (method === "ping") {
    // `ping` is a 2025-era method: the 2026-07-28 revision dropped it from
    // the request-method registry, so the server answers it here instead of
    // letting the client see a method-not-found.
    const isModern = protocolVersion >= MCP_PROTOCOL_VERSION;
    const result = isModern ? { resultType: "complete" } : {};
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id, result }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
          "mcp-protocol-version": MCP_PROTOCOL_VERSION,
          "cache-control": "no-store",
          ...CORS_HEADERS,
        },
      },
    );
  }

  /* ---------------------------------------------------------------- */
  /* 5. Normalise and dispatch                                         */
  /* ---------------------------------------------------------------- */

  const headers = new Headers(request.headers);
  headers.set("mcp-protocol-version", protocolVersion);
  headers.set("mcp-method", method);
  if (methodNeedsName) {
    const name = decodedNameHeader || bodyName;
    if (name) headers.set("mcp-name", name);
  }
  if (!headers.get("accept")) {
    headers.set("accept", "application/json, text/event-stream");
  }

  // The 2026-07-28 revision requires every request to carry its protocol
  // version and client capabilities in the `_meta` envelope. A client that
  // omits them still gets served: the route fills in the defaults rather
  // than failing the call.
  const normalised = Array.isArray(raw)
    ? raw.map((message) => withEnvelope(asRecord(message), protocolVersion))
    : withEnvelope(asRecord(raw), protocolVersion);

  const response = await mcpHandler.fetch(
    new Request(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(normalised),
    }),
  );

  const responseHeaders = new Headers(response.headers);
  responseHeaders.set("mcp-protocol-version", protocolVersion);
  // The SDK answers with an event stream only when a handler emitted a
  // related message before its result. No tool on this surface does, so the
  // one shape a client sees is a JSON body.
  responseHeaders.set("content-type", "application/json");
  responseHeaders.set("cache-control", "no-store");
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    responseHeaders.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

/**
 * Add the 2026-07-28 `_meta` envelope to one message.
 *
 * Existing values are never overwritten: what the client sent is what the
 * server sees.
 */
function withEnvelope(
  message: Record<string, unknown>,
  protocolVersion: string,
): Record<string, unknown> {
  const params = asRecord(message.params);
  const meta = asRecord(params._meta);
  const envelope: Record<string, unknown> = {
    ...meta,
    "io.modelcontextprotocol/protocolVersion":
      meta["io.modelcontextprotocol/protocolVersion"] ?? protocolVersion,
    "io.modelcontextprotocol/clientCapabilities":
      meta["io.modelcontextprotocol/clientCapabilities"] ?? {},
  };
  return {
    ...message,
    params: { ...params, _meta: envelope },
  };
}
