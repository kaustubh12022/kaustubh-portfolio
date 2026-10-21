"use client";

import { ArchitectureDiagram } from "@/components/visuals/ArchitectureDiagram";
import { CodeExplorer } from "@/components/visuals/CodeExplorer";
import { ComparisonCards } from "@/components/visuals/ComparisonCards";
import { ContactCard } from "@/components/visuals/ContactCard";
import { DataModelDiagram } from "@/components/visuals/DataModelDiagram";
import { EducationTimeline } from "@/components/visuals/EducationTimeline";
import { EvidenceTable } from "@/components/visuals/EvidenceTable";
import { FlowDiagram } from "@/components/visuals/FlowDiagram";
import { MetricPanel } from "@/components/visuals/MetricPanel";
import { ProfileCard } from "@/components/visuals/ProfileCard";
import { ProjectShowcase } from "@/components/visuals/ProjectShowcase";
import { SkillMap } from "@/components/visuals/SkillMap";
import { UnknownCard } from "@/components/visuals/UnknownCard";
import type { Architecture, Claim, Profile, Project } from "@/lib/content/schemas";
import { inferLanguage, type ComparisonRow, type VisualSpec } from "@/lib/types/chat";

type VisualRendererProps = {
  spec: VisualSpec;
  profile: Profile;
  projects: Project[];
  claims: Claim[];
  architectures: Record<string, Architecture>;
  onAsk: (question: string) => void;
};

/**
 * The comparison rows, derived from the verified project index.
 *
 * The server normally attaches the rows itself (see `attachComparisonRows`),
 * so this is the fallback for a spec that reached the client without them.
 * It reads the same verified content, so it cannot invent a project.
 */
function comparisonRows(projects: Project[], projectIds: string[]): ComparisonRow[] {
  return projectIds
    .map((id) => projects.find((item) => item.id === id))
    .filter((project): project is Project => Boolean(project))
    .map((project) => ({
      id: project.id,
      name: project.name,
      tagline: project.tagline,
      status: project.status,
      stack: project.stack,
      metrics: project.metrics.map((metric) => ({
        label: metric.label,
        value: metric.value,
        note: metric.note,
      })),
      caveats: project.caveats,
      summary: project.summary,
    }));
}

export function VisualRenderer({
  spec,
  profile,
  projects,
  claims,
  architectures,
  onAsk,
}: VisualRendererProps) {
  if (spec.kind === "profile") {
    return (
      <ProfileCard
        profile={profile}
        featured={projects.filter((project) => project.featured)}
        onAsk={onAsk}
      />
    );
  }

  if (spec.kind === "education") {
    return <EducationTimeline education={profile.education} />;
  }

  if (spec.kind === "skills") {
    return <SkillMap profile={profile} />;
  }

  if (spec.kind === "claims") {
    const selected = spec.claimIds
      .map((id) => claims.find((claim) => claim.id === id))
      .filter((claim): claim is Claim => Boolean(claim));

    if (!selected.length) {
      return <UnknownCard reason="No matching claims are in the verified ledger yet." />;
    }

    return <EvidenceTable claims={selected} />;
  }

  if (spec.kind === "project") {
    const project = projects.find((item) => item.id === spec.projectId);
    if (!project) {
      return <UnknownCard reason="That project is not in the verified project index." />;
    }
    return <ProjectShowcase project={project} onAsk={onAsk} />;
  }

  if (spec.kind === "architecture") {
    const architecture = architectures[spec.projectId];
    if (!architecture) {
      return <UnknownCard reason="The architecture diagram for that project is not captured yet." />;
    }
    return <ArchitectureDiagram architecture={architecture} />;
  }

  if (spec.kind === "flow") {
    const architecture = architectures[spec.projectId];
    if (!architecture) {
      return <UnknownCard reason="The step flow for that project is not captured yet." />;
    }
    return <FlowDiagram architecture={architecture} />;
  }

  if (spec.kind === "data-model") {
    // `entities` is attached by the server from the captured data model
    // (`content/datamodel/<projectId>.json`). When nothing was captured the
    // diagram renders its honest empty frame instead of invented tables.
    return (
      <DataModelDiagram
        entities={spec.entities ?? []}
        projectId={spec.projectId}
      />
    );
  }

  if (spec.kind === "code") {
    // `code` and `language` are attached by the server, which re-reads the
    // range out of the source index. The model never supplies them, so a
    // prompt injection cannot put arbitrary text into the viewer. When the
    // range does not resolve, `code` is absent and the card says so.
    return (
      <CodeExplorer
        projectId={spec.projectId}
        path={spec.path}
        startLine={spec.startLine}
        endLine={spec.endLine}
        code={spec.code ?? ""}
        language={spec.language ?? inferLanguage(spec.path)}
      />
    );
  }

  if (spec.kind === "comparison") {
    const rows = spec.rows ?? comparisonRows(projects, spec.projectIds);

    if (!rows.length) {
      return <UnknownCard reason="None of those projects are in the verified project index, so there is nothing to compare." />;
    }

    return <ComparisonCards projects={rows} dimension={spec.dimension} />;
  }

  if (spec.kind === "metrics") {
    // The rows are attached by the server from `content/metrics.yaml`, the
    // only file that records the method, the source and the date of every
    // number. There is deliberately no client-side fallback: a project file
    // carries a label and a value but no provenance, so a number without
    // one cannot be shown in a panel that claims the source is
    // `metrics.yaml`.
    const rows = spec.rows ?? [];

    if (!rows.length) {
      return <UnknownCard reason="No verified metric is recorded for that project yet." />;
    }

    return <MetricPanel metrics={rows} />;
  }

  if (spec.kind === "contact") {
    return <ContactCard profile={profile} />;
  }

  return <UnknownCard reason="I do not have a visual for that answer yet." />;
}
