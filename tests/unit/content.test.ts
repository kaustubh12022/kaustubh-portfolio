import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  ArchitectureSchema,
  AssetSchema,
  ClaimSchema,
  MetricSchema,
  ProfileSchema,
  ProjectSchema,
} from "@/lib/content/schemas";

const contentRoot = join(process.cwd(), "content");
const publicRoot = join(process.cwd(), "public");

function readYaml(relativePath: string) {
  return parse(readFileSync(join(contentRoot, relativePath), "utf8"));
}

const profile = ProfileSchema.parse(readYaml("profile.yaml"));
const projects = readdirSync(join(contentRoot, "projects"))
  .filter((file) => file.endsWith(".yaml"))
  .map((file) => ProjectSchema.parse(readYaml(join("projects", file))));
const claims = ClaimSchema.array().parse(readYaml("claims.yaml"));
const metrics = MetricSchema.array().parse(readYaml("metrics.yaml"));
const assets = AssetSchema.array().parse(readYaml("assets.yaml"));

describe("profile", () => {
  it("uses the canonical GitHub account", () => {
    expect(profile.links.github).toBe("https://github.com/kaustubh12022");
  });

  it("keeps four-digit years in education", () => {
    for (const item of profile.education) {
      expect(item.dates).toMatch(/^\d{4} - \d{4}$/);
    }
  });

  it("marks the internship as resume-only", () => {
    expect(profile.experience[0]?.verification).toBe("resume-only");
  });
});

describe("projects", () => {
  it("contains the seven audited projects", () => {
    expect(projects.map((project) => project.id).sort()).toEqual(
      ["aura", "c54", "copilot", "dayscore", "pawna", "personal-ai-os", "smartapply"].sort(),
    );
  });

  it("has exactly five featured projects", () => {
    expect(projects.filter((project) => project.featured)).toHaveLength(5);
  });

  it("gives every project at least one ready asset", () => {
    // A project with no captureable screenshot yet may ship an empty asset
    // list: fabricating an asset is not allowed. Those projects are listed
    // explicitly so the exception cannot grow silently.
    const projectsWithoutAssets = new Set(["copilot"]);

    for (const project of projects) {
      if (projectsWithoutAssets.has(project.id)) {
        expect(project.assets, project.id).toHaveLength(0);
        continue;
      }

      expect(
        project.assets.some((asset) => asset.status === "ready"),
        `${project.id} has no ready asset`,
      ).toBe(true);
    }
  });

  it("gives every live project a URL and a repo", () => {
    for (const project of projects.filter((item) => item.status === "live")) {
      expect(project.live, `${project.id} live URL`).toBeTruthy();
      expect(project.repo, `${project.id} repo`).toBeTruthy();
    }
  });

  it("does not present SmartApply as a daily-volume product", () => {
    const smartapply = projects.find((project) => project.id === "smartapply");
    expect(smartapply).toBeTruthy();

    const publicCopy = [
      smartapply!.summary,
      ...smartapply!.highlights,
      ...smartapply!.metrics.map((metric) => `${metric.label}: ${metric.value}`),
    ].join(" ");

    expect(publicCopy).not.toContain("2,000+");
    expect(publicCopy).toContain("3,360");
    expect(publicCopy).toContain("1,032");
    expect(smartapply!.caveats.join(" ")).toContain("2,000+/day");
  });
});

describe("claim ledger", () => {
  it("marks the critical contradictions", () => {
    const byId = new Map(claims.map((claim) => [claim.id, claim]));
    expect(byId.get("medflow")?.status).toBe("contradicted");
    expect(byId.get("neon-pulse")?.status).toBe("contradicted");
    expect(byId.get("c54-socketio")?.status).toBe("contradicted");
    expect(byId.get("personal-ai-os-stack")?.status).toBe("contradicted");
    expect(byId.get("smartapply-volume")?.status).toBe("unverified");
    expect(byId.get("rag-vector")?.status).toBe("contradicted");
  });

  it("marks the stack and naming contradictions", () => {
    const byId = new Map(claims.map((claim) => [claim.id, claim]));
    expect(byId.get("c54-stack")?.status).toBe("contradicted");
    expect(byId.get("pawna-name")?.status).toBe("contradicted");
    expect(byId.get("smartapply-cost")?.status).toBe("unverified");
  });

  it("gives every claim a public wording", () => {
    for (const claim of claims) {
      expect(claim.publicWording.length, claim.id).toBeGreaterThan(20);
    }
  });
});

describe("metrics", () => {
  it("records the measured SmartApply batch", () => {
    const raw = metrics.find((metric) => metric.id === "smartapply-batch-raw");
    const scored = metrics.find((metric) => metric.id === "smartapply-batch-scored");

    expect(raw?.value).toBe("3,360");
    expect(scored?.value).toBe("1,032");
  });

  it("gives every metric a method and a source", () => {
    for (const metric of metrics) {
      expect(metric.method.length, metric.id).toBeGreaterThan(10);
      expect(metric.source.length, metric.id).toBeGreaterThan(3);
      expect(metric.verifiedAt, metric.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

describe("assets", () => {
  it("points only at existing public files", () => {
    for (const asset of assets) {
      expect(asset.src.startsWith("/media/"), asset.id).toBe(true);
      const diskPath = join(publicRoot, asset.src.replace(/^\//, ""));
      expect(existsSync(diskPath), `${asset.id} missing at ${diskPath}`).toBe(true);
    }
  });
});

describe("architecture diagrams", () => {
  const architectureDir = join(contentRoot, "architecture");

  function parseArchitecture(id: string) {
    const raw = JSON.parse(
      readFileSync(join(architectureDir, `${id}.json`), "utf8"),
    );
    return ArchitectureSchema.parse(raw);
  }

  function expectValidEdges(id: string, architecture: ReturnType<typeof parseArchitecture>) {
    const ids = new Set(architecture.nodes.map((node) => node.id));

    expect(architecture.id, id).toBe(id);
    expect(architecture.nodes.length, id).toBeGreaterThanOrEqual(4);

    for (const edge of architecture.edges) {
      expect(ids.has(edge.from), `${id}: ${edge.from}`).toBe(true);
      expect(ids.has(edge.to), `${id}: ${edge.to}`).toBe(true);
    }
  }

  it("has a valid diagram for every featured project", () => {
    for (const project of projects.filter((item) => item.featured)) {
      expectValidEdges(project.id, parseArchitecture(project.id));
    }
  });

  it("has a valid diagram for every captured project", () => {
    const captured = readdirSync(architectureDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => file.replace(/\.json$/, ""));

    for (const id of captured) {
      expectValidEdges(id, parseArchitecture(id));
    }
  });
});
