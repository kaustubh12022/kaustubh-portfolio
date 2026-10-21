import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { CodeExplorer } from "@/components/visuals/CodeExplorer";
import { ComparisonCards } from "@/components/visuals/ComparisonCards";
import { ContactCard } from "@/components/visuals/ContactCard";
import { DataModelDiagram } from "@/components/visuals/DataModelDiagram";
import { EducationTimeline } from "@/components/visuals/EducationTimeline";
import { FlowDiagram } from "@/components/visuals/FlowDiagram";
import { MetricPanel } from "@/components/visuals/MetricPanel";
import {
  ArchitectureSchema,
  ProfileSchema,
  type Profile,
} from "@/lib/content/schemas";

const contentRoot = join(process.cwd(), "content");

function readYaml<T>(relativePath: string): T {
  return parse(readFileSync(join(contentRoot, relativePath), "utf8")) as T;
}

const profile = ProfileSchema.parse(readYaml("profile.yaml"));
const smartapplyArchitecture = ArchitectureSchema.parse(
  JSON.parse(
    readFileSync(join(contentRoot, "architecture", "smartapply.json"), "utf8"),
  ),
);

const emptyProfile: Profile = {
  name: "",
  headline: "",
  location: "",
  email: "",
  links: { github: "", linkedin: "" },
  availability: { status: "", roles: [], locations: [] },
  summary: "",
  education: [],
  experience: [],
  skills: { shipped: {}, internship: [], coursework: [], building: [] },
  languages: [],
};

const sampleCode = [
  "def score(job):",
  "    payload = build_payload(job)",
  "    return deepseek.chat(payload)",
].join("\n");

const longCode = Array.from(
  { length: 200 },
  (_, index) => `line_${index + 1} = ${index + 1}`,
).join("\n");

describe("EducationTimeline", () => {
  it("renders the recorded education entries with their grades", () => {
    const html = renderToStaticMarkup(
      createElement(EducationTimeline, { education: profile.education }),
    );

    expect(html).toContain("SKNSITS");
    expect(html).toContain("B.E. Information Technology");
    expect(html).toContain("HSC (Science)");
    expect(html).toContain("SSC");
    expect(html).toContain("7.51");
    expect(html).toContain("82.33");
  });

  it("shows an honest empty state when there is no education", () => {
    const html = renderToStaticMarkup(
      createElement(EducationTimeline, { education: [] }),
    );

    expect(html).toContain("No education entries are recorded");
    expect(html).not.toContain("SKNSITS");
  });
});

describe("FlowDiagram", () => {
  it("renders the walk-through steps and their edge labels", () => {
    const html = renderToStaticMarkup(
      createElement(FlowDiagram, { architecture: smartapplyArchitecture }),
    );

    expect(html).toContain("Scrape");
    expect(html).toContain("DeepSeek score");
    expect(html).toContain("3,360 raw");
    expect(html).toContain("step 1 of");
  });

  it("shows an honest empty state when the graph has no nodes", () => {
    const html = renderToStaticMarkup(
      createElement(FlowDiagram, {
        architecture: {
          ...smartapplyArchitecture,
          nodes: [],
          edges: [],
          notes: [],
        },
      }),
    );

    expect(html).toContain("No steps are captured for this flow");
    expect(html).not.toContain("DeepSeek score");
  });
});

describe("DataModelDiagram", () => {
  it("renders entities, fields and relations", () => {
    const html = renderToStaticMarkup(
      createElement(DataModelDiagram, {
        projectId: "pawna",
        entities: [
          {
            name: "User",
            fields: [
              { name: "id", type: "ObjectId", required: true },
              { name: "email", type: "String", required: true },
            ],
            relations: [
              { from: "User", to: "Booking", label: "places", kind: "1-n" },
            ],
          },
          {
            name: "Booking",
            fields: [
              { name: "ownerId", type: "ObjectId", required: true, relation: "User" },
            ],
          },
        ],
      }),
    );

    expect(html).toContain("User");
    expect(html).toContain("Booking");
    expect(html).toContain("ownerId");
    expect(html).toContain("1-n");
    expect(html).toContain("places");
  });

  it("refuses to invent tables when no data model is captured", () => {
    const html = renderToStaticMarkup(
      createElement(DataModelDiagram, { entities: [], projectId: "c54" }),
    );

    expect(html).toContain("No data model is captured for this project");
    expect(html).not.toContain("<table");
  });
});

