#!/usr/bin/env node
/**
 * Generate `content/datamodel/<projectId>.json` from the indexed source.
 *
 *   npx tsx scripts/index/datamodel.ts [--project=<id>] [--dry-run]
 *
 * WHY A GENERATOR AND NOT A HAND-WRITTEN FILE
 * ------------------------------------------
 * A data model is a list of tables and fields. Hand-writing one means
 * copying it from a source file by eye, and the copy goes stale the moment
 * the schema changes - which is exactly the kind of drift this portfolio
 * exists to avoid. This script reads the SAME schema files the retrieval
 * index already holds, extracts the entities mechanically, and writes them
 * into the content layer. Re-running it is how the file is refreshed.
 *
 * WHERE THE SOURCE COMES FROM
 * ---------------------------
 * Two sources, in this order:
 *
 *   1. The INDEX. The `chunks` table holds line-exact source for every
 *      indexed file, pinned to the commit that was ingested. Reading the
 *      schema out of it means the data model is the source that the
 *      assistant can also cite.
 *   2. The PINNED LOCAL CHECKOUT, for the one file that is deliberately
 *      NOT indexed: `C54-Casino/init_tables.js` carries a hardcoded
 *      database credential, so the indexer's secret gate refuses it. The
 *      tables it creates are still real, so they are read from the local
 *      clone at the pinned commit instead, and the script refuses to run if
 *      that clone is not at the pinned SHA.
 *
 * WHAT IT EXTRACTS
 * ----------------
 *   - SQL `CREATE TABLE` statements (Postgres and SQLite).
 *   - Mongoose schemas (`new mongoose.Schema({...})` plus the model name
 *     from `mongoose.model('Name', ...)`).
 *
 * The output is written deterministically - sorted entities, sorted
 * relations, no timestamps - so re-running the script on an unchanged index
 * produces a byte-identical file and the diff stays meaningful.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createPgPool, type PgPool } from "../../lib/retrieval/pg.js";
import { getProject } from "./projects.js";

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

interface CliOptions {
  project?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg.startsWith("--project=")) options.project = arg.slice("--project=".length);
  }
  return options;
}

/** Load `.env.local` when the environment does not already have a URL. */
function loadLocalEnv(): void {
  if (process.env.DATABASE_URL) return;
  const envFile = path.join(process.cwd(), ".env.local");
  try {
    process.loadEnvFile(envFile);
  } catch {
    // No .env.local: the environment has to provide the URL.
  }
}

/* ------------------------------------------------------------------ */
/* What to read                                                        */
/* ------------------------------------------------------------------ */

/** Where the schema of one project comes from. */
interface SchemaSource {
  /** The project id, as used in `content/projects/<id>.yaml`. */
  project: string;
  /**
   * Paths in the INDEX. An entry that ends in `/` is a directory prefix.
   */
  indexed?: string[];
  /**
   * Paths in the PINNED LOCAL CHECKOUT, relative to the repository root.
   *
   * Only used for files the indexer refuses to ingest (the secret gate).
   */
  local?: string[];
  /** Why this list looks the way it does. Copied into the output file. */
  note?: string;
}

const SCHEMA_SOURCES: SchemaSource[] = [
  {
    project: "smartapply",
    // The SQLite application tracker. `setup_db.py` holds a POSTGRES mirror
    // with a DIFFERENT `tracked_jobs` shape (uuid columns, a run_id, a
    // score column). Extracting both would put two different tables under
    // one name in the diagram, which is worse than showing one store, so
    // only the SQLite store - the one the tracker actually writes - is
    // extracted.
    indexed: ["src/tracker.py"],
    note:
      "SmartApply keeps a local SQLite application tracker (data_folder/application_tracker.db). The Postgres mirror in setup_db.py is a different store with a different shape and is not drawn here.",
  },
  {
    project: "pawna",
    // The eight Mongoose models.
    indexed: ["backend/models/"],
    note:
      "The eight Mongoose models under backend/models/. Every field, required flag and `ref` is taken from the schema literal in the source file.",
  },
  {
    project: "c54",
    // `init_tables.js` is EXCLUDED from the index (scripts/index/projects.ts)
    // because it contains a hardcoded database credential, so the secret
    // gate blocks it. The tables it creates are real, so they are read from
    // the pinned local checkout instead.
    local: ["init_tables.js"],
    note:
      "The Postgres tables created by init_tables.js. That file is deliberately not in the retrieval index (it used to carry a hardcoded credential), so it is read from the local clone instead.",
  },
  // `personal-ai-os` is deliberately NOT extracted.
  //
  // Its schema lives in two Supabase migrations, and the second one evolves
  // the first with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` inside `DO $$`
  // blocks. An extractor that only understands `CREATE TABLE` would draw a
  // table that is missing the columns the migration added, which is a worse
  // lie than an empty card. It needs a migration-aware extractor (or a
  // `supabase db dump`) before it can be published.
];

