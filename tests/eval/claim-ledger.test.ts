/**
 * The claim ledger, checked against the code that serves it.
 *
 * `content/claims.yaml` is the single source of truth for what the assistant
 * may say. `lib/ai/tools.ts` serves it through the `get_claim` tool, and the
 * tool's own description promises:
 *
 *   "The claim id (e.g. 'smartapply-cost') or its topic
 *    (e.g. 'SmartApply cost reduction')."
 *
 * These tests pin down what the ledger actually supports, and they DOCUMENT A
 * KNOWN GAP: the content loader matches a claim by its ID only, so a lookup by
 * topic silently misses. The `claim_correction` bucket of the golden set
 * catches that at runtime (see docs/EVALUATION.md, finding 2).
 */

import { describe, expect, it } from "vitest";

import { getClaim, getClaims } from "@/lib/content/load";

describe("the claim ledger", () => {
  it("loads every claim", () => {
    const claims = getClaims();
    expect(claims.length).toBeGreaterThanOrEqual(20);
  });

  it("gives every claim an id, a topic and an approved public wording", () => {
    for (const claim of getClaims()) {
      expect(claim.id, "id").toBeTruthy();
      expect(claim.topic, `${claim.id} topic`).toBeTruthy();
      expect(claim.publicWording.length, `${claim.id} publicWording`).toBeGreaterThan(
        10,
      );
    }
  });

  it("has unique ids and unique topics", () => {
    const ids = getClaims().map((claim) => claim.id);
    expect(new Set(ids).size).toBe(ids.length);

    const topics = getClaims().map((claim) => claim.topic.toLowerCase());
    expect(new Set(topics).size).toBe(topics.length);
  });

  it("has a public wording that is a single line", () => {
    // The system prompt tells the model to reproduce the wording verbatim, so
    // a line break INSIDE the wording would make that impossible to check.
    //
    // NOTE: the YAML uses folded scalars (`>`), so every wording ends with a
    // single trailing newline. A verbatim comparison therefore has to
    // normalise the whitespace - `scripts/eval/golden-eval.ts` does exactly
    // that with `normalise()`.
    for (const claim of getClaims()) {
      expect(
        claim.publicWording.replace(/\n$/, ""),
        `${claim.id} publicWording must be a single line`,
      ).not.toMatch(/[\r\n]/);
    }
  });

  it("finds a claim by its id", () => {
    expect(getClaim("campflow-multitenant")?.id).toBe("campflow-multitenant");
    expect(getClaim("java-spring")?.id).toBe("java-spring");
  });

  it("KNOWN GAP: the content loader does NOT find a claim by its topic", () => {
    // This is the behaviour the `get_claim` tool has today, and it is NOT
    // what the tool's description promises. The model regularly passes a
    // topic ("CampFlow tenancy") and gets `found: false`, which makes it
    // say things like "there is no claim for CampFlow".
    //
    // When `lib/content/load.ts#getClaim` is fixed to fall back to a
    // case-insensitive topic match, this test fails and has to be inverted.
    expect(getClaim("CampFlow tenancy")).toBeUndefined();
    expect(getClaim("campflow-multitenant")?.publicWording).toBe(
      "A role-scoped, multi-property booking platform.",
    );
  });
});
