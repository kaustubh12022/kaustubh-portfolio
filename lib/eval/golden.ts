/**
 * The golden set: the loader, the schema and the shape.
 *
 * `evals/golden-set.yaml` is the single source of truth for what the
 * assistant is supposed to do. This module turns it into typed data that the
 * two benchmarks and the golden-set test all share.
 *
 * NO DATABASE, NO LLM. Loading the golden set has to stay cheap and
 * offline: the test that validates the set must run in a second.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { z } from "zod";

import { VISUAL_KINDS } from "@/lib/types/chat";

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

/** One expected citation. */
export const GoldenEvidenceSchema = z.object({
  /** The project the file belongs to. */
  project: z.string().min(1).optional(),
  /** The repo-relative POSIX path of the file. */
  path: z.string().min(1),
  /** 1-based first expected line. Optional: the expectation may name a file only. */
  startLine: z.number().int().min(1).optional(),
  /** 1-based last expected line. */
  endLine: z.number().int().min(1).optional(),
  /** The expected symbol, when the expectation names one. */
  symbol: z.string().min(1).optional(),
});
export type GoldenEvidence = z.infer<typeof GoldenEvidenceSchema>;

/** The expectations of one question. */
export const GoldenExpectSchema = z.object({
  /** Substrings that MUST appear in the answer (case-insensitive). */
  answerContains: z.array(z.string().min(1)).default([]),
  /** Substrings that MUST NOT appear in the answer (case-insensitive). */
  answerNotContains: z.array(z.string().min(1)).default([]),
  /** The expected citations. */
  evidence: z.array(GoldenEvidenceSchema).default([]),
  /** The expected visual kind, or `null` when no visual is expected. */
  visualKind: z.enum(VISUAL_KINDS).nullable().default(null),
  /** The claim ids the `claims` visual has to reference. */
  claimIds: z.array(z.string().min(1)).default([]),
  /** True when the assistant has to refuse. */
  refusal: z.boolean().default(false),
  /** The expected confidence. */
  confidence: z.enum(["high", "medium", "low"]).default("medium"),
  /**
   * The APPROVED public wording, checked VERBATIM against the answer.
   *
   * This is the strict check for the claim-ledger questions: the assistant has
   * to reproduce the sentence character for character, not paraphrase it.
   * When it is set, the value has to equal the `publicWording` of the claim
   * in `content/claims.yaml` - `tests/eval/golden-set.test.ts` enforces that.
   */
  publicWording: z.string().min(1).optional(),
});
export type GoldenExpect = z.infer<typeof GoldenExpectSchema>;

/** One question of the golden set. */
export const GoldenQuestionSchema = z.object({
  /** The id, `q001` .. `q150`. */
  id: z.string().min(1),
  /** The bucket. */
  bucket: z.enum([
    "code_explanation",
    "file_lookup",
    "architecture",
    "data_model",
    "metrics",
    "claim_correction",
    "comparison",
    "off_topic_refusal",
    "adversarial_prompt_injection",
  ]),
  /** The question as a visitor would type it. */
  question: z.string().min(1),
  /** The project the question is scoped to, when it is scoped to one. */
  project: z.string().min(1).optional(),
  /** What the answer has to look like. */
  expect: GoldenExpectSchema,
});
export type GoldenQuestion = z.infer<typeof GoldenQuestionSchema>;

/* ------------------------------------------------------------------ */
/* Buckets                                                             */
/* ------------------------------------------------------------------ */

/** The nine buckets of the golden set. */
export const BUCKETS = [
  "code_explanation",
  "file_lookup",
  "architecture",
  "data_model",
  "metrics",
  "claim_correction",
  "comparison",
  "off_topic_refusal",
  "adversarial_prompt_injection",
] as const;

export type Bucket = (typeof BUCKETS)[number];

/** The required number of questions per bucket. */
export const BUCKET_COUNTS: Record<Bucket, number> = {
  code_explanation: 30,
  file_lookup: 20,
  architecture: 15,
  data_model: 10,
  metrics: 15,
  claim_correction: 25,
  comparison: 10,
  off_topic_refusal: 15,
  adversarial_prompt_injection: 10,
};

/** The total number of questions. */
export const GOLDEN_SET_SIZE = 150;

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

/** Absolute path of the golden set. */
export const GOLDEN_SET_PATH = path.join(
  process.cwd(),
  "evals",
  "golden-set.yaml",
);

/**
 * Parse the golden set YAML.
 *
 * @param filePath the file to read. Defaults to `evals/golden-set.yaml`.
 * @throws when the YAML does not match the schema.
 */
export function readGoldenSet(
  filePath: string = GOLDEN_SET_PATH,
): GoldenQuestion[] {
  const raw = readFileSync(filePath, "utf8");
  const parsed = parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `[eval] ${filePath} must contain a list of questions, got ${typeof parsed}`,
    );
  }
  return z.array(GoldenQuestionSchema).parse(parsed);
}

/**
 * Count the questions per bucket.
 */
export function countByBucket(
  questions: GoldenQuestion[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const question of questions) {
    counts[question.bucket] = (counts[question.bucket] ?? 0) + 1;
  }
  return counts;
}

/**
 * Pick a subset of the golden set.
 *
 * @param questions the whole set
 * @param ids       the ids to keep. An empty list keeps everything.
 */
export function selectQuestions(
  questions: GoldenQuestion[],
  ids: string[],
): GoldenQuestion[] {
  if (ids.length === 0) return questions;
  const wanted = new Set(ids.map((id) => id.trim()).filter(Boolean));
  return questions.filter((question) => wanted.has(question.id));
}

/**
 * The questions that are scored by the retrieval benchmark.
 *
 * A question is scorable when it names the source files that answer it.
 * The questions answered from the content layer (metrics, claims, refusals)
 * have no code target, so they are excluded from the retrieval numbers.
 */
export function scorableQuestions(
  questions: GoldenQuestion[],
): GoldenQuestion[] {
  return questions.filter((question) => question.expect.evidence.length > 0);
}