/* ------------------------------------------------------------------ */
/* Reading the source                                                  */
/* ------------------------------------------------------------------ */

/** One chunk row, as stored. */
interface ChunkRow {
  path: string;
  start_line: number;
  end_line: number;
  content: string;
}

/**
 * Rebuild a file body from its chunks.
 *
 * WHY THIS IS DUPLICATED
 * ----------------------
 * The shared implementation lives in `lib/retrieval/search.ts`, which
 * imports `lib/retrieval/db.ts` - and that module carries the
 * `import "server-only"` guard, which THROWS when it is loaded outside a
 * React Server Component. A CLI script cannot import it. The logic is
 * small, and it is copied here verbatim in spirit: the chunks are
 * line-exact, the sliding-window fallback overlaps, and the first writer
 * of a line wins.
 */
function reconstruct(chunks: ChunkRow[]): string {
  if (chunks.length === 0) return "";

  const sorted = [...chunks].sort(
    (a, b) => a.start_line - b.start_line || a.end_line - b.end_line,
  );

  const byLine = new Map<number, string>();
  let maxLine = 0;

  for (const chunk of sorted) {
    const parts = chunk.content.split("\n");
    for (let i = 0; i < parts.length; i += 1) {
      const lineNo = chunk.start_line + i;
      if (lineNo > chunk.end_line) break;
      if (!byLine.has(lineNo)) byLine.set(lineNo, parts[i]);
    }
    maxLine = Math.max(maxLine, chunk.end_line);
  }

  const lines: string[] = [];
  for (let n = 1; n <= maxLine; n += 1) lines.push(byLine.get(n) ?? "");
  return lines.join("\n");
}

/** Does an indexed path match one of the configured patterns? */
function matchesPath(paths: string[], candidate: string): boolean {
  return paths.some((pattern) =>
    pattern.endsWith("/")
      ? candidate.startsWith(pattern)
      : candidate === pattern,
  );
}

/**
 * Read the schema files of one project out of the index.
 *
 * @param pool the database pool
 * @param source the source description
 * @returns a map of indexed path to file body
 */
async function readIndexedFiles(
  pool: PgPool,
  source: SchemaSource,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  if (!source.indexed?.length) return files;

  const result = await pool.query<ChunkRow>(
    `SELECT path, start_line, end_line, content
       FROM chunks
      WHERE project_id = $1
      ORDER BY path, start_line, end_line`,
    [source.project],
  );

  const byPath = new Map<string, ChunkRow[]>();
  for (const row of result.rows) {
    if (!matchesPath(source.indexed, row.path)) continue;
    const list = byPath.get(row.path) ?? [];
    list.push(row);
    byPath.set(row.path, list);
  }

  for (const [file, chunks] of byPath) {
    files.set(file, reconstruct(chunks));
  }

  return files;
}

/**
 * Read a file from the local checkout of the repository.
 *
 * WHY THE PINNED COMMIT IS TRIED FIRST
 * -----------------------------------
 * `git show <sha>:<path>` returns the file exactly as it was at the commit
 * the index was built from, whatever the working tree looks like now. That
 * is the version whose line numbers the citations point at, so it is the
 * right source.
 *
 * WHY THERE IS A FALLBACK
 * -----------------------
 * The C54 history was rewritten when the hardcoded credential was scrubbed,
 * so the pinned SHA is no longer an object in the local clone. When that
 * happens the working tree is used and the run says so loudly, because a
 * schema read from a different commit is a claim about a different file.
 */
