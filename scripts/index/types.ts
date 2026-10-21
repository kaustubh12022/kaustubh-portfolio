/**
 * Shared types for the code-indexing ingestion pipeline.
 *
 * The pipeline turns real source code from the owner's GitHub repositories into
 * retrievable chunks:
 *
 *   repo files -> allowlist (default deny) -> secret/PII scanner (hard gate)
 *               -> tree-sitter AST chunker -> contextual header -> chunks.json / Postgres
 */

/** Stable identifier for a project in the manifest. */
export type ProjectId =
  | "smartapply"
  | "pawna"
  | "c54"
  | "personal-ai-os"
  | "aura"
  | "dayscore"
  | "copilot";

/** A single project in the ingestion manifest. */
export interface ProjectDef {
  id: ProjectId;
  /** Human readable project name, used in headers and summaries. */
  name: string;
  /** Absolute path to the local clone of the repository. */
  repoPath: string;
  /** Remote origin URL of the repository. */
  repoUrl: string;
  /** Full 40 character commit SHA that was indexed. */
  repoSha: string;
  /** Branch the SHA was taken from. */
  defaultBranch: string;
  /** Allow-list of glob patterns. A file must match at least one to be indexed. */
  include: string[];
  /** Deny-list of glob patterns. A file matching any of these is never indexed. */
  exclude: string[];
  /** Languages present in the project (drives the summary and parser selection). */
  languages: string[];
}

/** The kind of construct a chunk represents. */
export type ChunkKind =
  | "function"
  | "class"
  | "method"
  | "component"
  | "statement"
  | "block";

/** Which parser produced the chunk. */
export type ParserKind = "tree-sitter" | "window";

/** A retrievable unit of source code. */
export interface Chunk {
  projectId: string;
  repoSha: string;
  /** Repo-relative POSIX path, e.g. `src/ai_engine.py`. */
  path: string;
  /** 1-indexed inclusive first line of the chunk. */
  startLine: number;
  /** 1-indexed inclusive last line of the chunk. */
  endLine: number;
  kind: ChunkKind;
  /** Best-effort name of the construct. Empty string when anonymous. */
  symbol: string;
  /** Every symbol name covered by the chunk (a merged chunk can carry several). */
  symbols: string[];
  /** Exact source text of lines `[startLine..endLine]`. */
  content: string;
  /** Contextual header prepended to `content` before embedding. */
  header: string;
  parser: ParserKind;
  language: string;
  /** sha256 of the content, truncated to 32 hex chars. */
  contentHash: string;
}

/** Severity of a scanner finding. `block` aborts the whole project. */
export type Severity = "block" | "warn";

/** A single scanner finding. Never contains the raw secret. */
export interface Finding {
  file: string;
  /** 1-indexed line number. */
  line: number;
  /** 1-indexed column number. */
  column: number;
  /** Stable rule identifier, e.g. `postgres-url-inline-password`. */
  rule: string;
  /** Redacted preview of the match (first 4 characters + length). */
  match: string;
  severity: Severity;
}

/** Result of scanning a single file. */
export interface ScanResult {
  /** True when no `block` severity finding was produced. */
  ok: boolean;
  findings: Finding[];
}

/** Per-project ingestion statistics. */
export interface ProjectStats {
  id: ProjectId;
  name: string;
  repoUrl: string;
  repoSha: string;
  filesScanned: number;
  filesChunked: number;
  chunksProduced: number;
  linesCovered: number;
  findings: number;
  blockFindings: number;
  warnFindings: number;
  status: "indexed" | "aborted" | "skipped";
  coverageFailures: string[];
}
