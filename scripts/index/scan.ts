import { readFileSync } from "node:fs";
import path from "node:path";

import { resolveFiles } from "./allowlist.js";
import type { Finding, ProjectDef, ScanResult, Severity } from "./types.js";

/**
 * Secret and PII scanner.
 *
 * THIS IS A HARD GATE. Nothing is chunked before its raw content passes
 * `scanContent`. A `block` severity finding aborts the whole project.
 *
 * Raw secrets are NEVER stored in a finding: only the rule id plus a redacted
 * preview (first four characters + length) are kept.
 */

/** The owner's own personal data that must never end up in the index. */
export const PERSONAL_PHONE = "9975526627";
export const PERSONAL_EMAIL = "kaustubh.kale.work@gmail.com";

interface Rule {
  id: string;
  severity: Severity;
  pattern: RegExp;
}

/**
 * Patterns that MUST fail. Ordered so the most specific rules run first.
 */
export const RULES: Rule[] = [
  {
    id: "postgres-url-inline-password",
    severity: "block",
    pattern: /postgres(?:ql)?:\/\/[^\s:/@]+:[^\s:/@]+@/gi,
  },
  {
    id: "mongodb-url-inline-password",
    severity: "block",
    pattern: /mongodb(?:\+srv)?:\/\/[^\s:/@]+:[^\s:/@]+@/gi,
  },
  {
    id: "private-key-block",
    severity: "block",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    id: "jwt",
    severity: "block",
    pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "openai-style-api-key",
    severity: "block",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: "google-api-key",
    severity: "block",
    pattern: /\bAIzaSy[A-Za-z0-9_-]{30,}\b/g,
  },
  {
    id: "supabase-secret-key",
    severity: "block",
    pattern: /\bsb_secret_[A-Za-z0-9_-]{10,}\b/g,
  },
  {
    id: "supabase-management-token",
    severity: "block",
    pattern: /\bsbp_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: "stripe-live-key",
    severity: "block",
    pattern: /\bnt_live_[A-Za-z0-9]{10,}\b/g,
  },
  {
    id: "authorization-bearer-token",
    severity: "block",
    pattern: /authorization\s*:\s*bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  },
  {
    id: "pii-personal-phone",
    severity: "block",
    pattern: new RegExp(`\\b${PERSONAL_PHONE}\\b`, "g"),
  },
  {
    id: "pii-personal-email",
    severity: "block",
    pattern: new RegExp(PERSONAL_EMAIL.replace(/\./g, "\\."), "gi"),
  },
];

/**
 * YAML / JS keys whose value is usually a credential.
 *
 * Only quoted string literals are considered, so `password: user.password`
 * and `api_key: os.environ.get("X")` are not flagged.
 */
