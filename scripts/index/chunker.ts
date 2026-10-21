import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { contentHash } from "./hash.js";
import { buildHeader, extractImports, type ImportTree } from "./header.js";
import type { Chunk, ChunkKind, ParserKind, ProjectDef } from "./types.js";

/**
 * Tree-sitter AST chunker.
 *
 * Every chunk is line-exact: `content` is literally the source lines
 * `[startLine..endLine]` of the file, 1-indexed. The downstream citation
 * validator quotes those lines back, so an off-by-one breaks every citation.
 */

/* ------------------------------------------------------------------ */
/* Tree-sitter plumbing (lazily loaded, WASM only)                     */
/* ------------------------------------------------------------------ */

/** Minimal structural view of a tree-sitter node. */
export interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  hasError: boolean;
  namedChildCount: number;
  namedChild(index: number): TsNode | null;
  childForFieldName(field: string): TsNode | null;
}

/** Minimal structural view of a tree-sitter tree. */
export interface TsTree {
  rootNode: TsNode;
}

/** Minimal structural view of the `web-tree-sitter` module. */
interface TreeSitterModule {
  Parser: {
    init(options?: unknown): Promise<void>;
    new (): { setLanguage(lang: unknown): unknown; parse(input: string): TsTree };
  };
  Language: { load(input: string | Uint8Array): Promise<unknown> };
}

let parserModule: TreeSitterModule | null = null;
let parserInit: Promise<void> | null = null;
const languageCache = new Map<string, unknown>();

/** Load `web-tree-sitter` and initialise the WASM runtime once. */
async function initParser(): Promise<TreeSitterModule> {
  if (!parserModule) {
    const mod = (await import("web-tree-sitter")) as unknown as TreeSitterModule;
    parserModule = mod;
  }
  if (!parserInit) {
    parserInit = parserModule.Parser.init();
  }
  await parserInit;
  return parserModule;
}

/** Absolute path of a grammar inside the `tree-sitter-wasms` package. */
function resolveWasm(wasmFile: string): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require.resolve("tree-sitter-wasms/package.json");
    const candidate = path.join(path.dirname(pkg), "out", wasmFile);
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Language configuration                                              */
/* ------------------------------------------------------------------ */

/** Languages the chunker understands. */
export type LangKey =
  | "python"
  | "javascript"
  | "typescript"
  | "tsx"
  | "dart"
  | "sql"
  | "html"
  | "css"
  | "yaml"
  | "json"
  | "markdown"
  | "text"
  | "unknown";

interface LangSpec {
  /** Grammar file inside `tree-sitter-wasms/out`. */
  wasm: string | null;
  /** Node types treated as chunkable units. */
  chunkTypes: Set<string>;
  /** Extra chunkable predicate (used for `lexical_declaration` + arrow function). */
  extraChunkable?: (node: TsNode) => boolean;
}

const JS_CHUNK_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "method_definition",
  "lexical_declaration",
]);

const LANG_SPECS: Record<LangKey, LangSpec> = {
  python: {
    wasm: "tree-sitter-python.wasm",
    chunkTypes: new Set(["function_definition", "class_definition"]),
  },
  javascript: {
    wasm: "tree-sitter-javascript.wasm",
    chunkTypes: JS_CHUNK_TYPES,
    extraChunkable: (node) =>
      node.type === "lexical_declaration" && containsFunctionExpression(node),
  },
  typescript: {
    wasm: "tree-sitter-typescript.wasm",
    chunkTypes: JS_CHUNK_TYPES,
    extraChunkable: (node) =>
      node.type === "lexical_declaration" && containsFunctionExpression(node),
  },
  tsx: {
    wasm: "tree-sitter-tsx.wasm",
    chunkTypes: JS_CHUNK_TYPES,
    extraChunkable: (node) =>
      node.type === "lexical_declaration" && containsFunctionExpression(node),
  },
  dart: {
    wasm: "tree-sitter-dart.wasm",
    chunkTypes: new Set(["function_signature", "class_definition", "method_signature"]),
  },
  // SQL: no WASM grammar is available in the pinned grammar bundle, so SQL
  // files degrade to the sliding-window fallback.
  sql: { wasm: null, chunkTypes: new Set() },
  html: { wasm: null, chunkTypes: new Set() },
  css: { wasm: null, chunkTypes: new Set() },
  yaml: { wasm: null, chunkTypes: new Set() },
  json: { wasm: null, chunkTypes: new Set() },
  markdown: { wasm: null, chunkTypes: new Set() },
  text: { wasm: null, chunkTypes: new Set() },
  unknown: { wasm: null, chunkTypes: new Set() },
};

/** Node types we descend into instead of treating as a leaf unit. */
const DESCEND_INTO = new Set(["class_definition", "class_declaration"]);

