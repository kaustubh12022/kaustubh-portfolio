import type { MetadataRoute } from "next";

import { getMetricsForProject, getProjects } from "@/lib/content/load";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/**
 * Fallback `lastModified` for pages that carry no date of their own.
 *
 * The content layer was last audited on this date, so it is the honest
 * "as of" stamp for the pages that have nothing more specific.
 */
const AUDITED_AT = "2026-10-19";

/**
 * The newest verification date recorded for a project.
 *
 * This comes from `content/metrics.yaml`, so the sitemap never claims a
 * page changed after the evidence behind it was last checked.
 */
function lastModifiedFor(projectId: string): string {
  const verifiedAt = getMetricsForProject(projectId)
    .map((metric) => metric.verifiedAt)
    .filter((value) => typeof value === "string" && value.length > 0)
    .sort()
    .at(-1);

  return verifiedAt ?? AUDITED_AT;
}

export default function sitemap(): MetadataRoute.Sitemap {
  const projects = getProjects();

  return [
    {
      url: siteUrl,
      lastModified: AUDITED_AT,
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${siteUrl}/projects`,
      lastModified: AUDITED_AT,
      changeFrequency: "weekly",
      priority: 0.8,
    },
    ...projects.map((project) => ({
      url: `${siteUrl}/projects/${project.id}`,
      lastModified: lastModifiedFor(project.id),
      changeFrequency: "monthly" as const,
      priority: project.featured ? 0.9 : 0.7,
    })),
  ];
}