const CONFIG_KEY_PATTERN = /["']?([A-Za-z0-9_.-]+)["']?\s*[:=]\s*(["'])([^"'\n]*)\2/gi;

/** Characters that end a string literal - a key inside a string is not a key. */
const QUOTE_CHARS = new Set(["'", '"', "`"]);

/** Values that are obviously placeholders rather than real credentials. */
const PLACEHOLDER_MARKERS = [
  "your_",
  "your-",
  "yourkey",
  "<",
  "xxx",
  "example",
  "changeme",
  "replace",
  "todo",
  "none",
  "null",
  "undefined",
  "dummy",
  "fake",
  "test-key",
  "mock",
];

/** True when the value looks like a placeholder rather than a real credential. */
export function isPlaceholderValue(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (v === "") return true;
  return PLACEHOLDER_MARKERS.some((marker) => v.includes(marker));
}

/**
 * True when a key name looks like a credential key.
 *
 * The key must END with `password` / `api_key` / `apikey` so that human
 * readable keys such as `passwordNotice` or `temporaryPasswordNotice` are not
 * treated as credentials.
 */
export function isCredentialKey(key: string): boolean {
  const k = key.toLowerCase();
  return k.endsWith("password") || k.endsWith("api_key") || k.endsWith("apikey");
}

/**
 * True when the key sits in a real key position.
 *
 * A key that only appears inside a string literal (`console.error('API_KEY:')`)
 * is not a key, so a preceding quote disqualifies the match.
 */
export function hasKeyContext(content: string, matchIndex: number): boolean {
  let i = matchIndex - 1;
  while (i >= 0 && /\s/.test(content[i])) i--;
  if (i < 0) return true;
  return !QUOTE_CHARS.has(content[i]);
}

/** Redact a secret: keep the first four characters and the length, drop the rest. */
export function redact(match: string): string {
  const head = match.slice(0, 4);
  return `${head}…(len=${match.length})`;
}

/** Translate a character offset into a 1-indexed line / column pair. */
export function locate(content: string, index: number): { line: number; column: number } {
  let line = 1;
  let lastBreak = -1;
  const limit = Math.min(index, content.length);
  for (let i = 0; i < limit; i++) {
    if (content.charCodeAt(i) === 10) {
      line++;
      lastBreak = i;
    }
  }
  return { line, column: limit - lastBreak };
}

/**
 * Scan a blob of text.
 *
 * @param content raw file content
 * @param file    repo-relative path, used to label findings
 */
export function scanContent(content: string, file = "<inline>"): ScanResult {
  const findings: Finding[] = [];

  for (const rule of RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      if (match[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const { line, column } = locate(content, match.index);
      findings.push({
        file,
        line,
        column,
        rule: rule.id,
        match: redact(match[0]),
        severity: rule.severity,
      });
    }
  }

  // YAML / JS credential keys with a literal string value.
  const configRe = new RegExp(CONFIG_KEY_PATTERN.source, CONFIG_KEY_PATTERN.flags);
  let configMatch: RegExpExecArray | null;
  while ((configMatch = configRe.exec(content)) !== null) {
    if (configMatch[0].length === 0) {
      configRe.lastIndex++;
      continue;
    }
    const key = configMatch[1] ?? "";
    const value = configMatch[3] ?? "";
    if (!isCredentialKey(key)) continue;
    if (!hasKeyContext(content, configMatch.index)) continue;
    if (value.trim() === "") {
      // Empty value: nothing leaked, nothing suspicious.
      continue;
    }
    const { line, column } = locate(content, configMatch.index);
    const placeholder = isPlaceholderValue(value);
    findings.push({
      file,
      line,
      column,
      rule: placeholder ? "config-placeholder-value" : "hardcoded-secret-value",
      match: `${key}: ${redact(value)}`,
      severity: placeholder ? "warn" : "block",
    });
  }

  findings.sort((a, b) => a.line - b.line || a.column - b.column || a.rule.localeCompare(b.rule));

  return {
    ok: !findings.some((f) => f.severity === "block"),
    findings,
  };
}

/**
 * Scan every allow-listed file of a project.
 *
 * @param project project definition
 * @param readFile optional reader, used by tests to inject content
 */
export function scanProject(
  project: ProjectDef,
  readFile: (absolutePath: string) => string = (p) => readFileSync(p, "utf8"),
): Finding[] {
  const findings: Finding[] = [];
  for (const relPath of resolveFiles(project)) {
    let content: string;
    try {
      content = readFile(path.join(project.repoPath, relPath));
    } catch {
      continue;
    }
    findings.push(...scanContent(content, relPath).findings);
  }
  return findings;
}

/**
 * Redact owner PII in-place (same number of lines) so a project can still be
 * indexed when the owner's own contact details appear in public source code.
 *
 * Only the owner's own phone/email are touched. Real secrets are never
 * redacted - they must abort the project.
 */
export function redactOwnerPii(content: string): string {
  return content
    .replace(new RegExp(`\\b${PERSONAL_PHONE}\\b`, "g"), "[REDACTED_PHONE]")
    .replace(new RegExp(PERSONAL_EMAIL.replace(/\./g, "\\."), "gi"), "[REDACTED_EMAIL]");
}