/** Maximum number of lines in a single chunk. */
export const MAX_CHUNK_LINES = 80;

/** Units shorter than this are merged with the following sibling. */
export const MIN_UNIT_LINES = 6;

/** Sliding window geometry used when no AST is available. */
export const WINDOW_LINES = 40;
export const WINDOW_OVERLAP = 10;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** Map a file extension to a language key. */
export function detectLanguage(filePath: string): LangKey {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".py":
    case ".pyi":
      return "python";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".jsx":
      return "tsx";
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".dart":
      return "dart";
    case ".sql":
      return "sql";
    case ".html":
    case ".htm":
      return "html";
    case ".css":
      return "css";
    case ".yaml":
    case ".yml":
      return "yaml";
    case ".json":
      return "json";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".txt":
      return "text";
    default:
      return "unknown";
  }
}

/**
 * Split raw file content into lines.
 *
 * The split keeps `\r` so that joining the lines with `\n` reproduces the
 * original bytes exactly (CRLF files stay CRLF).
 */
export function splitLines(content: string): string[] {
  const parts = content.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/** Exact source text of lines `[startLine..endLine]` (1-indexed, inclusive). */
export function sliceLines(lines: string[], startLine: number, endLine: number): string {
  return lines.slice(Math.max(0, startLine - 1), endLine).join("\n");
}

/** True when a line contains only whitespace. */
export function isBlank(line: string | undefined): boolean {
  return !line || line.trim().length === 0;
}

/** True when the subtree contains an arrow function or function expression. */
function containsFunctionExpression(node: TsNode): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === "arrow_function" || child.type === "function_expression") {
      return true;
    }
    if (containsFunctionExpression(child)) return true;
  }
  return false;
}

/** True when the node is a chunkable unit for the given language. */
function isChunkable(node: TsNode, spec: LangSpec): boolean {
  if (spec.chunkTypes.has(node.type)) return true;
  if (spec.extraChunkable) return spec.extraChunkable(node);
  return false;
}

/** Best-effort symbol name of a node. */
export function symbolOf(node: TsNode): string {
  if (node.type === "lexical_declaration" || node.type === "variable_declarator") {
    const declarator =
      node.type === "lexical_declaration"
        ? findChild(node, "variable_declarator")
        : node;
    if (declarator) {
      const name = declarator.childForFieldName("name");
      if (name) return name.text;
    }
    return "";
  }
  const named = node.childForFieldName("name");
  if (named) return named.text;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (
      child.type === "identifier" ||
      child.type === "type_identifier" ||
      child.type === "simple_identifier"
    ) {
      return child.text;
    }
  }
  return "";
}

function findChild(node: TsNode, type: string): TsNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && child.type === type) return child;
  }
  return null;
}

/** True when a symbol looks like a React component (upper case first letter). */
function isComponentName(symbol: string): boolean {
  return /^[A-Z]/.test(symbol);
}

/** Map a node type + symbol onto a chunk kind. */
export function kindOf(node: TsNode, symbol: string): ChunkKind {
  switch (node.type) {
    case "class_definition":
    case "class_declaration":
      return "class";
    case "method_definition":
    case "method_signature":
      return "method";
    case "lexical_declaration":
    case "function_declaration":
    case "generator_function_declaration":
    case "function_definition":
    case "function_signature":
      return isComponentName(symbol) ? "component" : "function";
    default:
      return "function";
  }
}

/* ------------------------------------------------------------------ */
/* Unit extraction                                                     */
/* ------------------------------------------------------------------ */

/** An intermediate chunkable unit, before it becomes a {@link Chunk}. */
interface Unit {
  startLine: number;
  endLine: number;
  kind: ChunkKind;
  symbol: string;
  symbols: string[];
}

interface Ctx {
  spec: LangSpec;
  classStack: string[];
}

function makeUnit(node: TsNode, ctx: Ctx): Unit {
  const baseSymbol = symbolOf(node);
  const kind = kindOf(node, baseSymbol);
  let symbol = baseSymbol;
  if (kind === "method" && ctx.classStack.length > 0) {
    symbol = `${ctx.classStack[ctx.classStack.length - 1]}.${baseSymbol}`;
  }
  return {
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    kind,
    symbol,
    symbols: symbol ? [symbol] : [],
  };
}

/**
 * Merge units that are shorter than {@link MIN_UNIT_LINES} with the following
 * sibling, as long as the merged result stays within {@link MAX_CHUNK_LINES}.
 */
