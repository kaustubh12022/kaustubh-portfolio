#!/usr/bin/env node
/**
 * Explain the `claim:` failures character by character.
 *
 *   npx tsx scripts/eval/explain-claim-failures.ts <report.json>
 *
 * The `claim_correction` bucket checks that the answer reproduces the
 * APPROVED public wording VERBATIM. When that check fails there are two
 * very different causes:
 *
 *   - the model paraphrased, which is a real answer-quality failure, or
 *   - the model reproduced the sentence but a CHARACTER differs (a curly
 *     quote, a different dash, a missing space), which is a harness
 *     artefact and not a truth failure.
 *
 * This script prints the first differing character and the code points
 * around it, so the two cases can be told apart without guessing.
 *
 * NO LLM CALL. It reads a report and the claim ledger.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";

import { loadEnv } from "./env.js";

loadEnv();

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: explain-claim-failures.ts <report.json>");
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
  results: Array<{
    id: string;
    bucket: string;
    question: string;
    pass: boolean;
    answer: string;
    checks: Array<{ name: string; ok: boolean; detail: string }>;
  }>;
};

const ledger = parse(
  readFileSync(path.join(process.cwd(), "content", "claims.yaml"), "utf8"),
) as Array<{
  id: string;
  publicWording: string;
}>;

const byId = new Map(ledger.map((claim) => [claim.id, claim.publicWording]));

const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The code points around the first difference, for a readable report. */
function showContext(a: string, b: string): string {
  let index = 0;
  while (index < a.length && index < b.length && a[index] === b[index]) {
    index += 1;
  }
  const from = Math.max(0, index - 30);
  const sliceA = a.slice(from, index + 40);
  const sliceB = b.slice(from, index + 40);
  const cp = (ch: string): string =>
    ch === undefined ? "<end>" : `U+${ch.codePointAt(0)?.toString(16).padStart(4, "0").toUpperCase()}`;
  return [
    `  first difference at character ${index}`,
    `  expected ...${JSON.stringify(sliceA)}`,
    `  in answer ...${JSON.stringify(sliceB)}`,
    `  expected char ${cp(a[index])}  answer char ${cp(b[index])}`,
  ].join("\n");
}

let failures = 0;
let characterOnly = 0;
let paraphrase = 0;

for (const result of report.results) {
  for (const check of result.checks) {
    if (check.ok || !check.name.startsWith("claim:")) continue;
    failures += 1;
    const claimId = check.name.slice("claim:".length);
    const wanted = byId.get(claimId);
    if (!wanted) {
      console.log(`\n${result.id}: the claim ${claimId} is not in the ledger`);
      continue;
    }
    const haystack = normalise(result.answer);
    const needle = normalise(wanted);
    const index = haystack.indexOf(needle);
    console.log("");
    console.log(`${result.id} [${result.bucket}] ${claimId}`);
    if (index >= 0) {
      console.log("  the wording IS in the answer - the check is a false negative");
      characterOnly += 1;
      continue;
    }
    // Find the longest prefix of the wanted wording that appears.
    let prefix = 0;
    while (
      prefix < needle.length &&
      haystack.includes(needle.slice(0, prefix + 1))
    ) {
      prefix += 1;
    }
    const tail = needle.slice(prefix, prefix + 80);
    const tailIndex = haystack.indexOf(tail);
    console.log(
      `  the wording is NOT reproduced verbatim; ${prefix}/${needle.length} characters of the prefix matched`,
    );
    console.log(`  expected: ${JSON.stringify(needle.slice(prefix, prefix + 120))}`);
    console.log(
      `  answer  : ${JSON.stringify(
        tailIndex >= 0
          ? haystack.slice(tailIndex, tailIndex + 120)
          : "(the text does not occur at all)",
      )}`,
    );
    if (prefix > needle.length * 0.6) {
      characterOnly += 1;
      console.log(showContext(needle, haystack));
    } else {
      paraphrase += 1;
    }
  }
}

console.log("");
console.log("=== SUMMARY ===");
console.log(`claim checks that failed      : ${failures}`);
console.log(`  paraphrase (a real failure) : ${paraphrase}`);
console.log(`  wording present / char diff : ${characterOnly}`);

process.exit(0);