function readLocalFile(
  project: string,
  relativePath: string,
): { path: string; body: string } {
  const definition = getProject(project);
  if (!definition) {
    throw new Error(`Unknown project "${project}".`);
  }

  try {
    const body = execFileSync(
      "git",
      ["-C", definition.repoPath, "show", `${definition.repoSha}:${relativePath}`],
      {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        // Git's own "fatal: ..." line is expected here (the commit may be
        // gone) and the script reports it in its own words.
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return { path: relativePath, body };
  } catch {
    // The pinned commit is not in this clone any more (the history was
    // rewritten). Fall back to the working tree and say so.
    console.warn(
      `[${project}] the pinned commit ${definition.repoSha.slice(0, 7)} is not in the ` +
        `local clone, so ${relativePath} was read from the working tree.`,
    );

    const absolute = path.join(definition.repoPath, relativePath);
    return { path: relativePath, body: readFileSync(absolute, "utf8") };
  }
}

/* ------------------------------------------------------------------ */
/* Extracting SQL tables                                               */
/* ------------------------------------------------------------------ */

/** A field of a table, before it is written to the content layer. */
interface RawField {
  name: string;
  type: string;
  required: boolean;
  relation?: string;
}

/** A relation between two tables. */
interface RawRelation {
  from: string;
  to: string;
  label: string;
  kind: "1-1" | "1-n" | "n-n";
}

/** A table, before it is written to the content layer. */
interface RawEntity {
  name: string;
  fields: RawField[];
  relations: RawRelation[];
}

/**
 * Find the matching closing bracket.
 *
 * Strings, line comments and block comments are skipped, so a `}` inside a
 * string or a comment cannot end the scan early.
 *
 * @param text the whole text
 * @param open the index of the opening bracket
 * @param openChar the opening bracket
 * @param closeChar the closing bracket
 * @returns the index of the matching closing bracket, or -1
 */
function matchBracket(
  text: string,
  open: number,
  openChar: string,
  closeChar: string,
): number {
  let depth = 0;
  let quote: string | null = null;

  for (let i = open; i < text.length; i += 1) {
    const char = text[i]!;

    if (quote) {
      if (char === "\\") {
        i += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }

    // A line comment runs to the end of the line.
    if (char === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline;
      continue;
    }

    // A block comment runs to its terminator.
    if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }

    if (char === openChar) depth += 1;
    else if (char === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

/**
 * Split a list on the commas that are NOT inside a bracket or a string.
 *
 * Comments are dropped: a comment between two fields belongs to neither,
 * and a comment that contains a comma (or an apostrophe, as in "don't")
 * must not be allowed to break the scan.
 *
 * @param text the list body
 * @returns the parts, trimmed, without the empty ones
 */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  let quote: string | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;

    if (quote) {
      current += char;
      if (char === "\\") {
        const next = text[i + 1];
        if (next !== undefined) {
          current += next;
          i += 1;
        }
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }

    if (char === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline;
      continue;
    }

    if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }

    if (char === "(" || char === "[" || char === "{") depth += 1;
    if (char === ")" || char === "]" || char === "}") depth -= 1;

    if (char === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  const last = current.trim();
  if (last) parts.push(last);

  return parts.filter((part) => part.length > 0);
}

/**
 * The type of a SQL column.
 *
 * @param rest everything after the column name
 * @returns the type expression, e.g. `text`, `numeric(10,2)`, `TEXT[]`
 */
function sqlColumnType(rest: string): string {
  const match = rest.match(
    /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?(\s*\[\s*\])?/,
  );
  if (!match) return "unknown";
  const base = match[1]!;
  const args = match[2] ?? "";
  const array = match[3] ? "[]" : "";
  return `${base}${args}${array}`.trim();
}

/**
 * Extract every `CREATE TABLE` of a SQL-ish source file.
 *
 * @param text the file body
 * @returns the tables, in the order they are declared
 */
export function extractSqlTables(text: string): RawEntity[] {
  const entities: RawEntity[] = [];
  const pattern = /create\s+table\s+(?:if\s+not\s+exists\s+)?/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const afterKeyword = match.index + match[0].length;

    // The table name, possibly schema-qualified or quoted.
    const nameMatch = text.slice(afterKeyword).match(
      /^\s*(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_$]*))\s*(?:\.\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$]*)))?/,
    );
    if (!nameMatch) continue;

    const tableName =
      nameMatch[1] ??
      nameMatch[2] ??
      nameMatch[3] ??
      nameMatch[4] ??
      nameMatch[5];
    if (!tableName) continue;

    const open = text.indexOf("(", afterKeyword);
    if (open === -1) continue;

    const close = matchBracket(text, open, "(", ")");
    if (close === -1) continue;

    const body = text.slice(open + 1, close);
    const entity: RawEntity = { name: tableName, fields: [], relations: [] };

    for (const part of splitTopLevel(body)) {
      const foreignKey = part.match(
        /^foreign\s+key\s*\(([^)]*)\)\s*references\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i,
      );
      if (foreignKey) {
        const column = foreignKey[1]!.split(",")[0]!.trim().replace(/^["'`]|["'`]$/g, "");
        const target = foreignKey[2]!;
        entity.relations.push({
          from: tableName,
          to: target,
          label: column,
          kind: "1-n",
        });
        const field = entity.fields.find((item) => item.name === column);
        if (field) field.relation = target;
        continue;
      }

      if (/^(constraint|primary\s+key|unique|check|exclude|like)\b/i.test(part)) {
        continue;
      }

      const columnMatch = part.match(
        /^\s*(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_$]*))\s+([\s\S]*)$/,
      );
      if (!columnMatch) continue;

      const columnName = columnMatch[1] ?? columnMatch[2] ?? columnMatch[3];
      if (!columnName) continue;
      const rest = columnMatch[4] ?? "";

      const reference = rest.match(/references\s+"?([A-Za-z_][A-Za-z0-9_]*)"?/i);
      const required = /not\s+null/i.test(rest) || /primary\s+key/i.test(rest);

      entity.fields.push({
        name: columnName,
        type: sqlColumnType(rest),
        required,
        ...(reference ? { relation: reference[1]! } : {}),
      });

      if (reference) {
        entity.relations.push({
          from: tableName,
          to: reference[1]!,
          label: columnName,
          kind: "1-n",
        });
      }
    }

    entities.push(entity);
    pattern.lastIndex = close;
  }

  return entities;
}