export function mergeSmallUnits(units: Unit[]): void {
  let i = 0;
  while (i < units.length - 1) {
    const current = units[i];
    if (current.endLine - current.startLine + 1 >= MIN_UNIT_LINES) {
      i++;
      continue;
    }
    const next = units[i + 1];
    if (!next) break;
    if (next.startLine <= current.endLine) {
      i++;
      continue;
    }
    if (next.endLine - current.startLine + 1 > MAX_CHUNK_LINES) {
      i++;
      continue;
    }
    current.endLine = next.endLine;
    for (const symbol of next.symbols) {
      if (!current.symbols.includes(symbol)) current.symbols.push(symbol);
    }
    if (!current.symbol && next.symbol) current.symbol = next.symbol;
    if (current.kind === "block" && next.kind !== "block") current.kind = next.kind;
    units.splice(i + 1, 1);
  }
}

/** Collect the units of every child of `node`. */
function collectChildren(node: TsNode, ctx: Ctx): Unit[] {
  const units: Unit[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    units.push(...visit(child, ctx));
  }
  mergeSmallUnits(units);
  return units;
}

/**
 * Recursive unit extraction.
 *
 * - A chunkable node that is not a class is a leaf unit: its body is not
 *   descended into, so the outermost symbol always wins.
 * - A class is descended into so that every method becomes its own unit; the
 *   class header and closing brace are absorbed into the first/last method.
 */
function visit(node: TsNode, ctx: Ctx): Unit[] {
  if (!isChunkable(node, ctx.spec)) {
    return collectChildren(node, ctx);
  }

  if (!DESCEND_INTO.has(node.type)) {
    return [makeUnit(node, ctx)];
  }

  const className = symbolOf(node);
  ctx.classStack.push(className);
  const childUnits = collectChildren(node, ctx);
  ctx.classStack.pop();

  if (childUnits.length === 0) {
    return [makeUnit(node, ctx)];
  }

  const first = childUnits[0];
  const last = childUnits[childUnits.length - 1];
  first.startLine = Math.min(first.startLine, node.startPosition.row + 1);
  last.endLine = Math.max(last.endLine, node.endPosition.row + 1);
  if (className && !first.symbols.includes(className)) {
    first.symbols.unshift(className);
  }
  return childUnits;
}

/**
 * Lines that no unit covers. They are emitted as `block` chunks so that every
 * non-blank line of the file appears in exactly one chunk.
 */
export function computeRemainder(lines: string[], units: Unit[]): Unit[] {
  const lineCount = lines.length;
  const covered = new Uint8Array(lineCount + 2);
  for (const unit of units) {
    const from = Math.max(1, unit.startLine);
    const to = Math.min(lineCount, unit.endLine);
    for (let line = from; line <= to; line++) covered[line] = 1;
  }

  const remainder: Unit[] = [];
  let line = 1;
  while (line <= lineCount) {
    if (covered[line] || isBlank(lines[line - 1])) {
      line++;
      continue;
    }
    let end = line;
    while (end + 1 <= lineCount && !covered[end + 1] && !isBlank(lines[end])) {
      end++;
    }
    remainder.push({
      startLine: line,
      endLine: end,
      kind: "block",
      symbol: "",
      symbols: [],
    });
    line = end + 1;
  }
  return remainder;
}

/** Split units that are longer than {@link MAX_CHUNK_LINES}. */
export function splitLargeUnits(units: Unit[]): Unit[] {
  const out: Unit[] = [];
  for (const unit of units) {
    if (unit.endLine - unit.startLine + 1 <= MAX_CHUNK_LINES) {
      out.push(unit);
      continue;
    }
    let start = unit.startLine;
    while (start <= unit.endLine) {
      const end = Math.min(start + MAX_CHUNK_LINES - 1, unit.endLine);
      out.push({ ...unit, startLine: start, endLine: end });
      start = end + 1;
    }
  }
  return out;
}

/** Sliding-window fallback: 40 lines with 10 lines of overlap. */
export function windowUnits(lineCount: number): Unit[] {
  const units: Unit[] = [];
  if (lineCount <= 0) return units;
  let start = 1;
  while (start <= lineCount) {
    const end = Math.min(start + WINDOW_LINES - 1, lineCount);
    units.push({ startLine: start, endLine: end, kind: "block", symbol: "", symbols: [] });
    if (end >= lineCount) break;
    start = end - WINDOW_OVERLAP + 1;
  }
  return units;
}

/* ------------------------------------------------------------------ */
/* Coverage verification                                               */
/* ------------------------------------------------------------------ */

/** Result of the line-coverage check for a single file. */
export interface CoverageResult {
  /** Non-blank lines that no chunk covers. */
  gaps: number[];
  /** Lines covered by more than one chunk. */
  duplicates: number[];
  /** True when the file is covered exactly once (no gaps, no duplicates). */
  exact: boolean;
  /** True when every non-blank line is covered at least once. */
  complete: boolean;
}

/**
 * Verify that the union of the chunk line ranges covers every non-blank line.
 *
 * `tree-sitter` chunks must cover every non-blank line exactly once. Sliding
 * window chunks overlap by design, so they may contain duplicates - those are
 * reported but are not a failure.
 */
