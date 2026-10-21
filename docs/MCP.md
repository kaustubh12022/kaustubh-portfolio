# The MCP surface

## What this is, and why it exists

This portfolio is a conversational site: a visitor asks "what did Kaustubh
build?" and a grounded RAG agent answers from a Neon Postgres index of 2,864
line-exact chunks cut out of six real GitHub repositories, cross-checked
against a claim ledger that says which numbers, employers and capabilities
are **verified**, **partial**, **unverified** or **contradicted**.

The MCP surface exposes that same index to any MCP host. The point is
concrete: a recruiter with **Claude Desktop**, **VS Code** or **Cursor** can
point the host at `https://<your-domain>/mcp`, ask

> "What did Kaustubh build? Show me the code that does the AI scoring."

and get an answer with a file path, a line range and a claim status behind
every sentence - without ever opening the website.

The important property is that the MCP surface does **not** have its own
knowledge. Every tool in `lib/mcp/tools.ts` delegates to the matching
website tool in `lib/ai/tools.ts`. There is one implementation of "what is
true" (the content layer plus the claim ledger) and one implementation of
"how do we find it" (the hybrid ANN + keyword retrieval over the indexed
chunks). The MCP layer only validates arguments and renders the answer as
compact text. The two surfaces therefore cannot drift apart.

## The 2026-07-28 spec points that actually applied

The revision in force is `2026-07-28`. Four things in it changed how this
surface is built.

### 1. Stateless protocol core

The `initialize` / `initialized` handshake and the `Mcp-Session-Id` header
are gone. Every request is self-describing: it carries its protocol version,
its client identity and its client capabilities in
`_meta["io.modelcontextprotocol/*"]`.

**What was done.** `createMcpHandler` builds a **fresh `McpServer` per HTTP
request** - the factory in `lib/mcp/server.ts` holds nothing between
requests. There is no session, no session id, nothing to pin. Any request can
land on any instance behind a round-robin load balancer.

The endpoint still answers `initialize`, because a 2025-era client may send
it (`app/mcp/route.ts` answers it directly with the capabilities and the
usage guide). It is optional in the 2026 revision, not forbidden.

### 2. Header-based routing (SEP-2243)

A Streamable HTTP request must carry `Mcp-Method`, and `Mcp-Name` for the
methods that name a tool, prompt or resource, so a gateway can route and
authorise on the headers without parsing the body.

**What was done.** `app/mcp/route.ts` reads `Mcp-Method`, `Mcp-Name` and
`MCP-Protocol-Version` **before** it touches the body, and routes on them:

| Situation | Answer |
| --- | --- |
| Header present, body agrees | served |
| Header absent, body names the method | the route synthesises the header from the body and serves it (the body is the documented fallback) |
| Header and body disagree | HTTP `400`, JSON-RPC `-32020` `HeaderMismatch` |
| `Mcp-Name` carries an invalid `=?base64?…?=` sentinel | HTTP `400`, JSON-RPC `-32020` |
| `Mcp-Name` disagrees with `params.name` / `params.uri` | HTTP `400`, JSON-RPC `-32020` |

The disagreement case is not pedantry: a load balancer that routes on the
header and a server that executes on the body must never act on two
different requests.

### 3. Cacheable list results (SEP-2549)

`tools/list`, `prompts/list`, `resources/list` and `resources/read` carry
`ttlMs` and `cacheScope` on this revision.

**What was done.** The cache hints live on the server
(`lib/mcp/server.ts`):

| Operation | `ttlMs` | `cacheScope` |
| --- | --- | --- |
| `tools/list` | 600 000 (10 min) | `public` |
| `prompts/list` | 3 600 000 (1 h) | `public` |
| `resources/list` | 600 000 (10 min) | `public` |
| `resources/read` | 300 000 (5 min) | `public` |

The tool catalogue and the content resources are static, so a shared cache
may keep them. The reads get a shorter window because a re-index of the
source invalidates them. **Tool results are never cached**: every
`tools/call` is computed from the live index.

### 4. Multi Round-Trip Requests (SEP-2322)

When a server needs input from the client mid-call, it returns
`resultType: "input_required"` with the requests it needs answered; the
client answers them and retries the original call with `inputResponses`
attached.

**What was done.** `get_claim` is the MRTR case. When the requested id
matches nothing in the ledger, the server does not guess and does not fail:
it returns an `input_required` result carrying an `elicitation/create`
request that asks which claim was meant, with the known ids in the message.
The client answers, retries with `inputResponses`, and the same handler runs
again - it reads the answer with `acceptedContent(ctx.mcpReq.inputResponses,
…)`, which validates the untrusted client value against a Zod schema before
it reaches the handler.

