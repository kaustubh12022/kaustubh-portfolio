import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { getProjects } from "@/lib/content/load";
import type { ProjectStatus } from "@/lib/content/schemas";
import { cn } from "@/lib/utils";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

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

export const metadata: Metadata = {
  title: "Projects",
  description:
    "Seven audited projects with the real repository, the verified numbers, and the caveats that come with them.",
  alternates: {
    canonical: "/projects",
  },
  openGraph: {
    type: "website",
    title: "Projects · Kaustubh Kale",
    description:
      "Seven audited projects with the real repository, the verified numbers, and the caveats that come with them.",
    url: `${siteUrl}/projects`,
    siteName: "Kaustubh Kale",
  },
  twitter: {
    card: "summary_large_image",
    title: "Projects · Kaustubh Kale",
    description:
      "Seven audited projects with the real repository, the verified numbers, and the caveats that come with them.",
  },
};

export default function ProjectsPage() {
  const projects = getProjects();

  return (
    <main className="paper-grain relative min-h-dvh bg-paper">
      <div className="pointer-events-none absolute inset-0 hero-grid" aria-hidden />

      <div className="relative mx-auto w-full max-w-5xl px-5 py-7 sm:px-8 sm:py-12">
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
            href="/"
            className="rounded-full border border-line bg-white/50 px-3 py-1.5 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            Ask the portfolio
          </Link>
        </nav>

        <header className="mt-9 sm:mt-14">
          <div className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted">
            {projects.length} projects
          </div>
          <h1 className="mt-3 font-display text-[clamp(2.8rem,8vw,4.8rem)] leading-[0.92] tracking-[-0.035em] text-ink">
            The work, audited
          </h1>
          <p className="mt-4 max-w-[56ch] text-[15px] leading-[1.65] text-ink-soft">
            Each entry links to a static page with the real screenshots, the
            verified numbers, the source paths, and the caveats. Nothing here
            is a mock.
          </p>
        </header>

        <ul className="mt-9 border-t border-line sm:mt-12">
          {projects.map((project, index) => {
            const status = statusStyles[project.status];

            return (
              <li key={project.id} className="border-b border-line">
                <Link
                  href={`/projects/${project.id}`}
                  className="group flex flex-col gap-3 py-5 transition-colors sm:flex-row sm:items-start sm:gap-6 sm:py-6"
                >
                  <span className="w-8 shrink-0 pt-1 font-mono text-[11px] text-muted">
                    {String(index + 1).padStart(2, "0")}
                  </span>

                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-display text-[24px] leading-none tracking-[-0.02em] text-ink sm:text-[27px]">
                        {project.name}
                      </span>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium",
                          status.className,
                        )}
                      >
                        <span
                          className={cn("h-1.5 w-1.5 rounded-full", status.dot)}
                        />
                        {status.label}
                      </span>
                    </span>

                    <span className="mt-2 block text-[13.5px] leading-[1.6] text-muted">
                      {project.tagline}
                    </span>

                    <span className="mt-3 flex flex-wrap gap-1.5">
                      {project.stack.map((item) => (
                        <span
                          key={item}
                          className="rounded-full border border-line bg-paper/70 px-2.5 py-1 text-[11px] text-muted"
                        >
                          {item}
                        </span>
                      ))}
                    </span>
                  </span>

                  <ArrowUpRight className="hidden h-4 w-4 shrink-0 text-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:text-ink sm:block" />
                </Link>
              </li>
            );
          })}
        </ul>

        <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 text-[11.5px] text-muted">
          <span>
            Every project above is described by the same audited content layer
            the chat answers from.
          </span>
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 text-ink-soft transition-colors hover:text-accent"
          >
            Ask a question instead
            <ArrowUpRight className="h-3 w-3" />
          </Link>
        </footer>
      </div>
    </main>
  );
}
