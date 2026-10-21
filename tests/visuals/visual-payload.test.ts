/**
 * The visual payload - what the model is allowed to write and what the
 * server attaches on top of it.
 *
 *   npx vitest run tests/visuals/visual-payload.test.ts
 *
 * These tests run WITHOUT a database. The `pg` layer is mocked, so nothing
 * here can read from (or write to) Neon.
 *
 * WHAT IS BEING ASSERTED
 * ----------------------
 * The `code` and `data-model` visuals used to be dead: the Zod schema
 * stripped the fields the components read, so both cards rendered their
 * empty state 100% of the time. The fix puts those fields back into the
 * wire schema, which creates a NEW risk - if the model can write them, a
 * prompt injection can put arbitrary text into the code viewer.
 *
 * So the contract is:
 *
 *   1. the wire schema carries `code`, `language` and `entities`, so the
 *      server can attach them,
 *   2. the MODEL-FACING parse strips them, so the model cannot write them,
 *   3. the server attaches the real source, read out of the index.
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
  attachVisualPayload,
  parseVisualSpec,
  stripServerOwnedFields,
  VisualSpecSchema,
} from "@/lib/ai/tools";
import { getArchitectures } from "@/lib/content/load";
import type { VisualSpec } from "@/lib/types/chat";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const PROJECT = "smartapply";
const PATH = "src/scorer.py";

const BODY = [
  "def score_jobs(jobs):",
  "    relevant_jobs = []",
  "    return relevant_jobs",
].join("\n");

function reset(): void {
  fake.state.chunks = [
    {
      project_id: PROJECT,
      path: PATH,
      start_line: 1,
      end_line: 3,
      content: BODY,
      symbol: "score_jobs",
    },
  ];
}

/** The spec exactly as a model would write it. */
function modelCodeSpec(overrides: Record<string, unknown> = {}) {
  return {
    kind: "code",
    projectId: PROJECT,
    path: PATH,
    startLine: 1,
    endLine: 3,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* The wire schema                                                    */
/* ------------------------------------------------------------------ */

describe("VisualSpecSchema", () => {
  it("keeps the server-attached code and language on a code spec", () => {
    const parsed = VisualSpecSchema.parse(
      modelCodeSpec({ code: BODY, language: "python" }),
    );

    expect(parsed).toMatchObject({
      kind: "code",
      code: BODY,
      language: "python",
    });
  });

  it("keeps the server-attached entities on a data-model spec", () => {
    const entities = [
      {
        name: "User",
        fields: [{ name: "email", type: "String", required: true }],
      },
    ];

    const parsed = VisualSpecSchema.parse({
      kind: "data-model",
      projectId: "pawna",
      entities,
    });

    expect(parsed).toMatchObject({ kind: "data-model", entities });
  });

  it("still rejects a spec of an unknown kind", () => {
    expect(VisualSpecSchema.safeParse({ kind: "invented" }).success).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The model-facing parse                                              */
/* ------------------------------------------------------------------ */

describe("stripServerOwnedFields", () => {
  it("removes every field the server owns", () => {
    const stripped = stripServerOwnedFields({
      kind: "code",
      projectId: PROJECT,
      path: PATH,
      startLine: 1,
      endLine: 3,
      code: "rm -rf /",
      language: "python",
      entities: [{ name: "Fake", fields: [] }],
      rows: [{ label: "fake", value: "1" }],
    }) as Record<string, unknown>;

    expect(stripped).not.toHaveProperty("code");
    expect(stripped).not.toHaveProperty("language");
    expect(stripped).not.toHaveProperty("entities");
    expect(stripped).not.toHaveProperty("rows");
    expect(stripped).toMatchObject({ kind: "code", path: PATH });
  });

  it("leaves a non-object alone", () => {
    expect(stripServerOwnedFields("not a spec")).toBe("not a spec");
    expect(stripServerOwnedFields(null)).toBeNull();
  });
});

describe("parseVisualSpec", () => {
  it("drops a source string the model tried to write", () => {
    const parsed = parseVisualSpec(
      modelCodeSpec({ code: "<script>alert(1)</script>", language: "python" }),
    );

    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("code");
    expect(parsed).not.toHaveProperty("language");
  });

  it("drops entities the model tried to write", () => {
    const parsed = parseVisualSpec({
      kind: "data-model",
      projectId: "pawna",
      entities: [{ name: "FakeTable", fields: [] }],
    });

    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("entities");
    expect(parsed).toMatchObject({ kind: "data-model", projectId: "pawna" });
  });

  it("drops metric rows the model tried to write", () => {
    const parsed = parseVisualSpec({
      kind: "metrics",
      projectId: "smartapply",
      rows: [{ label: "made up", value: "999" }],
    });

    expect(parsed).not.toBeNull();
    expect(parsed).not.toHaveProperty("rows");
  });

  it("returns null for a spec of an unknown kind", () => {
    expect(parseVisualSpec({ kind: "invented" })).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* The server attachment                                               */
/* ------------------------------------------------------------------ */

describe("attachVisualPayload", () => {
  it("attaches the real source for a code spec", async () => {
    reset();

    const resolved = await attachVisualPayload(
      modelCodeSpec() as unknown as VisualSpec,
    );

    expect(resolved?.kind).toBe("code");
    if (resolved?.kind !== "code") return;

    expect(resolved.code).toBe(BODY);
    expect(resolved.language).toBe("python");
  });

  it("replaces a source the model tried to write with the indexed one", async () => {
    reset();

    const injected = "<script>alert('pwned')</script>";
    const declared = parseVisualSpec(
      modelCodeSpec({ code: injected, language: "python" }),
    );
    expect(declared).not.toHaveProperty("code");

    const resolved = await attachVisualPayload(
      declared as unknown as VisualSpec,
    );

    expect(resolved?.kind).toBe("code");
    if (resolved?.kind !== "code") return;

    expect(resolved.code).toBe(BODY);
    expect(resolved.code).not.toContain("script");
  });

  it("attaches no source for a path that is not in the index", async () => {
    reset();

    const resolved = await attachVisualPayload({
      kind: "code",
      projectId: PROJECT,
      path: "src/not_indexed.py",
      startLine: 1,
      endLine: 3,
      code: "<script>alert('pwned')</script>",
    });

    expect(resolved?.kind).toBe("code");
    if (resolved?.kind !== "code") return;

    expect(resolved.code).toBeUndefined();
  });

  it("attaches no source for a line range that is not covered", async () => {
    reset();

    const resolved = await attachVisualPayload({
      kind: "code",
      projectId: PROJECT,
      path: PATH,
      startLine: 900,
      endLine: 950,
    });

    expect(resolved?.kind).toBe("code");
    if (resolved?.kind !== "code") return;

    expect(resolved.code).toBeUndefined();
  });

  it("attaches the captured entities for a data-model spec", async () => {
    const resolved = await attachVisualPayload({
      kind: "data-model",
      projectId: "pawna",
    });

    expect(resolved?.kind).toBe("data-model");
    if (resolved?.kind !== "data-model") return;

    expect(resolved.entities?.length).toBeGreaterThan(0);

    const names = resolved.entities?.map((entity) => entity.name) ?? [];
    expect(names).toContain("User");
    expect(names).toContain("Booking");

    const user = resolved.entities?.find((entity) => entity.name === "User");
    expect(user?.fields.some((field) => field.name === "email")).toBe(true);
  });

  it("has a captured data model for every project that has a schema", async () => {
    const expected: Record<string, string[]> = {
      smartapply: ["tracked_jobs", "submission_audits", "daily_metrics"],
      pawna: ["User", "Booking", "Property", "Package", "Review", "Revenue"],
      c54: ["live_sessions", "players", "settlement_ledger"],
    };

    for (const [projectId, entityNames] of Object.entries(expected)) {
      const resolved = await attachVisualPayload({
        kind: "data-model",
        projectId,
      });

      expect(resolved?.kind).toBe("data-model");
      if (resolved?.kind !== "data-model") return;

      const names = resolved.entities?.map((entity) => entity.name) ?? [];
      for (const name of entityNames) {
        expect(names).toContain(name);
      }
    }
  });

  it("attaches no entities for a project with no captured data model", async () => {
    const resolved = await attachVisualPayload({
      kind: "data-model",
      projectId: "copilot",
    });

    expect(resolved?.kind).toBe("data-model");
    if (resolved?.kind !== "data-model") return;

    expect(resolved.entities).toBeUndefined();
  });

  it("attaches the verified metric rows with their provenance", async () => {
    const resolved = await attachVisualPayload({
      kind: "metrics",
      projectId: "smartapply",
    });

    expect(resolved?.kind).toBe("metrics");
    if (resolved?.kind !== "metrics") return;

    const rows = resolved.rows ?? [];
    expect(rows.length).toBeGreaterThan(0);

    for (const row of rows) {
      expect(row.method).not.toBe("");
      expect(row.source).not.toBe("");
      expect(row.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    // The number the panel shows has to be the one metrics.yaml records.
    const raw = rows.find((row) => row.label.includes("Raw postings"));
    expect(raw?.value).toBe("3,360");
  });

  it("leaves a visual it knows nothing about alone", async () => {
    const resolved = await attachVisualPayload({ kind: "profile" });

    expect(resolved).toEqual({ kind: "profile" });
  });
});

/* ------------------------------------------------------------------ */
/* The captured content layer                                          */
/* ------------------------------------------------------------------ */

describe("getArchitectures", () => {
  it("loads the diagram of EVERY project, not only the featured ones", () => {
    const architectures = getArchitectures();

    // DayScore is not featured, but its diagram IS captured. Loading only
    // the featured architectures made the assistant answer "not captured
    // yet" for a diagram that exists, which is false.
    expect(Object.keys(architectures)).toContain("dayscore");
    expect(Object.keys(architectures)).toContain("smartapply");
    expect(Object.keys(architectures)).toContain("pawna");
    expect(Object.keys(architectures)).toContain("c54");
    expect(Object.keys(architectures)).toContain("aura");
    expect(Object.keys(architectures)).toContain("personal-ai-os");
  });

  it("gives every architecture the nodes it was captured with", () => {
    const architectures = getArchitectures();

    for (const [id, architecture] of Object.entries(architectures)) {
      expect(architecture.id).toBe(id);
      expect(architecture.nodes.length).toBeGreaterThan(0);
    }
  });
});
