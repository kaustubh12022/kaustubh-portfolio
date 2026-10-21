/**
 * The MCP App: one project architecture diagram, rendered as interactive UI.
 *
 * WHAT AN MCP APP IS
 * ------------------
 * The MCP Apps extension (`io.modelcontextprotocol/apps`) lets a TOOL return
 * a UI resource next to its data. The host fetches that resource, renders it
 * in a sandboxed iframe and shows it inline in the conversation. The tool
 * result carries the pointer:
 *
 *     _meta: { ui: { resourceUri: "ui://portfolio/architecture/smartapply" } }
 *
 * WHY THE HTML IS BUILT HERE AND NOT LINKED
 * ------------------------------------------
 * The page is rendered SERVER SIDE, from `content/architecture/<id>.json`,
 * and returned as a `text/html` resource. It is deliberately:
 *
 *   - SELF CONTAINED: inline CSS, no fonts, no images, no scripts, and no
 *     absolute or protocol-relative URL of any kind. A sandboxed iframe that
 *     can phone home is a sandboxed iframe that can phone home.
 *   - LIGHT AND DARK SAFE: `color-scheme: light dark` plus a
 *     `prefers-color-scheme` block, so it reads correctly in a light host and
 *     a dark one.
 *   - READABLE AT 360px: a single column, no fixed widths, no horizontal
 *     scrolling, `overflow-wrap` everywhere.
 *
 * The HTML is built from the SAME diagram data the website renders, so the
 * two can never disagree.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/server";

import { ArchitectureSchema, type Architecture } from "@/lib/content/schemas";

/**
 * The project whose architecture is published as the MCP App.
 *
 * One diagram is enough to prove the extension works end to end, and one
 * diagram is one thing a reviewer can actually check.
 */
export const ARCHITECTURE_APP_PROJECT_ID = "smartapply";

/** The directory the architecture diagrams live in. */
const ARCHITECTURE_ROOT = join(process.cwd(), "content", "architecture");

/** The `ui://` scheme the MCP Apps extension uses for its resources. */
export const UI_SCHEME = "ui://portfolio/architecture";

/**
 * The resource URI of one project's architecture diagram.
 *
 * @param projectId the project id, e.g. `smartapply`
 */
export function architectureResourceUri(projectId: string): string {
  return `${UI_SCHEME}/${projectId}`;
}

/**
 * The project ids that actually have an architecture diagram on disk.
 *
 * The list is read at request time: the content layer is owned by another
 * part of the app and can gain a diagram at any time.
 */