/* ------------------------------------------------------------------ */
/* Extracting Mongoose models                                          */
/* ------------------------------------------------------------------ */

/**
 * The name of the model a schema file registers.
 *
 * WHY THIS IS NOT A PLAIN `mongoose.model(` SEARCH
 * -------------------------------------------------
 * A model file can call `mongoose.model('Other')` somewhere else in its
 * body - `Review.js` updates the average rating of a `Property` with
 * `mongoose.model('Property').findByIdAndUpdate(...)`. A plain search finds
 * THAT first and files the review fields under `Property`. So the schema
 * variable is resolved first, and the name is taken from the registration
 * that uses it.
 *
 * @param text the file body
 * @param schemaVariable the variable the schema literal was assigned to
 * @returns the model name, e.g. `Booking`
 */
function mongooseModelName(
  text: string,
  schemaVariable: string | null,
): string | null {
  if (schemaVariable) {
    const registration = text.match(
      new RegExp(
        `mongoose\\s*\\.\\s*model\\s*\\(\\s*['"\`]([A-Za-z_][A-Za-z0-9_]*)['"\`]\\s*,\\s*${schemaVariable}\\b`,
      ),
    );
    if (registration?.[1]) return registration[1];
  }

  const exported = text.match(
    /module\.exports\s*=\s*mongoose\s*\.\s*model\s*\(\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/,
  );
  return exported?.[1] ?? null;
}

/**
 * The variable a schema literal was assigned to.
 */
function mongooseSchemaVariable(text: string, schemaIndex: number): string | null {
  const head = text.slice(Math.max(0, schemaIndex - 120), schemaIndex);
  const match = head.match(
    /(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:new\s+mongoose\.Schema\s*\()?\s*$/,
  );
  return match?.[1] ?? null;
}

/**
 * Normalise a Mongoose type expression into a readable type.
 */
function mongooseType(expression: string): string {
  const value = expression.trim();

  if (/^mongoose\.Schema\.Types\./i.test(value)) {
    return value.split(".").pop() ?? "ObjectId";
  }
  if (/^\[.*\]$/.test(value)) {
    const inner = value.slice(1, -1).trim();
    if (inner.startsWith("{")) return "Object[]";
    return `${mongooseType(inner)}[]`;
  }
  if (/^\{[\s\S]*\}$/.test(value)) return "Object";

  const simple = value.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  return simple?.[1] ?? "Mixed";
}

/**
 * The `required` flag of a Mongoose field.
 *
 * Mongoose accepts `required: true`, `required: false` and
 * `required: [value, 'message']`. In the array form the FIRST element is
 * the condition, so `required: [1, 'At least 1 guest is required']` is a
 * truthy condition and the field IS required.
 *
 * @param expression the raw VALUE of the `required` option
 * @returns whether the field is required
 */
function mongooseRequired(expression: string): boolean {
  const value = expression.trim();
  if (value === "true") return true;
  if (value === "false") return false;

  if (!value.startsWith("[")) return false;

  const first = value.slice(1).split(",")[0]!.trim();
  if (first === "true") return true;
  if (first === "false") return false;
  const numeric = Number(first);
  if (!Number.isNaN(numeric)) return numeric !== 0;
  return first.length > 0;
}

/**
 * The `ref` of a Mongoose field, when it points at another model.
 *
 * @param expression the raw value of the `ref` option
 * @returns the referenced model name, or `null`
 */
function mongooseRefValue(expression: string): string | null {
  const match = expression.match(/['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/);
  return match?.[1] ?? null;
}

/**
 * The `ref` of a Mongoose field, read from the top-level options.
 */
function refExpression(
  entries: Array<{ key: string; value: string }>,
): string | null {
  const value = optionValue(entries, "ref");
  return value ? mongooseRefValue(value) : null;
}

/**
 * The top-level `key: value` pairs of an object literal body.
 */
function objectEntries(body: string): Array<{ key: string; value: string }> {
  return splitTopLevel(body).map((entry) => {
    const separator = entry.indexOf(":");
    if (separator === -1) return { key: entry.trim(), value: "" };
    return {
      key: entry.slice(0, separator).trim().replace(/^['"`]|['"`]$/g, ""),
      value: entry.slice(separator + 1).trim(),
    };
  });
}

/**
 * The value of one top-level key of an object literal.
 */
function optionValue(
  entries: Array<{ key: string; value: string }>,
  key: string,
): string | null {
  return entries.find((entry) => entry.key === key)?.value ?? null;
}

/**
 * Parse one entry of a Mongoose schema literal.
 *
 * @param entry the `key: value` text
 * @returns the field, or `null` when the entry is not a field
 */
function parseMongooseField(entry: string): RawField | null {
  const separator = entry.indexOf(":");
  if (separator === -1) return null;

  const name = entry.slice(0, separator).trim().replace(/^['"`]|['"`]$/g, "");
  if (!name) return null;

  const value = entry.slice(separator + 1).trim();

  // `field: String` - a bare type.
  if (!value.startsWith("{") && !value.startsWith("[")) {
    return { name, type: mongooseType(value), required: false };
  }

  // `field: { type: String, required: true, ref: 'X' }`.
  if (value.startsWith("{")) {
    const close = matchBracket(value, 0, "{", "}");
    const inner = close === -1 ? value.slice(1) : value.slice(1, close);
    const entries = objectEntries(inner);

    const typeExpression = optionValue(entries, "type");
    const requiredExpression = optionValue(entries, "required");
    const ref = refExpression(entries);

    return {
      name,
      type: typeExpression ? mongooseType(typeExpression) : "Object",
      required: requiredExpression ? mongooseRequired(requiredExpression) : false,
      ...(ref ? { relation: ref } : {}),
    };
  }

  // `field: [{ type: ObjectId, ref: 'X' }]` or `field: [String]`.
  const close = matchBracket(value, 0, "[", "]");
  const inner = close === -1 ? value.slice(1) : value.slice(1, close);
  const trimmed = inner.trim();

  if (trimmed.startsWith("{")) {
    const objectClose = matchBracket(trimmed, 0, "{", "}");
    const body = objectClose === -1 ? trimmed.slice(1) : trimmed.slice(1, objectClose);
    const entries = objectEntries(body);

    const typeExpression = optionValue(entries, "type");
    const requiredExpression = optionValue(entries, "required");
    const ref = refExpression(entries);

    return {
      name,
      type: typeExpression ? `${mongooseType(typeExpression)}[]` : "Object[]",
      required: requiredExpression ? mongooseRequired(requiredExpression) : false,
      ...(ref ? { relation: ref } : {}),
    };
  }

  return {
    name,
    type: `${mongooseType(trimmed)}[]`,
    required: false,
  };
}

/**
 * Does the schema literal ask Mongoose for timestamps?
 *
 * The options object is the second argument of `new mongoose.Schema(...)`,
 * so the scan is limited to that object: a later schema in the same file
 * must not lend its `timestamps` flag to an earlier one.
 */
function mongooseHasTimestamps(text: string, schemaEnd: number): boolean {
  // `schemaEnd` is the index of the schema's closing brace, so the options
  // object starts after it.
  const tail = text.slice(schemaEnd + 1, schemaEnd + 401).trimStart();
  if (!tail.startsWith(",")) return false;

  const open = tail.indexOf("{");
  if (open === -1) return false;

  const close = matchBracket(tail, open, "{", "}");
  if (close === -1) return false;

  return /timestamps\s*:\s*true/.test(tail.slice(open, close));
}

/**
 * Extract the Mongoose models of a file.
 *
 * @param text the file body
 * @returns the models, in the order they are declared
 */
export function extractMongooseModels(text: string): RawEntity[] {
  const entities: RawEntity[] = [];

  const schemaPattern = /new\s+mongoose\.Schema\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = schemaPattern.exec(text)) !== null) {
    const open = text.indexOf("{", match.index + match[0].length);
    if (open === -1) continue;

    const close = matchBracket(text, open, "{", "}");
    if (close === -1) continue;

    const body = text.slice(open + 1, close);
    const variable = mongooseSchemaVariable(text, match.index);
    const name = mongooseModelName(text, variable) ?? "Model";

    const entity: RawEntity = { name, fields: [], relations: [] };

    for (const entry of splitTopLevel(body)) {
      const field = parseMongooseField(entry);
      if (!field) continue;
      entity.fields.push(field);

      if (field.relation) {
        const isArray = field.type.endsWith("[]");
        entity.relations.push({
          from: name,
          to: field.relation,
          label: field.name,
          kind: isArray ? "n-n" : "1-n",
        });
      }
    }

    if (mongooseHasTimestamps(text, close)) {
      // `timestamps: true` really does add these two columns to every
      // document, so they belong in the diagram.
      entity.fields.push({ name: "createdAt", type: "Date", required: true });
      entity.fields.push({ name: "updatedAt", type: "Date", required: true });
    }

    entities.push(entity);
    schemaPattern.lastIndex = close;
  }

  return entities;
}

/* ------------------------------------------------------------------ */
/* Building the document                                               */
/* ------------------------------------------------------------------ */

/** The document that is written to `content/datamodel/<projectId>.json`. */
interface DataModelDocument {
  project: string;
  generatedBy: string;
  source: string;
  entities: Array<{
    name: string;
    fields: Array<{
      name: string;
      type: string;
      required?: boolean;
      relation?: string;
    }>;
    relations?: Array<{
      from: string;
      to: string;
      label: string;
      kind: "1-1" | "1-n" | "n-n";
    }>;
  }>;
}

/**
 * Merge the extracted tables into one deterministic document.
 */
function buildDocument(
  project: string,
  source: string,
  entities: RawEntity[],
): DataModelDocument {
  const byName = new Map<string, RawEntity>();
  for (const entity of entities) {
    const existing = byName.get(entity.name);
    if (!existing) {
      byName.set(entity.name, entity);
      continue;
    }
    // The same table declared twice (a migration that re-creates it): keep
    // the fields of both, first writer wins for a repeated field.
    for (const field of entity.fields) {
      if (!existing.fields.some((item) => item.name === field.name)) {
        existing.fields.push(field);
      }
    }
    existing.relations.push(...entity.relations);
  }

  const sorted = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return {
    project,
    generatedBy: "scripts/index/datamodel.ts",
    source,
    entities: sorted.map((entity) => {
      const relations = [...entity.relations]
        .filter(
          (relation, index, all) =>
            all.findIndex(
              (other) =>
                other.from === relation.from &&
                other.to === relation.to &&
                other.label === relation.label,
            ) === index,
        )
        .sort((a, b) =>
          `${a.from}${a.to}${a.label}`.localeCompare(`${b.from}${b.to}${b.label}`),
        );

      return {
        name: entity.name,
        fields: entity.fields.map((field) => ({
          name: field.name,
          type: field.type,
          ...(field.required ? { required: true } : {}),
          ...(field.relation ? { relation: field.relation } : {}),
        })),
        ...(relations.length ? { relations } : {}),
      };
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  loadLocalEnv();
  const options = parseArgs(process.argv.slice(2));

  const sources = options.project
    ? SCHEMA_SOURCES.filter((source) => source.project === options.project)
    : SCHEMA_SOURCES;

  if (sources.length === 0) {
    console.error(
      `No data model source for "${options.project}". Known ids: ${SCHEMA_SOURCES.map(
        (source) => source.project,
      ).join(", ")}.`,
    );
    process.exitCode = 2;
    return;
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is not set. Add it to .env.local (pooled) or pass it in the environment.",
    );
    process.exitCode = 2;
    return;
  }

  console.log("=".repeat(78));
  console.log("kaustubh-portfolio :: data model generator");
  console.log("=".repeat(78));
  console.log(`mode      : ${options.dryRun ? "dry-run" : "write"}`);
  console.log(`projects  : ${sources.map((source) => source.project).join(", ")}`);
  console.log("");

  const pool = createPgPool(databaseUrl, { max: 2 });

  try {
    for (const source of sources) {
      const files = new Map<string, string>();

      if (source.indexed?.length) {
        const indexed = await readIndexedFiles(pool, source);
        for (const [file, body] of indexed) files.set(file, body);
      }

      if (source.local?.length) {
        for (const relative of source.local) {
          const { path: file, body } = readLocalFile(source.project, relative);
          files.set(file, body);
        }
      }

      if (files.size === 0) {
        console.warn(`[${source.project}] no schema source found - skipped.`);
        continue;
      }

      const entities: RawEntity[] = [];
      for (const [, body] of files) {
        entities.push(...extractSqlTables(body));
        entities.push(...extractMongooseModels(body));
      }

      if (entities.length === 0) {
        console.warn(`[${source.project}] no tables found - skipped.`);
        continue;
      }

      const document = buildDocument(
        source.project,
        source.note ?? [...files.keys()].sort().join(", "),
        entities,
      );

      const target = path.join(
        process.cwd(),
        "content",
        "datamodel",
        `${source.project}.json`,
      );

      const serialised = `${JSON.stringify(document, null, 2)}\n`;

      if (options.dryRun) {
        console.log(`[${source.project}] would write ${target}`);
        console.log(serialised);
      } else {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, serialised, "utf8");
        console.log(
          `[${source.project}] wrote ${document.entities.length} entities to ${path.relative(
            process.cwd(),
            target,
          )}`,
        );
        console.log(
          `           sources: ${[...files.keys()].sort().join(", ")}`,
        );
      }
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

await main();
