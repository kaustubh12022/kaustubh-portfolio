import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AlertTriangle, ArrowUpRight, ExternalLink, MessageCircle } from "lucide-react";

import { GitHubIcon } from "@/components/icons/BrandIcons";
import { ArchitectureDiagram } from "@/components/visuals/ArchitectureDiagram";
import { MetricPanel } from "@/components/visuals/MetricPanel";

import {
  getArchitecture,
  getMetricsForProject,
  getProject,
  getProjects,
} from "@/lib/content/load";
import type {
  Architecture,
  Project,
  ProjectStatus,
} from "@/lib/content/schemas";
import type { MetricRow } from "@/lib/types/chat";
import { cn } from "@/lib/utils";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

/**
 * Intrinsic pixel size of the files in `public/media`.
 *
 * `next/image` needs the real aspect ratio to reserve the right box and to
 * avoid a layout shift, and these are the dimensions of the committed files.
 */
const ASSET_DIMENSIONS: Record<string, { width: number; height: number }> = {
  "/media/aura/card.png": { width: 2400, height: 1254 },
  "/media/aura/live-app.png": { width: 1200, height: 627 },
  "/media/c54/icon-512.png": { width: 1024, height: 1024 },
  "/media/dayscore/icon-512.png": { width: 1024, height: 1024 },
  "/media/pawna/cover.webp": { width: 1280, height: 960 },
  "/media/personal-ai-os/card.png": { width: 1200, height: 627 },
  "/media/smartapply/dashboard-mobile.png": { width: 390, height: 844 },
  "/media/smartapply/dashboard-scanning.png": { width: 1280, height: 850 },
  "/media/smartapply/dashboard-tracker.png": { width: 1280, height: 850 },
  "/media/smartapply/job-cards.png": { width: 1000, height: 600 },
};

const DEFAULT_DIMENSIONS = { width: 1280, height: 800 };

/** Mirrors `components/visuals/ProjectShowcase.tsx`. */
const statusStyles: Record<
  ProjectStatus,
  { label: string; className: string; dot: string }
> = {
  live: {
    label: "Live",
    className: "border-live/25 bg-live/10 text-live",
    dot: "bg-live",
  },
  prototype: {
    label: "Prototype",
    className: "border-warn/25 bg-warn/10 text-warn",
    dot: "bg-warn",
  },
  assessment: {
    label: "Assessment",
    className: "border-accent/25 bg-accent-soft text-accent",
    dot: "bg-accent",
  },
  archived: {
    label: "Archived",
    className: "border-line bg-paper-deep text-muted",
    dot: "bg-muted",
  },
};

type ProjectPageProps = {
  params: Promise<{ slug: string }>;
};

/**
 * `getProject` throws for an unknown id in some revisions of the content
 * layer and returns `undefined` in others. Both are handled the same way:
 * an unknown slug is a 404, never a half-rendered page.
 */
function loadProject(id: string): Project | null {
  try {
    const found: Project | undefined = getProject(id);
    return found ?? null;
  } catch {
    return null;
  }
}

/**
 * Not every project has a diagram (`copilot` has none), and reading a
 * missing file throws. A missing diagram simply means the section is
 * omitted.
 */
function loadArchitecture(id: string): Architecture | null {
  try {
    const found: Architecture = getArchitecture(id);
    return found ?? null;
  } catch {
    return null;
  }
}

/**
 * Words that must never end a cut sentence: a description that ends on
 * "scores the…" reads like a bug.
 */
const DANGLING_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "before", "but", "by",
  "can", "could", "did", "do", "does", "for", "from", "had", "has", "have",
  "her", "his", "if", "in", "into", "is", "it", "its", "may", "might", "my",
  "of", "on", "or", "over", "our", "so", "than", "that", "the", "their",
  "then", "to", "was", "were", "when", "which", "while", "will", "with",
  "would", "your",
]);

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;

  const slice = clean.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const words = (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).split(" ");

  const last = words[words.length - 1]?.toLowerCase() ?? "";
  if (DANGLING_WORDS.has(last)) words.pop();

  const head = words.join(" ").replace(/[.,;:,\s]+$/, "");
  return `${head}…`;
}

/**
 * The description is assembled only from the project's own copy — its name,
 * tagline and summary. Nothing is invented here.
 */
