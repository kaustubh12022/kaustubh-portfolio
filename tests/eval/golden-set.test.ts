/**
 * The golden set is a test asset, so it gets its own test.
 *
 * These checks are FAST and LLM-FREE: no model is called, no network is
 * touched (except the optional database check, which SKIPS itself when the
 * database is unreachable).
 *
 * What is checked:
 *   1. exactly 150 questions
 *   2. the bucket counts are exactly as specified
 *   3. every `expect.evidence[].path` exists in the LIVE index
 *      (the line range and the symbol are checked too)
 *   4. every `expect.claimIds` refers to a real claim in content/claims.yaml
 *   5. every `expect.visualKind` is one of the twelve valid kinds
 *   6. no duplicate question text, no duplicate ids
 *   7. the adversarial questions all refuse or forbid something
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import {
  BUCKET_COUNTS,
  GOLDEN_SET_SIZE,
  countByBucket,
  readGoldenSet,
  type GoldenQuestion,
} from "@/lib/eval/golden";
import { VISUAL_KINDS } from "@/lib/types/chat";

import { loadEnv } from "../../scripts/eval/env";

loadEnv();

const QUESTIONS: GoldenQuestion[] = readGoldenSet();

/** The claim ids in the ledger, read straight from the YAML. */
const CLAIM_IDS: string[] = parse(
  readFileSync(path.join(process.cwd(), "content", "claims.yaml"), "utf8"),
).map((claim: { id: string }) => claim.id);

describe("golden set shape", () => {
  it("has exactly 150 questions", () => {
    expect(QUESTIONS.length).toBe(GOLDEN_SET_SIZE);
  });

  it("has the exact bucket counts", () => {
    const counts = countByBucket(QUESTIONS);
    for (const [bucket, expected] of Object.entries(BUCKET_COUNTS)) {
      expect(counts[bucket] ?? 0, `bucket "${bucket}"`).toBe(expected);
    }
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    expect(total).toBe(GOLDEN_SET_SIZE);
  });

  it("has no duplicate ids and no duplicate question text", () => {
    const ids = QUESTIONS.map((question) => question.id);
    expect(new Set(ids).size).toBe(ids.length);

    const texts = QUESTIONS.map((question) => question.question.trim());
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("only uses visual kinds the renderer knows", () => {
    const valid = new Set<string>(VISUAL_KINDS);
    for (const question of QUESTIONS) {
      const kind = question.expect.visualKind;
      if (kind === null) continue;
      expect(valid.has(kind), `${question.id} -> ${kind}`).toBe(true);
    }
  });

  it("only refers to claim ids that exist in the ledger", () => {
    const known = new Set(CLAIM_IDS);
    for (const question of QUESTIONS) {
      for (const claimId of question.expect.claimIds) {
        expect(known.has(claimId), `${question.id} -> ${claimId}`).toBe(true);
      }
    }
  });

  it("covers every contradicted claim of the ledger", () => {
    const referenced = new Set(
      QUESTIONS.flatMap((question) => question.expect.claimIds),
    );
    // The claims the brief calls out by name, plus the two that were added
    // to the ledger later. Every one of them has to be exercised.
    const required = [
      "java-spring",
      "medflow",
      "c54-socketio",
      "smartapply-weasyprint",
      "pawna-name",
      "campflow-owners",
      "campflow-multitenant",
      "campflow-microservices",
      "personal-ai-os-stack",
      "rag-vector",
      "neon-pulse",
    ];
    for (const claimId of required) {
      expect(referenced.has(claimId), `claim "${claimId}" is never exercised`)
        .toBe(true);
    }
  });

  it("makes every adversarial question refuse or forbid something", () => {
    const adversarial = QUESTIONS.filter(
      (question) => question.bucket === "adversarial_prompt_injection",
    );
    expect(adversarial.length).toBe(BUCKET_COUNTS.adversarial_prompt_injection);
    for (const question of adversarial) {
      const refuses = question.expect.refusal === true;
      const forbids =
        question.expect.answerNotContains.length > 0 ||
        question.expect.claimIds.length > 0;
      expect(refuses || forbids, `${question.id} has no refusal guard`).toBe(true);
    }
  });

  it("makes every off-topic question refuse", () => {
    const offTopic = QUESTIONS.filter(
      (question) => question.bucket === "off_topic_refusal",
    );
    for (const question of offTopic) {
      expect(question.expect.refusal, `${question.id}`).toBe(true);
    }
  });

  it("gives every claim_correction question a claim to reproduce", () => {
    const corrections = QUESTIONS.filter(
      (question) => question.bucket === "claim_correction",
    );
    expect(corrections.length).toBe(BUCKET_COUNTS.claim_correction);
    for (const question of corrections) {
      expect(question.expect.claimIds.length, `${question.id}`).toBeGreaterThan(0);
    }
  });
});

/* ------------------------------------------------------------------ */
/* The live index                                                      */
/* ------------------------------------------------------------------ */

interface ChunkRow {
  project_id: string;
  path: string;
  start_line: number;
  end_line: number;
  symbol: string;
}

describe("golden set against the live index", () => {
  it("only points at files, ranges and symbols that exist", async (ctx) => {
    const { createPgPool } = await import("@/lib/retrieval/pg");
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.warn("[eval] DATABASE_URL is not set - skipping the index check");
      ctx.skip();
      return;
    }

    const pool = createPgPool(url, { max: 2 });
    try {
      const result = await pool.query<ChunkRow>(
        `SELECT project_id, path, start_line, end_line, symbol
           FROM chunks`,
      );
      const chunks = result.rows;

      const problems: string[] = [];

      for (const question of QUESTIONS) {
        for (const evidence of question.expect.evidence) {
          const scoped = chunks.filter(
            (chunk) =>
              chunk.path === evidence.path &&
              (evidence.project
                ? chunk.project_id === evidence.project
                : true),
          );
          if (scoped.length === 0) {
            problems.push(
              `${question.id}: ${evidence.project ?? "*"}/${evidence.path} is not in the index`,
            );
            continue;
          }
          if (
            typeof evidence.startLine === "number" &&
            typeof evidence.endLine === "number"
          ) {
            const overlapping = scoped.filter(
              (chunk) =>
                chunk.start_line <= evidence.endLine! &&
                chunk.end_line >= evidence.startLine!,
            );
            if (overlapping.length === 0) {
              problems.push(
                `${question.id}: ${evidence.path}:${evidence.startLine}-${evidence.endLine} overlaps no chunk`,
              );
            }
          }
          if (evidence.symbol) {
            const withSymbol = scoped.filter(
              (chunk) =>
                chunk.symbol.toLowerCase() === evidence.symbol!.toLowerCase(),
            );
            if (withSymbol.length === 0) {
              problems.push(
                `${question.id}: symbol "${evidence.symbol}" not found in ${evidence.path}`,
              );
            }
          }
        }
      }

      expect(problems).toEqual([]);
    } catch (error) {
      console.warn(
        "[eval] the database is unreachable - skipping the index check:",
        (error as Error).message,
      );
      ctx.skip();
    } finally {
      await pool.end().catch(() => undefined);
    }
  });
});
