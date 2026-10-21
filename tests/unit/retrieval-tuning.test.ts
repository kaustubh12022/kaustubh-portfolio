import { describe, expect, it } from "vitest";

import {
  DEFAULT_TUNING,
  expansionTerms,
  fuseReciprocalRankFusion,
  genericTokens,
  idfWeights,
  queryAsksAboutTests,
  splitIdentifier,
  TEST_PATH_REGEX,
  type SearchHit,
} from "@/lib/retrieval/search";
import { capFileSlice, READ_FILE_MAX_LINES } from "@/lib/ai/tools";

/**
 * A hit with only the fields the ranking code reads.
 */
function hit(overrides: Partial<SearchHit>): SearchHit {
  return {
    id: "id",
    projectId: "smartapply",
    path: "src/scorer.py",
    startLine: 1,
    endLine: 10,
    symbol: "",
    kind: "function",
    lang: "python",
    header: "header",
    content: "content",
    contentHash: "hash",
    score: 0,
    vectorRank: null,
    keywordRank: null,
    ...overrides,
  };
}

describe("test file detection", () => {
  it("recognises the test paths that are actually in the corpus", () => {
    const testPaths = [
      "tests/test_m5_ats_pdf.py",
      "tests/e2e/test_tier1_feature_coverage.py",
      "test/widget_test.dart",
      "backend/tests/m1_controller_integration.test.js",
      "tests/fixtures/jobs_200_dataset.json",
    ];
    for (const path of testPaths) {
      expect(new RegExp(TEST_PATH_REGEX, "i").test(path)).toBe(true);
    }
  });

  it("does not mistake implementation files for test files", () => {
    const sourcePaths = [
      "src/scorer.py",
      "src/bots/naukri_bot.py",
      "backend/models/Booking.js",
      "backend/controllers/bookingController.js",
      "lib/features/chat/data/chat_repository.dart",
      "app.js",
    ];
    for (const path of sourcePaths) {
      expect(new RegExp(TEST_PATH_REGEX, "i").test(path)).toBe(false);
    }
  });

  it("keeps the tests when the question is about tests", () => {
    expect(queryAsksAboutTests("What do the unit tests cover?")).toBe(true);
    expect(queryAsksAboutTests("how many assertions are in test_suite.js")).toBe(
      true,
    );
    expect(queryAsksAboutTests("what is the test coverage on the scoring")).toBe(
      true,
    );
  });

  it("drops the tests when the question is about the implementation", () => {
    expect(queryAsksAboutTests("How does SmartApply score a job?")).toBe(false);
    expect(queryAsksAboutTests("Where is the settlement engine?")).toBe(false);
  });
});

describe("identifier splitting", () => {
  it("splits snake_case and keeps the parts worth searching on", () => {
    // Parts shorter than three characters carry no signal, so "is" and
    // "jd" are dropped and "relevant" is kept.
    expect(splitIdentifier("is_relevant_jd")).toEqual(["relevant"]);
  });

  it("splits camelCase", () => {
    expect(splitIdentifier("minimumTransactions")).toEqual([
      "minimum",
      "transactions",
    ]);
  });

  it("drops the parts that are too short to be useful", () => {
    expect(splitIdentifier("a_b_c_de")).toEqual([]);
    // "by" and "id" are two characters each and carry no signal.
    expect(splitIdentifier("get_user_by_id")).toEqual(["get", "user"]);
  });
});

describe("pseudo-relevance expansion", () => {
  it("takes the identifiers of the best candidates", () => {
    const terms = expansionTerms(
      [
        hit({ symbol: "is_relevant_jd", path: "src/scorer.py" }),
        hit({ symbol: "matches_senior_title", path: "src/scorer.py" }),
      ],
      2,
    );
    expect(terms).toContain("relevant");
    expect(terms).toContain("scorer");
    expect(terms).toContain("senior");
  });

  it("does not repeat a term", () => {
    const terms = expansionTerms(
      [
        hit({ symbol: "booking", path: "src/booking.js" }),
        hit({ symbol: "booking", path: "src/booking.js" }),
      ],
      2,
    );
    expect(terms.filter((term) => term === "booking")).toHaveLength(1);
  });

  it("only looks at the top k", () => {
    const terms = expansionTerms(
      [
        hit({ symbol: "wanted", path: "src/wanted.js" }),
        hit({ symbol: "ignored", path: "src/ignored.js" }),
      ],
      1,
    );
    expect(terms).toContain("wanted");
    expect(terms).not.toContain("ignored");
  });
});