describe("CodeExplorer", () => {
  it("renders the path, the line range and the source lines", () => {
    const html = renderToStaticMarkup(
      createElement(CodeExplorer, {
        projectId: "smartapply",
        path: "src/ai_engine.py",
        startLine: 38,
        endLine: 40,
        code: sampleCode,
        language: "python",
      }),
    );

    expect(html).toContain("src/ai_engine.py");
    expect(html).toContain("L38");
    expect(html).toContain("L40");
    expect(html).toContain("build_payload");
    expect(html).toContain("38");
  });

  it("caps a long block and says how many lines were elided", () => {
    const html = renderToStaticMarkup(
      createElement(CodeExplorer, {
        projectId: "smartapply",
        path: "src/long.py",
        startLine: 1,
        endLine: 200,
        code: longCode,
        language: "python",
      }),
    );

    expect(html).toContain("elided");
    expect(html).toContain("80 more lines elided");
  });

  it("shows an honest empty state when no source text is attached", () => {
    const html = renderToStaticMarkup(
      createElement(CodeExplorer, {
        projectId: "smartapply",
        path: "src/ai_engine.py",
        startLine: 38,
        endLine: 40,
        code: "",
        language: "python",
      }),
    );

    expect(html).toContain("No source text is attached to this citation");
    expect(html).not.toContain("<pre");
  });
});

describe("ComparisonCards", () => {
  it("renders every project and marks the differences", () => {
    const html = renderToStaticMarkup(
      createElement(ComparisonCards, {
        dimension: "stack",
        projects: [
          {
            id: "smartapply",
            name: "SmartApply",
            tagline: "Job automation pipeline",
            status: "prototype",
            stack: ["Python", "DeepSeek"],
            metrics: [{ label: "Code lines", value: "39.7k" }],
            caveats: ["Not a hosted product."],
          },
          {
            id: "pawna",
            name: "Pawna",
            tagline: "Booking platform",
            status: "live",
            stack: ["Node.js", "MongoDB"],
            metrics: [{ label: "Code lines", value: "17.2k" }],
            caveats: ["Booking creation has no transaction."],
          },
        ],
      }),
    );

    expect(html).toContain("SmartApply");
    expect(html).toContain("Pawna");
    expect(html).toContain("DeepSeek");
    expect(html).toContain("MongoDB");
    expect(html).toContain("Only SmartApply lists DeepSeek");
    expect(html).toContain("Prototype");
    expect(html).toContain("Live");
  });

  it("shows an honest empty state when there is nothing to compare", () => {
    const html = renderToStaticMarkup(
      createElement(ComparisonCards, { projects: [] }),
    );

    expect(html).toContain("There is nothing to compare yet");
    expect(html).not.toContain("SmartApply");
  });
});

describe("MetricPanel", () => {
  it("renders the value with its method and source", () => {
    const html = renderToStaticMarkup(
      createElement(MetricPanel, {
        metrics: [
          {
            label: "Raw postings in the recorded batch",
            value: "3,360",
            unit: "postings",
            method: "Single recorded batch; not a daily rate.",
            source: "JobHunt-Automation/full_matrix_results.json",
            verifiedAt: "2026-10-05",
          },
        ],
      }),
    );

    expect(html).toContain("3,360");
    expect(html).toContain("postings");
    expect(html).toContain("Single recorded batch");
    expect(html).toContain("full_matrix_results.json");
    expect(html).toContain("2026-10-05");
    expect(html).toContain("How this was measured");
  });

  it("shows an honest empty state when no metric is attached", () => {
    const html = renderToStaticMarkup(
      createElement(MetricPanel, { metrics: [] }),
    );

    expect(html).toContain("No verified metric is attached to this answer");
  });
});

describe("ContactCard", () => {
  it("renders real mailto and external links", () => {
    const html = renderToStaticMarkup(
      createElement(ContactCard, { profile }),
    );

    expect(html).toContain(`mailto:${profile.email}`);
    expect(html).toContain(profile.links.github);
    expect(html).toContain(profile.links.linkedin);
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain(profile.location);
  });

  it("shows an honest empty state when the profile has no contact details", () => {
    const html = renderToStaticMarkup(
      createElement(ContactCard, { profile: emptyProfile }),
    );

    expect(html).toContain("No contact details are recorded");
    expect(html).not.toContain("mailto:");
  });
});
