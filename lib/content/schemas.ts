import { z } from "zod";

const SkillGroupsSchema = z.record(z.string(), z.array(z.string()));

export const ProfileSchema = z.object({
  name: z.string(),
  headline: z.string(),
  location: z.string(),
  email: z.string(),
  phone: z.string().optional(),
  links: z.object({
    github: z.string(),
    linkedin: z.string(),
  }),
  availability: z.object({
    status: z.string(),
    roles: z.array(z.string()),
    locations: z.array(z.string()),
  }),
  summary: z.string(),
  education: z.array(
    z.object({
      institution: z.string(),
      credential: z.string(),
      dates: z.string(),
      grade: z.string(),
      location: z.string().optional(),
      board: z.string().optional(),
    }),
  ),
  experience: z.array(
    z.object({
      company: z.string(),
      role: z.string(),
      dates: z.string(),
      location: z.string(),
      bullets: z.array(z.string()),
      verification: z.enum(["verified", "resume-only"]),
      note: z.string().optional(),
    }),
  ),
  skills: z.object({
    shipped: SkillGroupsSchema,
    internship: z.array(z.string()),
    coursework: z.array(z.string()),
    building: z.array(z.string()),
  }),
  languages: z.array(
    z.object({
      language: z.string(),
      proficiency: z.string(),
    }),
  ),
});

export const ProjectStatusSchema = z.enum([
  "live",
  "prototype",
  "assessment",
  "archived",
]);

export const ProjectAssetSchema = z.object({
  src: z.string(),
  alt: z.string(),
  caption: z.string(),
  kind: z.enum(["screenshot", "photo", "diagram", "video", "icon", "card"]),
  status: z.enum(["ready", "needed"]),
});

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  tagline: z.string(),
  status: ProjectStatusSchema,
  role: z.string(),
  timeline: z.string(),
  repo: z.string().nullable(),
  live: z.string().nullable(),
  featured: z.boolean().default(false),
  stack: z.array(z.string()),
  summary: z.string(),
  highlights: z.array(z.string()).default([]),
  features: z.array(
    z.object({
      title: z.string(),
      detail: z.string(),
      evidence: z.string().optional(),
    }),
  ),
  metrics: z.array(
    z.object({
      label: z.string(),
      value: z.string(),
      note: z.string().optional(),
    }),
  ),
  caveats: z.array(z.string()).default([]),
  assets: z.array(ProjectAssetSchema).default([]),
});

export const ClaimSchema = z.object({
  id: z.string(),
  topic: z.string(),
  claim: z.string(),
  status: z.enum(["verified", "partial", "unverified", "contradicted"]),
  evidence: z.string(),
  source: z.string().optional(),
  publicWording: z.string(),
});

export const MetricSchema = z.object({
  id: z.string(),
  project: z.string(),
  label: z.string(),
  value: z.string(),
  unit: z.string().optional(),
  method: z.string(),
  source: z.string(),
  verifiedAt: z.string(),
});

export const AssetSchema = z.object({
  id: z.string(),
  project: z.string(),
  kind: z.enum(["screenshot", "photo", "diagram", "video", "icon", "card"]),
  src: z.string(),
  sourcePath: z.string().optional(),
  alt: z.string(),
  caption: z.string(),
  capturedAt: z.string().optional(),
  status: z.enum(["ready", "needed"]),
});

export const ArchitectureSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  direction: z.enum(["horizontal", "vertical"]).default("horizontal"),
  columns: z
    .array(
      z.object({
        id: z.string(),
        label: z.string(),
      }),
    )
    .optional(),
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      detail: z.string().optional(),
      column: z.number().optional(),
      tone: z.enum(["ink", "accent", "muted", "warn"]).optional(),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string(),
      to: z.string(),
      label: z.string().optional(),
      dashed: z.boolean().optional(),
    }),
  ),
  notes: z.array(z.string()).default([]),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;
export type ProjectAsset = z.infer<typeof ProjectAssetSchema>;
export type Claim = z.infer<typeof ClaimSchema>;
export type Metric = z.infer<typeof MetricSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Architecture = z.infer<typeof ArchitectureSchema>;
