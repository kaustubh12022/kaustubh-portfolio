/**
 * The stdio entry point of the MCP server.
 *
 * A host that launches the server as a child process (Claude Desktop, VS
 * Code, Cursor, the MCP Inspector) runs THIS file:
 *
 *     npx tsx scripts/mcp/stdio.ts
 *
 * stdout is the protocol channel, so every diagnostic goes to stderr. The
 * server itself lives in `lib/mcp/server.ts`; this file is only the process
 * boundary.
 *
 * NOTE: `lib/content/load.ts` and `lib/retrieval/db.ts` carry
 * `import "server-only"`, which throws outside a React Server Component
 * context. The process therefore has to run with the `react-server`
 * condition:
 *
 *     NODE_OPTIONS=--conditions=react-server npx tsx scripts/mcp/stdio.ts
 */

import { serveMcpStdio } from "../../lib/mcp/server.js";

serveMcpStdio();
