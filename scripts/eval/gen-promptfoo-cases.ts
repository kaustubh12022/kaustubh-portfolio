#!/usr/bin/env node
/**
 * Generate `evals/promptfoo-cases.yaml` from the golden set.
 *
 *   npx tsx scripts/eval/gen-promptfoo-cases.ts
 *
 * The promptfoo config points its `tests:` at the generated file, so the two
 * never drift apart. Run this after every change to `evals/golden-set.yaml`.
 *
 * EVERY ASSERTION HERE IS DETERMINISTIC
 * -------------------------------------
 * The refusal check used to be an `llm-rubric`. That needed a grader key
 * this project does not have: `promptfoo.yaml` passed the literal string
 * `{{env.OPENAI_API_KEY}}` as the API key (promptfoo does NOT substitute
 * environment variables inside `config.apiKey`), so the grader 401'd and the
 * rubric never ran. The rubric is now a pair of native assertions over the
 * SAME marker lists the answer benchmark uses, so both harnesses judge a
 * refusal by one vocabulary.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import { stringify } from "yaml";

import { readGoldenSet } from "@/lib/eval/golden";

import {
  COMPLIANCE_MARKERS,
  REFUSAL_MARKERS,
} from "./refusal-markers.js";

const questions = readGoldenSet();

const cases = questions.map((question, index) => {
  const assertions: Array<Record<string, unknown>> = [];

  for (const needle of question.expect.answerContains) {
    assertions.push({ type: "icontains", value: needle });
  }
  for (const needle of question.expect.answerNotContains) {
    assertions.push({ type: "not-icontains", value: needle });
  }
  if (question.expect.refusal) {
    // The answer has to REFUSE: at least one refusal marker, and none of the
    // compliance markers (which would mean the assistant did what it was told).
    assertions.push({ type: "icontains-any", value: REFUSAL_MARKERS });
    assertions.push({ type: "not-icontains-any", value: COMPLIANCE_MARKERS });
  }
  // The visual kind and the citations are asserted by
  // `scripts/eval/golden-eval.ts`, which reads the `data-visual` part of the
  // same stream directly and therefore needs no grader model. The
  // `defaultTest.assert` block in `evals/promptfoo.yaml` adds the structural
  // checks over that same payload.

  return {
    description: `${question.id} ${question.bucket}`,
    vars: {
      question: question.question,
      bucket: question.bucket,
      goldenId: question.id,
      /**
       * The 1-based position of this case in the suite.
       *
       * The chat route rate limits to 10 requests per 5 minutes PER IP, so
       * every case has to arrive from a different one. `{{testCaseIdx}}` is
       * NOT a promptfoo variable (it does not exist in v0.124 and used to be
       * sent literally), so the index is generated here instead.
       */
      caseIdx: index + 1,
    },
    assert: assertions,
  };
});

const header = `# =============================================================================
# GENERATED FILE - do not edit by hand.
#
#   npx tsx scripts/eval/gen-promptfoo-cases.ts
#
# The promptfoo test cases, derived from evals/golden-set.yaml.
# =============================================================================

`;

const out = path.join(process.cwd(), "evals", "promptfoo-cases.yaml");
writeFileSync(out, header + stringify(cases, { lineWidth: 0 }), "utf8");

console.log(`[eval] wrote ${cases.length} promptfoo case(s) to ${out}`);