describe("inverse document frequency", () => {
  it("gives a rare token a higher weight than a common one", () => {
    const df = new Map([["job", 900], ["is_relevant_jd", 3]]);
    const weights = idfWeights(["job", "is_relevant_jd"], df, 1000);
    expect(weights.get("is_relevant_jd")!).toBeGreaterThan(weights.get("job")!);
  });

  it("gives a token that appears in every chunk a weight of about zero", () => {
    const weights = idfWeights(["job"], new Map([["job", 1000]]), 1000);
    expect(weights.get("job")!).toBeLessThan(0.01);
  });

  it("drops the tokens that are too common to discriminate", () => {
    const df = new Map([["job", 900], ["scorer", 4]]);
    const generic = genericTokens(["job", "scorer"], df, 1000, 0.02);
    expect(generic.has("job")).toBe(true);
    expect(generic.has("scorer")).toBe(false);
  });

  it("drops nothing when the ratio is one", () => {
    const df = new Map([["job", 900]]);
    expect(genericTokens(["job"], df, 1000, 1).size).toBe(0);
  });
});

describe("reciprocal rank fusion with weights", () => {
  it("lets a weighted leg outrank a stronger unweighted one", () => {
    const heavy = fuseReciprocalRankFusion([
      { name: "vector", ids: ["a"], weight: 1 },
      { name: "keyword", ids: ["b"], weight: 4 },
    ]);
    expect(heavy[0]!.id).toBe("b");
  });

  it("keeps the default weight at one", () => {
    const plain = fuseReciprocalRankFusion([
      { name: "vector", ids: ["a"] },
      { name: "keyword", ids: ["b"] },
    ]);
    // Each document was found by exactly one leg, at rank 1, so each
    // scores 1/(k + 1) and neither outranks the other.
    expect(plain[0]!.score).toBeCloseTo(1 / 61, 10);
    expect(plain[1]!.score).toBeCloseTo(1 / 61, 10);
  });
});

describe("the shipped tuning", () => {
  it("excludes test files, because that was worth +9.5pp", () => {
    expect(DEFAULT_TUNING.excludeTests).toBe(true);
  });

  it("weights the keyword leg four times the vector leg", () => {
    expect(DEFAULT_TUNING.keywordWeight).toBe(4);
    expect(DEFAULT_TUNING.vectorWeight).toBe(1);
  });

  it("reranks the top twenty candidates", () => {
    expect(DEFAULT_TUNING.rerank).toBe(true);
    expect(DEFAULT_TUNING.rerankDepth).toBe(20);
  });

  it("does not drop generic query tokens, because that was measured to hurt", () => {
    expect(DEFAULT_TUNING.genericTokenDfRatio).toBe(1);
    expect(DEFAULT_TUNING.useIdf).toBe(false);
  });
});

describe("the read_file output cap", () => {
  it("clips a file that is longer than the cap", () => {
    const lines = Array.from({ length: 900 }, (_, index) => `line ${index + 1}`);
    const capped = capFileSlice({ startLine: 1, endLine: 900, lines });
    expect(capped.lines).toHaveLength(READ_FILE_MAX_LINES);
    expect(capped.endLine).toBe(READ_FILE_MAX_LINES);
    expect(capped.truncated).toBe(true);
  });

  it("leaves a short file alone", () => {
    const capped = capFileSlice({
      startLine: 10,
      endLine: 20,
      lines: Array.from({ length: 11 }, (_, index) => `line ${index}`),
    });
    expect(capped.lines).toHaveLength(11);
    expect(capped.truncated).toBe(false);
    expect(capped.startLine).toBe(10);
  });

  it("honours a range that fits inside the cap", () => {
    const capped = capFileSlice({
      startLine: 100,
      endLine: 150,
      lines: Array.from({ length: 51 }, (_, index) => `line ${index}`),
    });
    expect(capped.truncated).toBe(false);
    expect(capped.startLine).toBe(100);
    expect(capped.endLine).toBe(150);
  });
});
