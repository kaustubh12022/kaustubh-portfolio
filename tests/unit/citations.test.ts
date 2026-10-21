/**
 * The citation validator - the honesty gate.
 *
 *   npx vitest run tests/unit/citations.test.ts
 *
 * These tests run WITHOUT a database. The `pg` layer is mocked, so nothing
 * here can write to (or even read from) Neon.
 *
 * What is being asserted is the ONE property that matters for this project:
 * a citation that does not resolve against the source index is dropped, and
 * a citation that points at a range the model was never shown is dropped
 * even when the range happens to exist.
 */

import { describe, expect, it, vi } from "vitest";

/* ------------------------------------------------------------------ */
/* Mocked database layer                                               */
/* ------------------------------------------------------------------ */

interface FakeChunk {
  project_id: string;
  path: string;
  start_line: number;
  end_line: number;
  content: string;
  symbol: string;
}

const fake = vi.hoisted(() => {
  const state = { chunks: [] as FakeChunk[] };

  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const text = sql.toLowerCase();
    if (text.includes("from chunks")) {
      const projectId = String(values[0] ?? "");
      const path = String(values[1] ?? "");
      const rows = state.chunks.filter(
        (chunk) => chunk.project_id === projectId && chunk.path === path,
      );
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });

  return { state, query };
});

vi.mock("@/lib/retrieval/db", () => ({
  query: fake.query,
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: fake.query, release: vi.fn() }),
  withDirectTransaction: async (fn: (client: unknown) => Promise<unknown>) =>
    fn({ query: fake.query, release: vi.fn() }),
  setLocalSearchEffort: async () => undefined,
  closePool: async () => undefined,
}));

vi.mock("server-only", () => ({}));

import {
  downgradeConfidence,
  validateEvidence,
} from "@/lib/ai/citations";
import type { EvidenceRef } from "@/lib/types/chat";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const PROJECT = "smartapply";
const PATH = "src/scorer.py";

const BODY = [
  "def score_jobs(jobs):",
  "    # 1. Freshness filter",
  "    # 2. Filter irrelevant and senior jobs synchronously first",
  "    relevant_jobs = []",
  "    return relevant_jobs",
].join("\n");

function reset(): void {
  fake.state.chunks = [
    {
      project_id: PROJECT,
      path: PATH,
      start_line: 1,
      end_line: 5,
      content: BODY,
      symbol: "score_jobs",
    },
  ];
}

function ref(overrides: Partial<EvidenceRef> = {}): EvidenceRef {
  return {
    projectId: PROJECT,
    path: PATH,
    startLine: 1,
    endLine: 5,
    label: "",
    verified: false,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe("validateEvidence", () => {
  it("accepts a range the model was shown", async () => {
    reset();
    const result = await validateEvidence([ref()], {
      served: [{ projectId: PROJECT, path: PATH, startLine: 1, endLine: 5 }],
    });

    expect(result.rejected).toHaveLength(0);
    expect(result.verified).toHaveLength(1);
    expect(result.verified[0]?.verified).toBe(true);
    expect(result.verified[0]?.label).toBe("src/scorer.py:1-5");
    expect(result.verified[0]?.symbol).toBe("score_jobs");
  });

  it("rejects a range the model was never shown", async () => {
    reset();
    const result = await validateEvidence([ref()]);

    expect(result.verified).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.verified).toBe(false);
  });

  it("rejects a citation for a file that is not in the index", async () => {
    reset();
    const result = await validateEvidence(
      [ref({ path: "src/does_not_exist.py" })],
      {
        served: [
          { projectId: PROJECT, path: "src/does_not_exist.py", startLine: 1, endLine: 5 },
        ],
      },
    );

    expect(result.verified).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects a citation for a project that is not in the index", async () => {
    reset();
    const result = await validateEvidence([ref({ projectId: "c54" })], {
      served: [{ projectId: "c54", path: PATH, startLine: 1, endLine: 5 }],
    });

    expect(result.verified).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("accepts a quote that matches the indexed text exactly", async () => {
    reset();
    const result = await validateEvidence(
      [
        ref({
          startLine: 3,
          endLine: 3,
          quote: "    # 2. Filter irrelevant and senior jobs synchronously first",
        }),
      ],
      { served: [{ projectId: PROJECT, path: PATH, startLine: 1, endLine: 5 }] },
    );

    expect(result.rejected).toHaveLength(0);
    expect(result.verified).toHaveLength(1);
    expect(result.verified[0]?.label).toBe("src/scorer.py:3");
  });

  it("rejects a quote that does not match the indexed text", async () => {
    reset();
    const result = await validateEvidence(
      [ref({ quote: "    # 2. Filter irrelevant roles with a neural net" })],
      { served: [{ projectId: PROJECT, path: PATH, startLine: 1, endLine: 5 }] },
    );

    expect(result.verified).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects a quote that only covers part of the cited range", async () => {
    reset();
    const result = await validateEvidence(
      [ref({ quote: "    # 2. Filter irrelevant and senior jobs synchronously first" })],
      { served: [{ projectId: PROJECT, path: PATH, startLine: 1, endLine: 5 }] },
    );

    // The quote is line 3; the cited range is lines 1-5. The text at
    // [1, 5] is the whole body, so the quote does not match it.
    expect(result.verified).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("rejects an inverted or empty line range", async () => {
    reset();
    const result = await validateEvidence(
      [ref({ startLine: 9, endLine: 4 }), ref({ startLine: 0, endLine: 0 })],
      {
        served: [{ projectId: PROJECT, path: PATH, startLine: 1, endLine: 5 }],
      },
    );

    expect(result.verified).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
  });

  it("rejects a range that is not covered by the indexed chunks", async () => {
    reset();
    const result = await validateEvidence([ref({ startLine: 100, endLine: 120 })], {
      served: [{ projectId: PROJECT, path: PATH, startLine: 100, endLine: 120 }],
    });

    expect(result.verified).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);
  });

  it("returns an empty result for an empty batch", async () => {
    reset();
    const result = await validateEvidence([]);
    expect(result.verified).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });
});

describe("downgradeConfidence", () => {
  it("keeps the confidence when nothing was dropped", () => {
    expect(downgradeConfidence("high", 0)).toBe("high");
    expect(downgradeConfidence("medium", 0)).toBe("medium");
    expect(downgradeConfidence("low", 0)).toBe("low");
  });

  it("downgrades one level per dropped citation", () => {
    expect(downgradeConfidence("high", 1)).toBe("medium");
    expect(downgradeConfidence("medium", 1)).toBe("low");
    expect(downgradeConfidence("high", 2)).toBe("medium");
    expect(downgradeConfidence("low", 3)).toBe("low");
  });
});