export function listArchitectureProjectIds(): string[] {
  try {
    return readdirSync(ARCHITECTURE_ROOT)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/** Read and validate one architecture diagram. */
export function readArchitecture(projectId: string): Architecture | null {
  try {
    const raw = readFileSync(
      join(ARCHITECTURE_ROOT, `${projectId}.json`),
      "utf8",
    );
    return ArchitectureSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * The `_meta.ui` pointer for a project, or `undefined` when the project has
 * no diagram.
 */
export function architectureAppMeta(
  projectId: string,
): { ui: { resourceUri: string } } | undefined {
  if (!listArchitectureProjectIds().includes(projectId)) return undefined;
  return { ui: { resourceUri: architectureResourceUri(projectId) } };
}

/* ------------------------------------------------------------------ */
/* HTML rendering                                                      */
/* ------------------------------------------------------------------ */

/** Escape the five characters that matter in HTML text and attributes. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Remove every absolute or protocol-relative URL from a string.
 *
 * The page must contain NO external resource references at all, so the
 * invariant is enforced on the TEXT as well as on the markup: a URL that
 * leaked in through a diagram label is stripped rather than shipped.
 */
export function stripExternalUrls(value: string): string {
  return value
    .replace(/https?:\/\//gi, "")
    .replace(/(^|[\s(])\/\/[a-z0-9.-]+\//gi, "$1/");
}

/** Escape a string and strip its external URLs, in that order. */
function safeText(value: string): string {
  return escapeHtml(stripExternalUrls(value));
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #ffffff;
  --fg: #14161a;
  --muted: #5b6270;
  --line: #d9dde5;
  --card: #f6f7f9;
  --accent: #2f6f4f;
  --warn: #8a4b1f;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115;
    --fg: #e8eaee;
    --muted: #9aa3b2;
    --line: #2a2f38;
    --card: #171a20;
    --accent: #6fd3a2;
    --warn: #e0a273;
  }
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, sans-serif;
  font-size: 15px;
  line-height: 1.5;
  overflow-wrap: anywhere;
  word-break: break-word;
}
.wrap { padding: 16px; max-width: 780px; margin: 0 auto; }
h1 { font-size: 1.15rem; margin: 0 0 2px; letter-spacing: -0.01em; }
.sub { color: var(--muted); font-size: 0.875rem; margin: 0 0 16px; }
h2 {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin: 20px 0 8px;
}
.col { margin: 0 0 12px; }
.col-label {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
  margin: 0 0 6px;
}
.node {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  margin: 0 0 8px;
}
.node-name { font-weight: 600; font-size: 0.95rem; }
.node-detail { color: var(--muted); font-size: 0.82rem; margin-top: 2px; }
.node-accent { border-left: 3px solid var(--accent); }
.node-warn { border-left: 3px solid var(--warn); }
.edge {
  border-left: 2px solid var(--line);
  padding: 4px 0 4px 10px;
  margin: 0 0 6px;
  font-size: 0.85rem;
}
.edge b { font-weight: 600; }
.edge .lbl { color: var(--muted); }
ul.notes { margin: 0; padding-left: 18px; }
ul.notes li { margin: 0 0 6px; font-size: 0.85rem; }
footer { color: var(--muted); font-size: 0.72rem; margin-top: 20px; }
`;

/**
 * Render one architecture diagram as a self-contained HTML page.
 *
 * @param projectId the project whose diagram to render
 * @returns the HTML, or `null` when the project has no diagram
 */
export function buildArchitectureHtml(projectId: string): string | null {
  const architecture = readArchitecture(projectId);
  if (!architecture) return null;

  const labelOf = new Map<string, string>();
  for (const node of architecture.nodes) {
    labelOf.set(node.id, node.label);
  }

  // Columns: use the declared columns when the diagram has them, otherwise
  // fall back to one implicit column so nothing is lost.
  const columns =
    architecture.columns && architecture.columns.length > 0
      ? architecture.columns
      : [{ id: "all", label: "Stages" }];

  const columnHtml = columns
    .map((column) => {
      const nodes = architecture.nodes.filter(
        (node) =>
          node.column === undefined
            ? columns.length === 1
            : node.column === columns.indexOf(column),
      );
      if (nodes.length === 0) return "";
      const cards = nodes
        .map((node) => {
          const tone =
            node.tone === "accent"
              ? " node-accent"
              : node.tone === "warn"
                ? " node-warn"
                : "";
          const detail = node.detail
            ? `<div class="node-detail">${safeText(node.detail)}</div>`
            : "";
          return `<div class="node${tone}"><div class="node-name">${safeText(
            node.label,
          )}</div>${detail}</div>`;
        })
        .join("\n");
      return `<section class="col"><p class="col-label">${safeText(
        column.label,
      )}</p>\n${cards}\n</section>`;
    })
    .filter(Boolean)
    .join("\n");

  const edgeHtml = architecture.edges
    .map((edge) => {
      const from = labelOf.get(edge.from) ?? edge.from;
      const to = labelOf.get(edge.to) ?? edge.to;
      const label = edge.label
        ? ` <span class="lbl">(${safeText(edge.label)})</span>`
        : "";
      return `<div class="edge"><b>${safeText(from)}</b> &rarr; <b>${safeText(
        to,
      )}</b>${label}</div>`;
    })
    .join("\n");

  const notesHtml =
    architecture.notes.length > 0
      ? `<h2>Notes</h2>\n<ul class="notes">${architecture.notes
          .map((note) => `<li>${safeText(note)}</li>`)
          .join("\n")}</ul>`
      : "";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${safeText(architecture.title)} - ${safeText(projectId)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
<h1>${safeText(architecture.title)}</h1>
<p class="sub">${safeText(architecture.subtitle ?? "")}</p>
<h2>Stages</h2>
${columnHtml}
<h2>Connections</h2>
${edgeHtml}
${notesHtml}
<footer>project: ${safeText(projectId)} &middot; rendered from the indexed source diagram</footer>
</div>
</body>
</html>`;

  // Belt and braces: the page must not reference anything off-origin. If a
  // URL ever slipped through, it is neutralised rather than shipped.
  if (/https?:\/\//i.test(html) || /\/\/cdn/i.test(html)) {
    return html
      .replace(/https?:\/\//gi, "")
      .replace(/\/\/cdn/gi, "/cdn");
  }
  return html;
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

/**
 * Register the `ui://` architecture resources on an MCP server.
 *
 * One resource per project that has a diagram on disk, so the `Mcp-Name`
 * header of a `resources/read` request names a real diagram.
 */
export function registerArchitectureApp(server: McpServer): string[] {
  const projectIds = listArchitectureProjectIds();
  for (const projectId of projectIds) {
    const uri = architectureResourceUri(projectId);
    server.registerResource(
      `architecture-${projectId}`,
      uri,
      {
        title: `Architecture diagram: ${projectId}`,
        description:
          "The captured architecture diagram of the project, rendered as a self-contained HTML page for the MCP Apps iframe.",
        mimeType: "text/html",
        cacheHint: { ttlMs: 300_000, cacheScope: "public" },
      },
      async (resourceUri) => {
        const html = buildArchitectureHtml(projectId);
        return {
          contents: [
            {
              uri: resourceUri.href,
              mimeType: "text/html",
              text:
                html ??
                `<p>No architecture diagram was captured for ${safeText(
                  projectId,
                )}.</p>`,
            },
          ],
        };
      },
    );
  }
  return projectIds;
}