```jsonc
// round 1
{"resultType":"input_required","inputRequests":{"claimId":{"method":"elicitation/create", …}}}
// round 2 - the client retries with the answer attached
{"params":{"name":"get_claim","arguments":{"id":"not-a-claim"},
  "inputResponses":{"claimId":{"action":"accept","content":{"claimId":"java-spring"}}}}}
```

### What was NOT implemented, and why

| Spec feature | Why it is not here |
| --- | --- |
| **Tasks** (`io.modelcontextprotocol/tasks`, `tasks/get`, `tasks/update`) | Every operation on this surface finishes in one round trip. A task registry would be state, and the 2026 core is stateless by design. The extension exists for long-running work; there is none. |
| **Roots** | Deprecated in 2026-07-28 (SEP-2577). Not adopted. |
| **Sampling** | Deprecated in 2026-07-28 (SEP-2577). Not adopted. The server never asks the host's model for anything. |
| **Logging** (`notifications/message`) | Deprecated in 2026-07-28 (SEP-2577). Diagnostics go to stderr / the server log, not to the client. |
| **`subscriptions/listen`** | The knowledge base does not change while the process is up; a change stream would have nothing to say. `resources/list_changed` and `tools/list_changed` are registered but never fired. |
| **The legacy HTTP+SSE transport** | Deprecated. The endpoint is Streamable HTTP only. 2025-era clients are still served, because the SDK serves them statelessly through the same factory. |
| **Dynamic Client Registration / CIMD** | There is no OAuth authorisation server here. The endpoint uses one static bearer token (see below). |
| **`Mcp-Param-*` parameter headers** | The optional `x-mcp-header` schema extension is not used, so no tool parameter is mirrored into a header. Nothing to validate. |

## The tools

Ten tools, all read-only. Every description is written for a model that has
never seen this project.

| Tool | What it returns |
| --- | --- |
| `search_code` | Hybrid (semantic + keyword) search over the six indexed repositories: the matching chunks with their exact path, line range and source text. Use it to find **where** something is implemented. |
| `read_file` | The exact source lines of a file that exists in the index. A path that is not in the index is refused; a path that tries to escape the repository is refused. |
| `find_symbol` | A named function, class or method by exact name, with a trigram-similarity fallback: the file, the line range and the source. |
| `get_project` | One verified project: tagline, status, role, timeline, stack, summary, highlights, features, metrics, caveats and assets. |
| `get_architecture` | The captured architecture diagram of a project: the stages, the nodes, the edges and the notes. Also returns the MCP App pointer (see below). |
| `get_metrics` | The verified metrics: the number, the unit, the method that produced it, the source and the verification date. |
| `get_assets` | The captured assets (screenshots, diagrams, photos) with their caption and their status. |
| `get_claim` | One claim-ledger entry: the claim, its status, the evidence, the source and the **approved public wording**. |
| `get_profile` | The verified profile: name, headline, location, contact details, summary, education, experience, skills and languages. |
| `compare_projects` | Two to four projects side by side on one dimension: stack, status, features, metrics, caveats or everything. |

The website has twelve tools. The two that are not exposed are
`render_visual` (it declares which card the chat UI should draw - meaningless
over MCP) and `get_data_model` (it reads the schema files of the indexed
repositories; it is deliberately outside the requested MCP tool set).

## Resources and prompts

**Resources** - the knowledge base, as data a host can attach to a
conversation:

- `portfolio://profile`
- `portfolio://claims` - the whole claim ledger
- `portfolio://metrics`
- `portfolio://project/<id>` - one project summary per project
- `ui://portfolio/architecture/<id>` - the MCP App (below)

**Prompts**:

- `explain_project_to_hiring_manager` - takes a `projectId` and returns the
  project summary plus a brief that tells the model to use the tools, cite
  the source, quote the approved wording verbatim and finish with the
  caveats.

## The MCP App

One project architecture diagram is published as an MCP App: the
`get_architecture` tool returns

```json
{"_meta":{"ui":{"resourceUri":"ui://portfolio/architecture/smartapply"}}}
```

next to the structured diagram, and `ui://portfolio/architecture/<id>` is a
`text/html` resource a host renders in a sandboxed iframe.

The page is built **server side** from `content/architecture/<id>.json` and
is deliberately:

- **self-contained** - inline CSS, no fonts, no images, no scripts, and no
  absolute or protocol-relative URL of any kind (the text is sanitised too,
  so a URL in a diagram label is stripped rather than shipped);
- **light and dark safe** - `color-scheme: light dark` plus a
  `prefers-color-scheme` block;
- **readable at 360 px** - one column, no fixed widths, `overflow-wrap`
  everywhere.

## How to connect

### The URL

```
https://<your-domain>/mcp
```

Locally: `http://localhost:3000/mcp`.

### The headers

Every POST carries:

