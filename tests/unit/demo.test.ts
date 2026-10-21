import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { ProjectSchema, ProfileSchema, ClaimSchema } from "@/lib/content/schemas";
import { buildDemoAnswer } from "@/lib/demo/answers";

const root = join(process.cwd(), "content");
const profile = ProfileSchema.parse(parse(readFileSync(join(root, "profile.yaml"), "utf8")));
const projects = readdirSync(join(root, "projects"))
  .filter((file) => file.endsWith(".yaml"))
  .map((file) =>
    ProjectSchema.parse(parse(readFileSync(join(root, "projects", file), "utf8"))),
  );
const claims = ClaimSchema.array().parse(
  parse(readFileSync(join(root, "claims.yaml"), "utf8")),
);

const context = { profile, projects, claims };

describe("demo answer routing", () => {
  it("routes an architecture question to the SmartApply diagram", () => {
    const answer = buildDemoAnswer("How does SmartApply work?", context);
    expect(answer.visual).toEqual({
      kind: "architecture",
      projectId: "smartapply",
    });
  });

  it("routes a resume question to the claim ledger", () => {
    const answer = buildDemoAnswer("Does your resume match the code?", context);
    expect(answer.visual?.kind).toBe("claims");
  });

  it("answers Java questions honestly", () => {
    const answer = buildDemoAnswer("What is your Java experience?", context);
    expect(answer.text).toContain("no Spring Boot or MySQL project");
    expect(answer.visual?.kind).toBe("claims");
  });

  it("routes the default prompt to the profile", () => {
    const answer = buildDemoAnswer("What did you build?", context);
    expect(answer.visual).toEqual({ kind: "profile" });
  });

  it("routes project follow-ups without losing the project", () => {
    const pawna = buildDemoAnswer("Is Pawna multi-tenant?", context);
    expect(pawna.visual).toEqual({ kind: "project", projectId: "pawna" });
  });
});
