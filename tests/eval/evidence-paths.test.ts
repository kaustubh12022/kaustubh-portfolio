/**
 * Evidence path validation test.
 *
 * Asserts that every evidence string in `content/projects/*.yaml` and
 * `content/claims.yaml`:
 * 1. Is split on `;` and trimmed.
 * 2. Rejects anything that looks like a line range without a file.
 * 3. Asserts each path exists in the indexed `chunks` table for that project
 *    (or on disk in the project repository) — or is explicitly tagged `[prose]`.
 *
 * Also verifies that deliberately broken paths and bare line ranges fail.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { ClaimSchema, ProjectSchema } from "@/lib/content/schemas";
import { loadEnv } from "../../scripts/eval/env";
import { PROJECTS } from "../../scripts/index/projects";

loadEnv();

const contentRoot = path.join(process.cwd(), "content");
const projectsDir = path.join(contentRoot, "projects");

export interface EvidenceValidationResult {
  ok: boolean;
  errors: string[];
}

/** Check if a string looks like a line range without a file prefix. */
export function isBareLineRange(item: string): boolean {
  const trimmed = item.trim();
  return (
    /^:?\d+(?:-\d+)?$/.test(trimmed) ||
    /^:\d+/.test(trimmed) ||
    /^lines?\s+\d+/i.test(trimmed)
  );
}

/**
 * Validate a single evidence string for a given project.
 *
 * @param evidenceStr The raw evidence string from YAML
 * @param projectId The project ID (e.g. 'smartapply', 'pawna', or null for global claims)
 * @param chunkPaths Set or array of chunk paths for this project
 * @param repoPath Absolute path to the repository root on disk (optional fallback)
 */
export function validateEvidenceString(
  evidenceStr: string,
  projectId: string | null,
  chunkPaths: string[] | Set<string>,
  repoPath?: string,
): EvidenceValidationResult {
  const trimmed = evidenceStr.trim();
  if (trimmed.startsWith("[prose]")) {
    return { ok: true, errors: [] };
  }

  const chunksSet = chunkPaths instanceof Set ? chunkPaths : new Set(chunkPaths);
  const chunksList = Array.isArray(chunkPaths) ? chunkPaths : Array.from(chunkPaths);

  const parts = trimmed
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);

  const errors: string[] = [];

  for (const part of parts) {
    if (isBareLineRange(part)) {
      errors.push(`Evidence item "${part}" looks like a line range without a file`);
      continue;
    }

    // Strip line numbers / ranges, e.g. ":549-559" or ":57-62,84-97,148-153"
    const cleanPath = part.replace(/:[\d\s,-]+$/, "").trim();
    if (!cleanPath) {
      errors.push(`Evidence item "${part}" has no path`);
      continue;
    }

    // 1. Check indexed chunks table
    const existsInChunks =
      chunksSet.has(cleanPath) ||
      chunksList.some(
        (cp) =>
          cp === cleanPath ||
          cp.startsWith(cleanPath + "/") ||
          cleanPath.startsWith(cp),
      );

    // 2. Check repo on disk
    let existsOnDisk = false;
    if (repoPath) {
      const fullPath = path.join(repoPath, cleanPath);
      existsOnDisk = existsSync(fullPath);
    }

    if (!existsInChunks && !existsOnDisk) {
      errors.push(
        `Path "${cleanPath}" (from "${part}") not found in indexed chunks or repo for project "${projectId ?? "global"}"`,
      );
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

describe("evidence path verification", () => {
  it("asserts that every evidence string in content/projects/*.yaml exists in index/repo or is [prose]", async () => {
    let chunks: Array<{ project_id: string; path: string }> = [];

    const url = process.env.DATABASE_URL;
    if (url) {
      try {
        const { createPgPool } = await import("@/lib/retrieval/pg");
        const pool = createPgPool(url, { max: 2 });
        const result = await pool.query<{ project_id: string; path: string }>(
          "SELECT project_id, path FROM chunks",
        );
        chunks = result.rows;
        await pool.end().catch(() => undefined);
      } catch (err) {
        console.warn("[eval] database unreachable, relying on repo disk check:", (err as Error).message);
      }
    } else {
      console.warn("[eval] DATABASE_URL unset, relying on repo disk check");
    }

    const repoPathMap = new Map<string, string>(PROJECTS.map((p) => [p.id, p.repoPath]));

    const projectFiles = readdirSync(projectsDir).filter((f) => f.endsWith(".yaml"));
    expect(projectFiles.length).toBeGreaterThan(0);

    const allErrors: string[] = [];

    for (const file of projectFiles) {
      const raw = parse(readFileSync(path.join(projectsDir, file), "utf8"));
      const project = ProjectSchema.parse(raw);
      const projectChunks = chunks
        .filter((c) => c.project_id === project.id)
        .map((c) => c.path);
      const repoPath = repoPathMap.get(project.id);

      for (const feature of project.features) {
        if (!feature.evidence) continue;
        const res = validateEvidenceString(
          feature.evidence,
          project.id,
          projectChunks,
          repoPath,
        );
        if (!res.ok) {
          for (const err of res.errors) {
            allErrors.push(`${project.id} -> feature "${feature.title}": ${err}`);
          }
        }
      }
    }

    expect(allErrors).toEqual([]);
  });

  it("asserts that every evidence string in content/claims.yaml is explicitly tagged [prose] or exists in index", async () => {
    const claimsRaw = parse(
      readFileSync(path.join(contentRoot, "claims.yaml"), "utf8"),
    );
    const claims = ClaimSchema.array().parse(claimsRaw);

    const allErrors: string[] = [];

    for (const claim of claims) {
      if (!claim.evidence) continue;
      const res = validateEvidenceString(claim.evidence, null, []);
      if (!res.ok) {
        for (const err of res.errors) {
          allErrors.push(`claim "${claim.id}": ${err}`);
        }
      }
    }

    expect(allErrors).toEqual([]);
  });

  it("fails when a path is deliberately broken", () => {
    const res = validateEvidenceString(
      "nonexistent/broken/file.ts",
      "smartapply",
      ["src/scorer.py"],
      undefined,
    );
    expect(res.ok).toBe(false);
    expect(res.errors[0]).toContain('Path "nonexistent/broken/file.ts"');
  });

  it("rejects a line range without a file", () => {
    const res1 = validateEvidenceString(":59-74", "smartapply", ["src/scorer.py"]);
    expect(res1.ok).toBe(false);
    expect(res1.errors[0]).toContain("looks like a line range without a file");

    const res2 = validateEvidenceString("38-56", "smartapply", ["src/scorer.py"]);
    expect(res2.ok).toBe(false);
    expect(res2.errors[0]).toContain("looks like a line range without a file");
  });

  it("accepts an evidence string explicitly tagged [prose]", () => {
    const res = validateEvidenceString(
      "[prose] Verified manually via production API response and audit log.",
      "pawna",
      [],
    );
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });
});