function buildDescription(project: Project): string {
  const lead = `${project.name} — ${project.tagline}.`;
  const budget = 165 - lead.length - 1;

  return `${lead} ${truncate(project.summary, budget)}`;
}

export async function generateStaticParams() {
  const projects = getProjects();
  return projects.map((project) => ({ slug: project.id }));
}

export async function generateMetadata({
  params,
}: ProjectPageProps): Promise<Metadata> {
  const { slug } = await params;
  const project = loadProject(slug);

  if (!project) {
    return { title: "Project not found" };
  }

  const description = buildDescription(project);
  const title = `${project.name} — ${project.tagline}`;
  const url = `${siteUrl}/projects/${project.id}`;

  return {
    title: project.name,
    description,
    alternates: {
      canonical: `/projects/${project.id}`,
    },
    openGraph: {
      type: "article",
      title,
      description,
      url,
      siteName: "Kaustubh Kale",
      /**
       * A page-level `openGraph` object replaces the inherited one, so the
       * file-based Open Graph image has to be named again here. `/opengraph-image`
       * is the generated card in `app/opengraph-image.tsx`.
       */
      images: [
        {
          url: "/opengraph-image",
          width: 1200,
          height: 630,
          alt: `${project.name} — ${project.tagline}`,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/opengraph-image"],
    },
    other: project.repo
      ? { "project:repository": project.repo }
      : undefined,
  };
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { slug } = await params;
  const project = loadProject(slug);

  if (!project) {
    notFound();
  }

  const architecture = loadArchitecture(project.id);
  const metrics = getMetricsForProject(project.id);
  const metricRows: MetricRow[] = metrics.map((metric) => ({
    label: metric.label,
    value: metric.value,
    unit: metric.unit,
    method: metric.method,
    source: metric.source,
    verifiedAt: metric.verifiedAt,
  }));

  const readyAssets = project.assets.filter((asset) => asset.status === "ready");
  const hasScreenshot = readyAssets.some((asset) => asset.kind === "screenshot");
  const status = statusStyles[project.status];
  const question = `How does ${project.name} work?`;

  return (
    <main className="paper-grain relative min-h-dvh bg-paper">
      <div className="pointer-events-none absolute inset-0 hero-grid" aria-hidden />

      <div className="relative mx-auto w-full max-w-4xl px-5 py-7 sm:px-8 sm:py-12">
        <nav className="flex flex-wrap items-center justify-between gap-3">
          <Link
            href="/"
            className="flex items-center gap-2.5 text-left transition-opacity hover:opacity-80"
          >
            <span className="flex h-9 w-9 items-center justify-center rounded-[11px] border border-line-strong/80 bg-white/70 font-display text-[15px] shadow-sm">
              KK
            </span>
            <span className="text-[13px] font-medium tracking-[-0.01em] text-ink">
              Kaustubh Kale
            </span>
          </Link>

          <Link
            href="/projects"
            className="rounded-full border border-line bg-white/50 px-3 py-1.5 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            All projects
          </Link>
        </nav>

        {/* ---------------------------------------------------------- */}
        {/* 1. Header                                                   */}
        {/* ---------------------------------------------------------- */}
        <header className="mt-9 sm:mt-12">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium backdrop-blur",
                status.className,
              )}
            >
              <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
              {status.label}
            </span>
            <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
              {project.role} · {project.timeline}
            </span>
          </div>

          <h1 className="mt-4 font-display text-[clamp(2.6rem,8vw,4.6rem)] leading-[0.92] tracking-[-0.035em] text-ink">
            {project.name}
          </h1>

          <p className="mt-3 max-w-[46ch] text-[15px] leading-[1.6] text-muted">
            {project.tagline}
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            {project.repo ? (
              <a
                href={project.repo}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper/70 px-3 py-1.5 text-[11.5px] text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
              >
                <GitHubIcon className="h-3.5 w-3.5" />
                Code
              </a>
            ) : null}
            {project.live ? (
              <a
                href={project.live}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-accent/30 bg-accent-soft/60 px-3 py-1.5 text-[11.5px] text-accent transition-colors hover:bg-accent-soft"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                Live
              </a>
            ) : null}
          </div>

          <div className="mt-5 flex flex-wrap gap-1.5">
            {project.stack.map((item) => (
              <span
                key={item}
                className="rounded-full border border-line bg-paper/70 px-2.5 py-1 text-[11px] text-muted"
              >
                {item}
              </span>
            ))}
          </div>
        </header>

        {/* ---------------------------------------------------------- */}
        {/* 2. Summary                                                  */}
        {/* ---------------------------------------------------------- */}
        <section className="mt-9 sm:mt-12">
          <h2 className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted">
            Summary
          </h2>
          <p className="mt-3 max-w-[68ch] text-[15px] leading-[1.68] text-ink-soft">
            {project.summary}
          </p>
        </section>

        {/* ---------------------------------------------------------- */}
        {/* 3. Real captures                                            */}
        {/* ---------------------------------------------------------- */}
        <section className="mt-9 overflow-hidden rounded-[22px] border border-line bg-white/65 shadow-[0_1px_0_rgba(20,19,15,0.03)] sm:mt-12">
          <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-4 sm:px-6">
            <div>
              <h2 className="font-display text-[22px] leading-none tracking-[-0.02em] text-ink">
                {hasScreenshot ? "Screenshots" : "Project assets"}
              </h2>
              <p className="mt-1.5 max-w-[46ch] text-[12px] text-muted">
                Real files from the project. Only assets marked ready are
                published here.
              </p>
            </div>
            <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
              assets.yaml
            </span>
          </div>

          {readyAssets.length ? (
            <div className="grid gap-3 p-4 sm:grid-cols-2 sm:p-5">
              {readyAssets.map((asset) => {
                const dimensions =
                  ASSET_DIMENSIONS[asset.src] ?? DEFAULT_DIMENSIONS;

                return (
                  <figure
                    key={asset.src}
                    className="overflow-hidden rounded-xl border border-line bg-paper-deep"
                  >
                    <Image
                      src={asset.src}
                      alt={asset.alt}
                      width={dimensions.width}
                      height={dimensions.height}
                      sizes="(max-width: 640px) 100vw, 420px"
                      className="h-auto w-full"
                    />
                    <figcaption className="border-t border-line bg-paper/60 px-3 py-2 text-[11px] leading-snug text-muted">
                      {asset.caption}
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          ) : (
            <div className="px-5 py-10 text-center sm:px-6">
              <div className="font-display text-[24px] text-ink/70">
                {project.name}
              </div>
              <p className="mx-auto mt-2 max-w-[42ch] text-[12.5px] leading-relaxed text-muted">
                UI capture pending. No screenshot of this project has been
                published yet, so nothing is mocked here.
              </p>
            </div>
          )}
        </section>

        {/* ---------------------------------------------------------- */}
        {/* 4. Highlights and features                                  */}
        {/* ---------------------------------------------------------- */}
        {project.highlights.length ? (
          <section className="mt-9 overflow-hidden rounded-[22px] border border-line bg-white/65 shadow-[0_1px_0_rgba(20,19,15,0.03)] sm:mt-12">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-4 sm:px-6">
              <div>
                <h2 className="font-display text-[22px] leading-none tracking-[-0.02em] text-ink">
                  Highlights
                </h2>
                <p className="mt-1.5 text-[12px] text-muted">
                  The parts of this build that carry the real engineering.
                </p>
              </div>
              <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
                content/projects/{project.id}.yaml
              </span>
            </div>

            <ul className="space-y-2.5 p-4 sm:p-5">
              {project.highlights.map((highlight) => (
                <li
                  key={highlight}
                  className="flex gap-2.5 text-[13.5px] leading-[1.6] text-ink-soft"
                >
                  <span className="mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
                  {highlight}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {project.features.length ? (
          <section className="mt-4 overflow-hidden rounded-[22px] border border-line bg-white/65 shadow-[0_1px_0_rgba(20,19,15,0.03)]">
            <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-4 sm:px-6">
              <div>
                <h2 className="font-display text-[22px] leading-none tracking-[-0.02em] text-ink">
                  Features
                </h2>
                <p className="mt-1.5 max-w-[52ch] text-[12px] text-muted">
                  Each feature points at the file it came from.
                </p>
              </div>
              <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
                evidence
              </span>
            </div>

            <ul className="space-y-3 p-4 sm:p-5">
              {project.features.map((feature) => (
                <li
                  key={feature.title}
                  className="rounded-xl border border-line bg-paper/55 p-4"
                >
                  <h3 className="text-[13.5px] font-medium leading-snug text-ink">
                    {feature.title}
                  </h3>
                  <p className="mt-2 text-[13px] leading-[1.62] text-ink-soft">
                    {feature.detail}
                  </p>
                  {feature.evidence ? (
                    <code className="mt-2.5 inline-block max-w-full break-all rounded border border-line bg-white/70 px-2 py-0.5 font-mono text-[10.5px] leading-relaxed text-muted">
                      {feature.evidence}
                    </code>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ---------------------------------------------------------- */}
        {/* 5. Architecture (only when a diagram exists)                */}
        {/* ---------------------------------------------------------- */}
        {architecture ? (
          <div className="mt-4 sm:mt-6">
            <ArchitectureDiagram architecture={architecture} />
          </div>
        ) : null}

        {/* ---------------------------------------------------------- */}
        {/* 6. Verified metrics                                         */}
        {/* ---------------------------------------------------------- */}
        {metricRows.length ? (
          <div className="mt-4 sm:mt-6">
            <MetricPanel metrics={metricRows} />
          </div>
        ) : null}

        {/* ---------------------------------------------------------- */}
        {/* 7. Caveats                                                  */}
        {/* ---------------------------------------------------------- */}
        {project.caveats.length ? (
          <section className="mt-4 rounded-[22px] border border-warn/25 bg-warn/5 p-5 sm:mt-6 sm:p-6">
            <h2 className="flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-[0.16em] text-warn">
              <AlertTriangle className="h-3.5 w-3.5" />
              Caveats
            </h2>
            <p className="mt-2.5 max-w-[62ch] text-[12.5px] leading-[1.6] text-muted">
              What this project does not do. These are stated here rather than
              buried, because a portfolio that only lists strengths is not
              reviewable.
            </p>
            <ul className="mt-3.5 space-y-2">
              {project.caveats.map((caveat) => (
                <li
                  key={caveat}
                  className="flex gap-2.5 text-[13px] leading-[1.6] text-ink-soft"
                >
                  <span className="mt-[9px] h-1 w-1 shrink-0 rounded-full bg-warn" />
                  {caveat}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/* ---------------------------------------------------------- */}
        {/* 8. Ask about this project                                   */}
        {/* ---------------------------------------------------------- */}
        <section className="mt-4 overflow-hidden rounded-[22px] border border-accent/25 bg-accent-soft/50 sm:mt-6">
          <div className="px-5 py-6 sm:px-6">
            <h2 className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-accent">
              Ask about this project
            </h2>
            <p className="mt-2.5 max-w-[54ch] text-[13.5px] leading-[1.62] text-ink-soft">
              The assistant answers from the same content layer this page is
              built from, and shows the source lines behind every answer.
            </p>
            <p className="mt-1.5 max-w-[54ch] text-[12.5px] leading-[1.6] text-muted">
              The question below opens the chat with it already typed into the
              composer. Nothing is sent until you press Enter, so you can
              reword it first.
            </p>

            <div className="mt-5 flex flex-wrap items-center gap-2">
              <Link
                href={`/?q=${encodeURIComponent(question)}`}
                className="group inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-2.5 text-[12.5px] text-paper transition-colors hover:bg-accent"
              >
                <MessageCircle className="h-3.5 w-3.5" />
                {question}
                <ArrowUpRight className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </Link>
              <Link
                href="/"
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/60 px-4 py-2.5 text-[12.5px] text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
              >
                Open the chat
              </Link>
            </div>
          </div>
        </section>

        <footer className="mt-10 border-t border-line pt-5 text-[11.5px] text-muted sm:mt-14">
          <p>
            Every number, path and caveat on this page comes from the audited
            content layer:{" "}
            <span className="font-mono text-[11px] text-ink-soft">
              content/projects/{project.id}.yaml
            </span>
            ,{" "}
            <span className="font-mono text-[11px] text-ink-soft">
              content/metrics.yaml
            </span>{" "}
            and{" "}
            <span className="font-mono text-[11px] text-ink-soft">
              content/claims.yaml
            </span>
            .
          </p>
        </footer>
      </div>
    </main>
  );
}
