import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import type { ProjectDef } from "./types.js";

/**
 * Default-deny allow-list.
 *
 * A file is indexed only when it matches at least one `include` pattern of its
 * project AND matches none of the exclude patterns (global + project local)
 * AND does not trip one of the hard-coded deny rules below.
 */

/**
 * Excludes that apply to EVERY project.
 *
 * NOTE: `config.yaml` is intentionally absent. SmartApply's `config.yaml` holds
 * no secrets (its `ai.api_key` is the empty string) and is useful context for
 * retrieval, so it stays in the SmartApply include list and the scanner
 * verifies its emptiness at index time.
 */
export const GLOBAL_EXCLUDES: string[] = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "__pycache__",
  ".dart_tool",
  "coverage",
  "edge_profile",
  "dev-dist",
  "test_screenshots",
  "public/media",
  "*.min.js",
  "*.map",
  "*.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "*.pkl",
  "*.har",
  "*.log",
  "*.csv",
  ".env",
  ".env.*",
  "secrets.yaml",
];

/**
 * Hard deny rules. Any path containing one of these substrings (or a `.git`
 * path segment) is rejected no matter what the include list says.
 */
export const ALWAYS_DENY_SUBSTRINGS: string[] = [
  ".env",
  "node_modules",
  "edge_profile",
  "credential",
  "secret",
  "token.json",
  "gmail_credentials",
];

/** File extensions that are never treated as source. */
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".zip",
  ".gz",
  ".tgz",
  ".7z",
  ".rar",
  ".pdf",
  ".mp4",
  ".mp3",
  ".wav",
  ".webm",
  ".wasm",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".bin",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".pkl",
  ".npy",
  ".npz",
  ".onnx",
  ".pt",
  ".pth",
  ".h5",
]);

/** Normalise Windows separators to POSIX and strip leading `./` and trailing `/`. */
export function normalizePath(input: string): string {
  let p = String(input).replace(/\\/g, "/");
  while (p.startsWith("./")) p = p.slice(2);
  while (p.endsWith("/")) p = p.slice(0, -1);
  // Collapse `.` and `..` segments so a traversal attempt cannot smuggle a
  // path past the include patterns.
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else out.push("..");
      continue;
    }
    out.push(part);
  }
  return out.join("/");
}

/** True when the pattern contains glob metacharacters. */
export function isGlobPattern(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

/** Translate a single path segment into a regular expression fragment. */
function segmentToRegex(segment: string): string {
  return segment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
}

/**
 * Compile a glob into a regular expression.
 *
 * Supported syntax:
 *   - `*`  matches any run of characters inside a single path segment
 *   - `?`  matches exactly one character inside a single path segment
 *   - `**` matches any number of path segments (including none)
 *   - everything else is matched literally
 */
export function globToRegExp(pattern: string): RegExp {
  const segments = normalizePath(pattern).split("/").filter((s) => s.length > 0);
  let source = "^";
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const isLast = i === segments.length - 1;
    if (segment === "**") {
      if (isLast) {
        // Trailing `**` swallows the remainder of the path (possibly empty).
        source += "(?:[^/]+(?:/[^/]+)*)?";
      } else {
        // Interior `**` swallows zero or more complete segments (with separators).
        source += "(?:[^/]+/)*";
      }
      continue;
    }
    source += segmentToRegex(segment);
    if (!isLast) source += "/";
  }
  source += "$";
  return new RegExp(source);
}

/**
 * Match a path against a glob pattern.
 *
 * Both `\` and `/` are accepted as separators, so Windows paths work as-is.
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  const p = normalizePath(filePath);
  const pat = normalizePath(pattern);
  if (pat === "") return false;
  return globToRegExp(pat).test(p);
}

/** True when any ancestor directory of `relPath` equals the plain `pattern`. */
function hasAncestorSegment(relPath: string, pattern: string): boolean {
  const segments = relPath.split("/");
  const needle = pattern.split("/").filter(Boolean);
  if (needle.length === 0) return false;
  for (let i = 0; i + needle.length <= segments.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (segments[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Exclude matching is broader than include matching:
 *   - the pattern may match the path itself
 *   - a plain pattern also matches everything below that directory
 *   - a single-segment glob (`*.min.js`) also matches the basename at any depth
 */
export function matchesExclude(relPath: string, pattern: string): boolean {
  const p = normalizePath(relPath);
  const pat = normalizePath(pattern);
  if (pat === "") return false;
  if (matchesGlob(p, pat)) return true;
  if (!isGlobPattern(pat)) {
    if (p === pat || p.startsWith(`${pat}/`)) return true;
    if (hasAncestorSegment(p, pat)) return true;
    return false;
  }
  // Glob with a single segment (`*.min.js`, `*.map`, ...) applies to basenames.
  if (!pat.includes("/")) {
    const base = p.slice(p.lastIndexOf("/") + 1);
    if (matchesGlob(base, pat)) return true;
  }
  return false;
}

/** Hard deny rules that are always applied. */
export function isAlwaysDenied(relPath: string): boolean {
  const p = normalizePath(relPath).toLowerCase();
  if (p.split("/").includes(".git")) return true;
  for (const needle of ALWAYS_DENY_SUBSTRINGS) {
    if (p.includes(needle)) return true;
  }
  return false;
}

/** True when the path is excluded by the global or project-local exclude list. */
export function isExcluded(relPath: string, project: ProjectDef): boolean {
  const patterns = [...GLOBAL_EXCLUDES, ...(project.exclude ?? [])];
  return patterns.some((pattern) => matchesExclude(relPath, pattern));
}

/**
 * Default-deny decision.
 *
 * Returns true ONLY when the path matches an include pattern, matches no
 * exclude pattern and does not trip a hard deny rule.
 */
export function isAllowed(relPath: string, project: ProjectDef): boolean {
  const p = normalizePath(relPath);
  if (p === "") return false;
  if (isAlwaysDenied(p)) return false;
  if (isExcluded(p, project)) return false;
  const includes = project.include ?? [];
  return includes.some((pattern) => matchesGlob(p, pattern));
}

/** True when the file looks like binary content and must not be chunked. */
export function isBinaryPath(relPath: string): boolean {
  const ext = path.extname(relPath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

/**
 * Walk a repository and return every allow-listed, non-binary file as a
 * repo-relative POSIX path. Results are sorted for deterministic output.
 */
export function resolveFiles(project: ProjectDef): string[] {
  const root = project.repoPath;
  const found: string[] = [];
  if (!existsSync(root)) return found;

  const walk = (dir: string, rel: string): void => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as unknown as ReturnType<
        typeof readdirSync
      >;
    } catch {
      return;
    }
    for (const entry of entries as unknown as Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
    }>) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isAlwaysDenied(childRel)) continue;
        if (isExcluded(childRel, project)) continue;
        walk(absolute, childRel);
      } else if (entry.isFile()) {
        if (isBinaryPath(childRel)) continue;
        if (!isAllowed(childRel, project)) continue;
        found.push(childRel);
      }
    }
  };

  walk(root, "");
  return found.sort();
}

/** Total size in bytes of a repository (used for reporting only). */
export function repoSize(project: ProjectDef): number {
  if (!existsSync(project.repoPath)) return 0;
  try {
    return statSync(project.repoPath).size;
  } catch {
    return 0;
  }
}
