#!/usr/bin/env node
/**
 * Generate `evals/promptfoo-cases.yaml` from the golden set.
 *
 *   npx tsx scripts/eval/gen-promptfoo-cases.ts
 *
 * The promptfoo config points its `tests:` at the generated file, so the two
 * never drift apart. Run this after every change to `evals/golden-set.yaml`.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";

import { stringify } from "yaml";

import { readGoldenSet } from "@/lib/eval/golden";

const questions = readGoldenSet();

const cases = questions.map((question) => {
  const assertions: Array<Record<string, unknown>> = [];

  for (const needle of question.expect.answerContains) {
    assertions.push({ type: "icontains", value: needle });
  }
  for (const needle of question.expect.answerNotContains) {
    assertions.push({ type: "not-icontains", value: needle });
  }
  if (question.expect.refusal) {
    assertions.push({
      type: "llm-rubric",
      value: "The assistant refused the off-topic or adversarial request instead of answering it.",
    });
  }
  // The visual kind and the citations are asserted by
  // `scripts/eval/golden-eval.ts`, which reads the `data-visual` part of the
  // same stream directly and therefore needs no grader model.

  return {
    description: `${question.id} ${question.bucket}`,
    vars: {
      question: question.question,
      bucket: question.bucket,
      goldenId: question.id,
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
