import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  GLOBAL_EXCLUDES,
  isAllowed,
  matchesExclude,
  matchesGlob,
  normalizePath,
} from "@/scripts/index/allowlist";
import {
  chunkFile,
  detectLanguage,
  sliceLines,
  splitLines,
  verifyCoverage,
} from "@/scripts/index/chunker";
import { buildHeader, extractImports } from "@/scripts/index/header";
import { chunkKey, contentHash } from "@/scripts/index/hash";
import { upsertChunks } from "@/scripts/index/index";
import { PROJECTS, getProject, repoName } from "@/scripts/index/projects";
import { scanContent } from "@/scripts/index/scan";

const smartapply = getProject("smartapply")!;
const pawna = getProject("pawna")!;
const c54 = getProject("c54")!;

/** The real SmartApply file used for the line-exactness and coverage proofs. */
const REAL_FILE = "src/ai_engine.py";
const REAL_FILE_ABS = path.join(smartapply.repoPath, REAL_FILE);
const hasRealFile = existsSync(REAL_FILE_ABS);

/* ------------------------------------------------------------------ */
/* glob matching                                                       */
/* ------------------------------------------------------------------ */

describe("matchesGlob", () => {
  it("matches `**` at any depth", () => {
    expect(matchesGlob("src/ai_engine.py", "src/**")).toBe(true);
    expect(matchesGlob("src/scrapers/naukri.py", "src/**")).toBe(true);
    expect(matchesGlob("src/a/b/c/d.py", "src/**")).toBe(true);
    expect(matchesGlob("frontend/src/App.jsx", "frontend/src/**")).toBe(true);
  });

  it("matches `**` patterns that address the repository root", () => {
    expect(matchesGlob("app.py", "*.py")).toBe(true);
    expect(matchesGlob("src/app.py", "*.py")).toBe(false);
  });

  it("matches `*` inside a single segment only", () => {
    expect(matchesGlob("a.min.js", "*.min.js")).toBe(true);
    // `*` never crosses a path separator, so a single segment glob is anchored
    // to the root. Exclude matching handles the basename case (see below).
    expect(matchesGlob("src/a.min.js", "*.min.js")).toBe(false);
    expect(matchesGlob("src/ai_engine.py", "src/*.py")).toBe(true);
    expect(matchesGlob("src/scrapers/naukri.py", "src/*.py")).toBe(false);
  });

  it("applies basename matching for single segment exclude globs", () => {
    expect(matchesExclude("src/a.min.js", "*.min.js")).toBe(true);
    expect(matchesExclude("src/deep/a.min.js", "*.min.js")).toBe(true);
    expect(matchesExclude("src/a.min.js", "*.map")).toBe(false);
    expect(matchesExclude("src/node_modules/x.js", "node_modules")).toBe(true);
    expect(matchesExclude("public/media/logo.png", "public/media")).toBe(true);
  });

  it("matches exact paths", () => {
    expect(matchesGlob("app.py", "app.py")).toBe(true);
    expect(matchesGlob("frontend/app.py", "app.py")).toBe(false);
    expect(matchesGlob("config.yaml", "config.yaml")).toBe(true);
  });

  it("normalises Windows backslashes to forward slashes", () => {
    expect(normalizePath("src\\ai_engine.py")).toBe("src/ai_engine.py");
    expect(matchesGlob("src\\ai_engine.py", "src/**")).toBe(true);
    expect(matchesGlob("backend\\routes\\authRoutes.js", "backend/**")).toBe(true);
    expect(matchesGlob("C:\\repos\\x\\src\\a.py", "src/**")).toBe(false);
  });

  it("does not match an empty pattern", () => {
    expect(matchesGlob("src/ai_engine.py", "")).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* allow-list: default deny                                            */
/* ------------------------------------------------------------------ */

describe("isAllowed (default deny)", () => {
  it("allows a file that matches an include pattern", () => {
    expect(isAllowed("src/ai_engine.py", smartapply)).toBe(true);
    expect(isAllowed("frontend/src/pages/Dashboard.jsx", smartapply)).toBe(true);
    expect(isAllowed("config.yaml", smartapply)).toBe(true);
    expect(isAllowed("backend/routes/authRoutes.js", pawna)).toBe(true);
    expect(isAllowed("src/components/Booking.jsx", pawna)).toBe(true);
    expect(isAllowed("init_tables.js", c54)).toBe(true);
  });

  it("rejects a file that is not under any include pattern", () => {
    expect(isAllowed("README.md", smartapply)).toBe(false);
    expect(isAllowed("requirements.txt", smartapply)).toBe(false);
    expect(isAllowed("src/../config/profile.json", smartapply)).toBe(false);
    expect(isAllowed("docs/architecture.md", smartapply)).toBe(false);
    expect(isAllowed("vite.config.js", pawna)).toBe(false);
  });

  it("rejects files under node_modules even when the include pattern matched", () => {
    expect(isAllowed("backend/node_modules/express/index.js", pawna)).toBe(false);
    expect(isAllowed("node_modules/react/index.js", smartapply)).toBe(false);
    expect(isAllowed("src/node_modules/react/index.js", pawna)).toBe(false);
    expect(isAllowed("frontend/src/node_modules/x/y.js", smartapply)).toBe(false);
  });

  it("rejects credential-ish paths regardless of the include list", () => {
    expect(isAllowed(".env", smartapply)).toBe(false);
    expect(isAllowed("src/.env.local", smartapply)).toBe(false);
    expect(isAllowed("src/secrets.yaml", smartapply)).toBe(false);
    expect(isAllowed("src/credentials.json", smartapply)).toBe(false);
    expect(isAllowed("src/token.json", smartapply)).toBe(false);
    expect(isAllowed("src/gmail_credentials.json", smartapply)).toBe(false);
    expect(isAllowed("edge_profile/data.json", smartapply)).toBe(false);
    expect(isAllowed(".git/config", smartapply)).toBe(false);
  });

  it("applies the global excludes to every project", () => {
    expect(GLOBAL_EXCLUDES).toContain("node_modules");
    expect(GLOBAL_EXCLUDES).toContain("*.min.js");
    expect(GLOBAL_EXCLUDES).toContain("*.csv");
    // `config.yaml` must NOT be globally excluded - SmartApply keeps it.
    expect(GLOBAL_EXCLUDES).not.toContain("config.yaml");
    expect(isAllowed("src/bundle.min.js", smartapply)).toBe(false);
    expect(isAllowed("src/data.csv", smartapply)).toBe(false);
    expect(isAllowed("src/__pycache__/x.pyc", smartapply)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* secret scanner                                                      */
/* ------------------------------------------------------------------ */

describe("scanContent - secrets", () => {
  const fixtures: Array<[string, string]> = [
    [
      "postgres-url-inline-password",
      'const db = "postgresql://admin:S3cretPass@db.example.com:5432/app";',
    ],
    [
      "mongodb-url-inline-password",
      'const uri = "mongodb+srv://dbuser:pass1234@cluster0.abcde.mongodb.net/shop";',
    ],
    ["openai-style-api-key", 'const key = "sk-abcdefghijklmnopqrstuvwxyz012345";'],
    // Synthetic fixture. A real Google API key was committed here once; the
    // guard test below fails if any fixture stops being obviously fake.
    ["google-api-key", 'const key = "AIzaSyTESTONLYfixture0000000000000000000";'],
    ["supabase-secret-key", 'const key = "sb_secret_abcdefghijklmnopqrst";'],
    ["stripe-live-key", 'const key = "nt_live_abcdefghijklmnopqrstuvwx";'],
    ["supabase-management-token", 'const pat = "sbp_abcdefghijklmnopqrstuvwxyz012345";'],
    ["private-key-block", '-----BEGIN RSA PRIVATE KEY-----'],
    [
      "jwt",
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ],
    ["authorization-bearer-token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz"],
  ];

  for (const [rule, fixture] of fixtures) {
    it(`flags ${rule}`, () => {
      const result = scanContent(fixture, "fixture.js");
      expect(result.ok).toBe(false);
      const finding = result.findings.find((f) => f.rule === rule);
      expect(finding, `expected rule ${rule}`).toBeDefined();
      expect(finding!.severity).toBe("block");
      expect(finding!.line).toBe(1);
      expect(finding!.column).toBeGreaterThan(0);
    });
  }

  it("never stores the raw secret in a finding", () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz012345";
    const result = scanContent(`const key = "${secret}";`, "fixture.js");
    expect(result.findings.length).toBeGreaterThan(0);
    for (const finding of result.findings) {
      expect(finding.match).not.toContain(secret);
      expect(finding.match).toMatch(/len=\d+/);
    }
  });

  it("flags a non-empty, non-placeholder credential value", () => {
    const result = scanContent('api_key: "actualsecretvalue123"', "config.yaml");
    expect(result.ok).toBe(false);
    const finding = result.findings.find((f) => f.rule === "hardcoded-secret-value");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("block");
  });

  it("keeps every fixture obviously synthetic", () => {
    // A real Google API key was committed in this file once. The scanner
    // fixtures must be shaped like secrets but must never BE secrets, so
    // every fixture is asserted to contain an obvious "this is a test"
    // marker.
    for (const [rule, fixture] of fixtures) {
      if (rule === "private-key-block" || rule === "authorization-bearer-token") {
        continue;
      }
      expect(
        /TESTONLY|fixture|example|abcdef|123456|pass1234|S3cretPass|Doe|John|000000/i.test(
          fixture,
        ),
        `fixture for "${rule}" must be obviously synthetic: ${fixture}`,
      ).toBe(true);
    }

    // No fixture may contain a Google key that is not explicitly the
    // synthetic one.
    const googleKeys = fixtures
      .filter(([rule]) => rule === "google-api-key")
      .map(([, fixture]) => fixture.match(/AIzaSy[A-Za-z0-9_-]+/)?.[0] ?? "");
    for (const key of googleKeys) {
      expect(key).toContain("TESTONLY");
    }
  });

  it("does not flag empty placeholders", () => {
    const empty = scanContent('api_key: ""', "config.yaml");
    expect(empty.ok).toBe(true);
    expect(empty.findings.filter((f) => f.severity === "block")).toHaveLength(0);

    const placeholder = scanContent("api_key: YOUR_KEY_HERE", "config.yaml");
    expect(placeholder.ok).toBe(true);
    expect(placeholder.findings.filter((f) => f.severity === "block")).toHaveLength(0);

    const quotedPlaceholder = scanContent('api_key: "YOUR_KEY_HERE"', "config.yaml");
    expect(quotedPlaceholder.ok).toBe(true);
    expect(quotedPlaceholder.findings.filter((f) => f.severity === "block")).toHaveLength(0);

    const anglePlaceholder = scanContent('password: "<your-password>"', "config.yaml");
    expect(anglePlaceholder.ok).toBe(true);
    expect(anglePlaceholder.findings.filter((f) => f.severity === "block")).toHaveLength(0);
  });

  it("does not flag environment-variable reads or non-literal values", () => {
    const source = [
      'const apiKey = process.env.GEMINI_API_KEY;',
      'client = OpenAI(api_key=os.environ.get("DEEPSEEK_API_KEY"), base_url="https://x")',
      'password: initialPassword,',
      'api_key: apiKey,',
      'if (firebaseConfig.apiKey === "YOUR_API_KEY") {',
    ].join("\n");
    const result = scanContent(source, "fixture.js");
    expect(result.findings.filter((f) => f.severity === "block")).toHaveLength(0);
  });

  it("warns (but does not block) on a placeholder credential value", () => {
    const result = scanContent('api_key: "YOUR_KEY_HERE"', "config.yaml");
    expect(result.ok).toBe(true);
    const finding = result.findings.find((f) => f.rule === "config-placeholder-value");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("warn");
  });
});

/* ------------------------------------------------------------------ */
/* PII scanner                                                         */
/* ------------------------------------------------------------------ */

describe("scanContent - PII", () => {
  it("flags the personal phone number", () => {
    const result = scanContent('phone: "+91-9975526627"', "profile.py");
    expect(result.ok).toBe(false);
    const finding = result.findings.find((f) => f.rule === "pii-personal-phone");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("block");
  });

  it("flags the personal email address", () => {
    const result = scanContent('sender: "kaustubh.kale.work@gmail.com"', "config.yaml");
    expect(result.ok).toBe(false);
    const finding = result.findings.find((f) => f.rule === "pii-personal-email");
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe("block");
  });

  it("does not leak the raw PII value in the finding", () => {
    const result = scanContent("kaustubh.kale.work@gmail.com", "x.py");
    for (const finding of result.findings) {
      expect(finding.match).not.toContain("kaustubh.kale.work@gmail.com");
    }
  });
});

/* ------------------------------------------------------------------ */
/* chunker: line exactness + coverage on a real file                   */
/* ------------------------------------------------------------------ */

describe.skipIf(!hasRealFile)(`chunkFile - ${REAL_FILE}`, () => {
  it("produces chunks whose content is exactly the recorded source slice", async () => {
    const content = readFileSync(REAL_FILE_ABS, "utf8");
    const lines = splitLines(content);
    const chunks = await chunkFile({
      project: smartapply,
      relPath: REAL_FILE,
      content,
      repoName: repoName(smartapply),
    });

    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.startLine).toBeGreaterThanOrEqual(1);
      expect(chunk.endLine).toBeGreaterThanOrEqual(chunk.startLine);
      expect(chunk.endLine).toBeLessThanOrEqual(lines.length);
      expect(chunk.content).toBe(sliceLines(lines, chunk.startLine, chunk.endLine));
      // The content really is the source text at those coordinates.
      expect(content).toContain(chunk.content);
    }
  });

  it("uses the tree-sitter parser (not the window fallback)", async () => {
    const content = readFileSync(REAL_FILE_ABS, "utf8");
    const chunks = await chunkFile({
      project: smartapply,
      relPath: REAL_FILE,
      content,
      repoName: repoName(smartapply),
    });
    expect(new Set(chunks.map((c) => c.parser))).toEqual(new Set(["tree-sitter"]));
    expect(new Set(chunks.map((c) => c.language))).toEqual(new Set(["python"]));
  });

  it("covers every non-blank line exactly once", async () => {
    const content = readFileSync(REAL_FILE_ABS, "utf8");
    const lines = splitLines(content);
    const chunks = await chunkFile({
      project: smartapply,
      relPath: REAL_FILE,
      content,
      repoName: repoName(smartapply),
    });
    const coverage = verifyCoverage(lines, chunks);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.duplicates).toEqual([]);
    expect(coverage.exact).toBe(true);
  });

  it("extracts the documented symbol names", async () => {
    const content = readFileSync(REAL_FILE_ABS, "utf8");
    const chunks = await chunkFile({
      project: smartapply,
      relPath: REAL_FILE,
      content,
      repoName: repoName(smartapply),
    });
    const symbols = chunks.flatMap((c) => c.symbols);
    expect(symbols).toContain("calculate_deepseek_cost");
  });
});

/* ------------------------------------------------------------------ */
/* chunker basics                                                      */
/* ------------------------------------------------------------------ */

describe("chunkFile - basics", () => {
  it("detects the language from the extension", () => {
    expect(detectLanguage("src/a.py")).toBe("python");
    expect(detectLanguage("src/a.js")).toBe("javascript");
    expect(detectLanguage("src/a.jsx")).toBe("tsx");
    expect(detectLanguage("src/a.ts")).toBe("typescript");
    expect(detectLanguage("src/a.tsx")).toBe("tsx");
    expect(detectLanguage("lib/a.dart")).toBe("dart");
    expect(detectLanguage("db/a.sql")).toBe("sql");
    expect(detectLanguage("index.html")).toBe("html");
    expect(detectLanguage("style.css")).toBe("css");
  });

  it("falls back to a sliding window for unsupported languages", async () => {
    const content = Array.from({ length: 120 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = await chunkFile({
      project: c54,
      relPath: "style.css",
      content,
      repoName: repoName(c54),
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.parser === "window")).toBe(true);
    expect(chunks.every((c) => c.kind === "block")).toBe(true);
    // 40 line window with 10 lines of overlap.
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(40);
    expect(chunks[1].startLine).toBe(31);
  });

  it("keeps every chunk within the 80 line budget", async () => {
    const content = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`).join("\n");
    const chunks = await chunkFile({
      project: c54,
      relPath: "style.css",
      content,
      repoName: repoName(c54),
    });
    for (const chunk of chunks) {
      expect(chunk.endLine - chunk.startLine + 1).toBeLessThanOrEqual(80);
    }
  });
});

/* ------------------------------------------------------------------ */
/* header                                                              */
/* ------------------------------------------------------------------ */

describe("buildHeader", () => {
  it("matches the documented shape", () => {
    const header = buildHeader({
      repoName: "JobHunt-Automation",
      repoSha: "d3aebf723240a518f9b2b5985bbe850d76e0664c",
      path: "src/ai_engine.py",
      symbol: "calculate_deepseek_cost",
      kind: "function",
      startLine: 59,
      endLine: 74,
      imports: ["openai", "dataclasses"],
    });

    expect(header).toBe(
      [
        "repo: JobHunt-Automation @ d3aebf7",
        "file: src/ai_engine.py",
        "symbol: calculate_deepseek_cost",
        "kind: function",
        "lines: 59-74",
        "imports: openai, dataclasses",
      ].join("\n"),
    );
    expect(header.split("\n")).toHaveLength(6);
  });

  it("uses (none) when there is no symbol", () => {
    const header = buildHeader({
      repoName: "DayScore",
      repoSha: "8043dafc481c5d9481d9391924cebbe881e39d16",
      path: "index.html",
      symbol: "",
      kind: "block",
      startLine: 1,
      endLine: 40,
      imports: [],
    });
    expect(header).toContain("symbol: (none)");
    expect(header).toContain("imports: ");
  });
});

describe("extractImports", () => {
  it("falls back to a regex for python imports", () => {
    const imports = extractImports("import os\nfrom dataclasses import dataclass\n", "python");
    expect(imports).toContain("os");
    expect(imports).toContain("dataclasses");
  });

  it("falls back to a regex for javascript imports", () => {
    const imports = extractImports(
      'import React from "react";\nimport express from "express";\n',
      "javascript",
    );
    expect(imports).toContain("react");
    expect(imports).toContain("express");
  });

  it("caps the number of import names at 8", () => {
    const many = Array.from({ length: 20 }, (_, i) => `import mod${i} from "m${i}";`).join("\n");
    expect(extractImports(many, "javascript")).toHaveLength(8);
  });
});

/* ------------------------------------------------------------------ */
/* hashing                                                             */
/* ------------------------------------------------------------------ */

describe("contentHash / chunkKey", () => {
  it("is a 32 character hex digest", () => {
    const hash = contentHash(["hello", "world"]);
    expect(hash).toHaveLength(32);
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
  });

  it("is stable and order sensitive", () => {
    expect(contentHash(["a", "b"])).toBe(contentHash(["a", "b"]));
    expect(contentHash(["a", "b"])).not.toBe(contentHash(["b", "a"]));
    expect(contentHash(["a"])).not.toBe(contentHash(["b"]));
    expect(contentHash([])).toMatch(/^[0-9a-f]{32}$/);
  });

  it("builds a stable chunk key", () => {
    expect(
      chunkKey({
        projectId: "smartapply",
        path: "src/ai_engine.py",
        startLine: 59,
        endLine: 74,
        contentHash: "abc123",
      }),
    ).toBe("smartapply:src/ai_engine.py:59:74:abc123");
  });
});

/* ------------------------------------------------------------------ */
/* database layer                                                       */
/* ------------------------------------------------------------------ */

describe("upsertChunks", () => {
  it("builds an ON CONFLICT upsert with one placeholder per column", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const fakeDb = {
      async query(text: string, values: unknown[] = []) {
        calls.push({ text, values });
        return { rowCount: values.length / 12 };
      },
    };

    const chunk = {
      projectId: "smartapply",
      repoSha: "d3aebf723240a518f9b2b5985bbe850d76e0664c",
      path: "src/ai_engine.py",
      startLine: 59,
      endLine: 74,
      kind: "function" as const,
      symbol: "calculate_deepseek_cost",
      symbols: ["calculate_deepseek_cost"],
      content: "def calculate_deepseek_cost(): ...",
      header: "repo: JobHunt-Automation @ d3aebf7\n...",
      parser: "tree-sitter" as const,
      language: "python",
      contentHash: "abc123",
    };

    const written = await upsertChunks([chunk], fakeDb);
    expect(written).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain("INSERT INTO chunks");
    expect(calls[0].text).toContain(
      "ON CONFLICT (project_id, path, start_line, end_line, content_hash)",
    );
    expect(calls[0].text).toContain("DO UPDATE SET");
    expect(calls[0].values).toHaveLength(12);
    expect(calls[0].values[0]).toBe("smartapply");
    expect(calls[0].values[2]).toBe("src/ai_engine.py");
    expect(calls[0].values[6]).toBe(59);
    expect(calls[0].values[7]).toBe(74);
  });

  it("does nothing for an empty chunk list", async () => {
    let called = false;
    const fakeDb = {
      async query() {
        called = true;
        return { rowCount: 0 };
      },
    };
    expect(await upsertChunks([], fakeDb)).toBe(0);
    expect(called).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* manifest                                                            */
/* ------------------------------------------------------------------ */

describe("manifest", () => {
  it("contains the six projects with full shas", () => {
    expect(PROJECTS.map((p) => p.id)).toEqual([
      "smartapply",
      "pawna",
      "c54",
      "personal-ai-os",
      "aura",
      "dayscore",
    ]);
    for (const project of PROJECTS) {
      expect(project.repoSha).toMatch(/^[0-9a-f]{40}$/);
      expect(project.repoUrl).toMatch(/^https:\/\/github\.com\/kaustubh12022\/.+\.git$/);
    }
  });

  it("keeps SmartApply's config.yaml in the include list", () => {
    expect(smartapply.include).toContain("config.yaml");
  });
});