```http
POST /mcp HTTP/1.1
Content-Type: application/json
Accept: application/json, text/event-stream
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: search_code
```

`Mcp-Method` is required. `Mcp-Name` is required for `tools/call`,
`resources/read` and `prompts/get`. The body may omit them: the route falls
back to the JSON-RPC body and synthesises the headers. A header that
disagrees with the body is refused with `-32020`.

### The token

The endpoint is read-only, but it exposes the owner's source code, so it
takes an **optional** bearer token from `MCP_AUTH_TOKEN`:

```bash
# .env.local
MCP_AUTH_TOKEN=choose-a-long-random-string
```

- When `MCP_AUTH_TOKEN` is **set**, every request must carry
  `Authorization: Bearer <token>`; a missing or wrong token is answered with
  HTTP `401` and a `WWW-Authenticate: Bearer realm="mcp"` header.
- When it is **not set**, the endpoint is **open** and the route logs a loud
  warning once per process.

Open is the right default for a public portfolio: the data is public, the
surface is read-only and a recruiter should be able to connect without an
account. Set the variable to close it.

## Client configuration

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "kaustubh-portfolio": {
      "type": "http",
      "url": "https://<your-domain>/mcp",
      "headers": {
        "MCP-Protocol-Version": "2026-07-28",
        "Authorization": "Bearer ${MCP_AUTH_TOKEN}"
      }
    }
  }
}
```

### VS Code (`.vscode/mcp.json`)

```json
{
  "servers": {
    "kaustubh-portfolio": {
      "type": "http",
      "url": "https://<your-domain>/mcp",
      "headers": {
        "MCP-Protocol-Version": "2026-07-28"
      }
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "kaustubh-portfolio": {
      "url": "https://<your-domain>/mcp",
      "headers": {
        "MCP-Protocol-Version": "2026-07-28"
      }
    }
  }
}
```

### Locally, over stdio

A host can also launch the server as a child process. The entry point is
`scripts/mcp/stdio.ts`:

```json
{
  "mcpServers": {
    "kaustubh-portfolio": {
      "command": "npx",
      "args": ["tsx", "scripts/mcp/stdio.ts"],
      "env": {
        "NODE_OPTIONS": "--conditions=react-server"
      }
    }
  }
}
```

The `react-server` condition is needed because `lib/content/load.ts` and
`lib/retrieval/db.ts` carry `import "server-only"`, which throws outside a
React Server Component context.

## Trying it locally

```bash
# 1. install the SDK (it is not a dependency yet)
npm i @modelcontextprotocol/server@^2 @modelcontextprotocol/client@^2

# 2. run the local client: it lists the tools, calls search_code and
#    get_claim, and checks that the claim answer is grounded
NODE_OPTIONS=--conditions=react-server npx tsx scripts/mcp/inspect.ts
```

## The honest limitations

- **Read-only.** There is no write path, no shell and no filesystem access at
  request time. Nothing here can change the portfolio.
- **The source code is exposed.** The index is line-exact source from six
  public repositories. That is the point - but it is why `MCP_AUTH_TOKEN`
  exists.
- **No in-memory state.** Nothing is remembered between requests. A
  follow-up question that needs the previous turn must carry it in its own
  arguments.
- **Rate limiting is per instance.** There is no shared rate limiter behind
  the endpoint: a reverse proxy or a platform limiter in front of it is the
  right place for that. The surface is read-only, so the risk is a bill, not
  a mutation.
- **The local embedding model must be downloadable.** `search_code` embeds
  the query with `Xenova/all-MiniLM-L6-v2` on the server. The model is
  fetched once from the Hugging Face CDN and cached on disk; a machine that
  has never downloaded it and is offline cannot search. The other nine tools
  do not need it.
- **The index is a snapshot.** The chunks come from a recorded `index_manifest`
  with a commit SHA. A repository that changed after the last index is not
  reflected, and `get_architecture` says so when a diagram was never
  captured.
- **The claim ledger is the source of truth about honesty.** A tool that
  returns `CONTRADICTED` means the audit found the opposite. Quote the
  approved wording; never paraphrase it.

## The files

| File | What it holds |
| --- | --- |
| `lib/mcp/tools.ts` | The ten tools: schemas, descriptions, and the delegation to the website tools. |
| `lib/mcp/server.ts` | The `McpServer` factory: tools, resources, prompts, cache hints, and the stdio entry. |
| `lib/mcp/apps.ts` | The MCP App: the `ui://` resources and the server-side HTML renderer. |
| `app/mcp/route.ts` | The HTTP transport: header routing, protocol version check, auth, CORS. |
| `scripts/mcp/stdio.ts` | The stdio entry point. |
| `scripts/mcp/inspect.ts` | The local client that exercises the surface. |
| `tests/unit/mcp.test.ts` | The fast, LLM-free tests. |
