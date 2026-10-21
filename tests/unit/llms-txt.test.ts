import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  ClaimSchema,
  ProjectSchema,
} from "@/lib/content/schemas";

const contentRoot = join(process.cwd(), "content");
const llmsPath = join(process.cwd(), "public", "llms.txt");

const llms = readFileSync(llmsPath, "utf8");
const projects = readdirSync(join(contentRoot, "projects"))
  .filter((file) => file.endsWith(".yaml"))
  .map((file) => ProjectSchema.parse(parse(readFileSync(join(contentRoot, "projects", file), "utf8"))));
const claims = ClaimSchema.array().parse(
  parse(readFileSync(join(contentRoot, "claims.yaml"), "utf8")),
);

const oneLine = (value: string) => value.replace(/\s+/g, " ").trim();

describe("llms.txt", () => {
  it("exists and is a plain-text artefact", () => {
    expect(llms.length).toBeGreaterThan(1000);
    expect(llms.startsWith("# ")).toBe(true);
  });

  it("identifies the owner", () => {
    expect(llms).toContain("Kaustubh Kale");
    expect(llms).toContain("Graduate Engineer");
    expect(llms).toContain("Pune, Maharashtra, India");
    expect(llms).toContain("https://github.com/kaustubh12022");
    expect(llms).toContain("https://linkedin.com/in/kaustubhkale12");
  });

  it("lists every project with its real repository and page path", () => {
    for (const project of projects) {
      expect(llms, project.id).toContain(project.name);
      expect(llms, project.id).toContain(`/projects/${project.id}`);
      expect(llms, project.id).toContain(project.repo ?? "");
      expect(llms, project.id).toContain(oneLine(project.summary));
    }
  });

  it("carries every claim with its status and approved wording", () => {
    for (const claim of claims) {
      expect(llms, claim.id).toContain(`\`${claim.id}\``);
      expect(llms, claim.id).toContain(oneLine(claim.claim));
      expect(llms, claim.id).toContain(oneLine(claim.publicWording));
    }
  });

  it("groups the contradicted claims under their own heading", () => {
    expect(llms).toContain("Contradicted");

    const contradicted = claims.filter((claim) => claim.status === "contradicted");
    expect(contradicted.length).toBeGreaterThan(0);

    const section = llms.slice(llms.indexOf("Contradicted"));
    for (const claim of contradicted) {
      expect(section, claim.id).toContain(`\`${claim.id}\``);
    }
  });

  it("does not point at the empty GitHub account", () => {
    // `kaustubhkale12` holds none of these projects; linking it would send a
    // reader to an empty profile. The claim ledger names it only as the
    // claim that was contradicted, so the project section must be clean.
    const projectsSection = llms.slice(
      llms.indexOf("## Projects"),
      llms.indexOf("## Claim ledger"),
    );

    expect(projectsSection).not.toContain("github.com/kaustubhkale12");
    expect(projectsSection).toContain("github.com/kaustubh12022");
  });

  it("does not restate a contradicted claim as a project fact", () => {
    const contradicted = claims.filter((claim) => claim.status === "contradicted");

    for (const project of projects) {
      const projectFacts = [
        project.summary,
        ...project.highlights,
        ...project.stack,
      ]
        .join(" ")
        .toLowerCase();

      for (const claim of contradicted) {
        const marker = claim.claim.toLowerCase();
        // Only flag a claim whose distinctive phrase appears in the copy.
        if (marker.length < 12) continue;
        expect(projectFacts, `${project.id} / ${claim.id}`).not.toContain(marker);
      }
    }
  });
});
