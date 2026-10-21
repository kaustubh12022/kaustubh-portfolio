import "server-only";

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cache } from "react";
import { parse } from "yaml";
import { z } from "zod";

import {
  ArchitectureSchema,
  AssetSchema,
  ClaimSchema,
  MetricSchema,
  ProfileSchema,
  ProjectSchema,
  type Profile,
} from "./schemas";

const CONTENT_ROOT = join(process.cwd(), "content");
const PROJECT_ORDER = [
  "smartapply",
  "pawna",
  "c54",
  "aura",
  "personal-ai-os",
  "dayscore",
];

function readYamlFile<T>(path: string, schema: z.ZodType<T>): T {
  const raw = readFileSync(path, "utf8");
  return schema.parse(parse(raw));
}

function readJsonFile<T>(path: string, schema: z.ZodType<T>): T {
  const raw = readFileSync(path, "utf8");
  return schema.parse(JSON.parse(raw));
}

export const getProfile = cache((): Profile => {
  return readYamlFile(join(CONTENT_ROOT, "profile.yaml"), ProfileSchema);
});

export const getProjects = cache(() => {
  const dir = join(CONTENT_ROOT, "projects");
  const projects = readdirSync(dir)
    .filter((file) => file.endsWith(".yaml") || file.endsWith(".yml"))
    .map((file) => readYamlFile(join(dir, file), ProjectSchema));

  return projects.sort((a, b) => {
    const ai = PROJECT_ORDER.indexOf(a.id);
    const bi = PROJECT_ORDER.indexOf(b.id);
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
});

export const getProject = cache((id: string) => {
  return getProjects().find((project) => project.id === id);
});

export const getFeaturedProjects = cache(() => {
  return getProjects().filter((project) => project.featured);
});

export const getClaims = cache(() => {
  return readYamlFile(join(CONTENT_ROOT, "claims.yaml"), z.array(ClaimSchema));
});

export const getClaim = cache((id: string) => {
  return getClaims().find((claim) => claim.id === id);
});

export const getMetrics = cache(() => {
  return readYamlFile(join(CONTENT_ROOT, "metrics.yaml"), z.array(MetricSchema));
});

export const getMetricsForProject = cache((projectId: string) => {
  return getMetrics().filter((metric) => metric.project === projectId);
});

export const getAssets = cache(() => {
  return readYamlFile(join(CONTENT_ROOT, "assets.yaml"), z.array(AssetSchema));
});

export const getAssetsForProject = cache((projectId: string) => {
  return getAssets().filter((asset) => asset.project === projectId);
});

export const getArchitecture = cache((id: string) => {
  return readJsonFile(
    join(CONTENT_ROOT, "architecture", `${id}.json`),
    ArchitectureSchema,
  );
});