export function verifyCoverage(lines: string[], chunks: Chunk[]): CoverageResult {
  const lineCount = lines.length;
  const hits = new Int32Array(lineCount + 2);
  for (const chunk of chunks) {
    const from = Math.max(1, chunk.startLine);
    const to = Math.min(lineCount, chunk.endLine);
    for (let line = from; line <= to; line++) hits[line]++;
  }
  const gaps: number[] = [];
  const duplicates: number[] = [];
  for (let line = 1; line <= lineCount; line++) {
    if (isBlank(lines[line - 1])) continue;
    if (hits[line] === 0) gaps.push(line);
    else if (hits[line] > 1) duplicates.push(line);
  }
  return {
    gaps,
    duplicates,
    exact: gaps.length === 0 && duplicates.length === 0,
    complete: gaps.length === 0,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Options for {@link chunkFile}. */
export interface ChunkFileOptions {
  project: ProjectDef;
  /** Repo-relative POSIX path. */
  relPath: string;
  /** Raw file content. */
  content: string;
  /** Repository display name used in the header. */
  repoName: string;
}

/**
 * Chunk a single file.
 *
 * Falls back to a sliding window when the language has no grammar, the
 * grammar cannot be loaded or the parse throws.
 */
export async function chunkFile(options: ChunkFileOptions): Promise<Chunk[]> {
  const { project, relPath, content, repoName } = options;
  const language = detectLanguage(relPath);
  const lines = splitLines(content);
  const lineCount = lines.length;

  if (lineCount === 0) return [];

  const spec = LANG_SPECS[language] ?? LANG_SPECS.unknown;
  let tree: TsTree | null = null;
  let parserKind: ParserKind = "window";

  if (spec.wasm) {
    try {
      const mod = await initParser();
      const wasmPath = resolveWasm(spec.wasm);
      if (wasmPath) {
        let lang = languageCache.get(language);
        if (!lang) {
          lang = await mod.Language.load(wasmPath);
          languageCache.set(language, lang);
        }
        const instance = new mod.Parser();
        instance.setLanguage(lang);
        tree = instance.parse(content);
        parserKind = "tree-sitter";
      }
    } catch {
      tree = null;
      parserKind = "window";
    }
  }

  let units: Unit[];
  if (tree && parserKind === "tree-sitter") {
    try {
      const ctx: Ctx = { spec, classStack: [] };
      const astUnits = visit(tree.rootNode, ctx);
      // The AST units plus the leftover lines become the final unit list.
      units = [...astUnits, ...computeRemainder(lines, astUnits)];
      units = splitLargeUnits(units);
    } catch {
      units = windowUnits(lineCount);
      parserKind = "window";
    }
  } else {
    units = windowUnits(lineCount);
    parserKind = "window";
  }

  const imports = extractImports(content, language, (tree ?? null) as ImportTree | null);

  const chunks: Chunk[] = [];
  for (const unit of units) {
    const startLine = Math.max(1, unit.startLine);
    const endLine = Math.min(lineCount, unit.endLine);
    if (endLine < startLine) continue;
    const chunkContent = sliceLines(lines, startLine, endLine);
    const header = buildHeader({
      repoName,
      repoSha: project.repoSha,
      path: relPath,
      symbol: unit.symbol,
      kind: unit.kind,
      startLine,
      endLine,
      imports,
    });
    chunks.push({
      projectId: project.id,
      repoSha: project.repoSha,
      path: relPath,
      startLine,
      endLine,
      kind: unit.kind,
      symbol: unit.symbol,
      symbols: unit.symbols.length > 0 ? unit.symbols : unit.symbol ? [unit.symbol] : [],
      content: chunkContent,
      header,
      parser: parserKind,
      language,
      contentHash: contentHash([chunkContent]),
    });
  }

  return chunks;
}

/**
 * Chunk every file of a project.
 *
 * @param files   repo-relative paths to chunk
 * @param readFile reader, injected by tests
 */
export async function chunkProject(
  project: ProjectDef,
  repoName: string,
  files: string[],
  readFile: (absolutePath: string) => string,
): Promise<{ chunks: Chunk[]; coverage: Map<string, CoverageResult> }> {
  const chunks: Chunk[] = [];
  const coverage = new Map<string, CoverageResult>();
  for (const relPath of files) {
    let content: string;
    try {
      content = readFile(path.join(project.repoPath, relPath));
    } catch {
      continue;
    }
    const fileChunks = await chunkFile({ project, relPath, content, repoName });
    chunks.push(...fileChunks);
    coverage.set(relPath, verifyCoverage(splitLines(content), fileChunks));
  }
  return { chunks, coverage };
}
