"use client";

import Image from "next/image";
import { motion } from "motion/react";
import { AlertTriangle, ArrowUpRight, ExternalLink, Play } from "lucide-react";

import { GitHubIcon } from "@/components/icons/BrandIcons";

import type { Project, ProjectStatus } from "@/lib/content/schemas";
import { cn } from "@/lib/utils";

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

type ProjectShowcaseProps = {
  project: Project;
  onAsk?: (question: string) => void;
};

export function ProjectShowcase({ project, onAsk }: ProjectShowcaseProps) {
  const ready = project.assets.filter((asset) => asset.status === "ready");
  const cover =
    ready.find((asset) => asset.kind === "screenshot") ??
    ready.find((asset) => asset.kind === "photo") ??
    ready.find((asset) => asset.kind === "card") ??
    ready.find((asset) => asset.kind === "icon");
  const status = statusStyles[project.status];
  const isUiCapture = cover?.kind === "screenshot";

  return (
    <motion.article
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden rounded-[22px] border border-line bg-white/65 shadow-[0_1px_0_rgba(20,19,15,0.03)]"
    >
      <div className="relative aspect-[16/10] w-full overflow-hidden border-b border-line bg-paper-deep">
        {cover ? (
          isUiCapture ? (
            <Image
              src={cover.src}
              alt={cover.alt}
              width={1280}
              height={800}
              sizes="(max-width: 768px) 100vw, 720px"
              className="h-full w-full object-cover object-top"
              priority={false}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-[radial-gradient(circle_at_50%_35%,rgba(47,75,255,0.10),transparent_62%)]">
              <Image
                src={cover.src}
                alt={cover.alt}
                width={560}
                height={400}
                sizes="(max-width: 768px) 70vw, 420px"
                className="max-h-[62%] w-auto object-contain drop-shadow-sm"
              />
            </div>
          )
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-center">
            <div className="font-display text-[26px] text-ink/70">{project.name}</div>
            <div className="text-[11.5px] text-muted">UI capture pending</div>
          </div>
        )}

        <div className="absolute left-3 top-3 flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium backdrop-blur",
              status.className,
            )}
          >
            <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />
            {status.label}
          </span>
          {cover ? (
            <span className="rounded-full border border-line bg-paper/80 px-2.5 py-1 text-[10.5px] text-muted backdrop-blur">
              {cover.kind === "screenshot" ? "Verified screenshot" : "Real asset"}
            </span>
          ) : null}
        </div>
      </div>

      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-display text-[26px] leading-none tracking-[-0.02em] text-ink">
              {project.name}
            </h3>
            <p className="mt-1.5 text-[13px] text-muted">{project.tagline}</p>
          </div>
          <div className="flex items-center gap-2">
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
        </div>

        <p className="mt-4 max-w-[68ch] text-[14px] leading-[1.65] text-ink-soft">
          {project.summary}
        </p>

        <div className="mt-4 flex flex-wrap gap-1.5">
          {project.stack.slice(0, 7).map((item) => (
            <span
              key={item}
              className="rounded-full border border-line bg-paper/70 px-2.5 py-1 text-[11px] text-muted"
            >
              {item}
            </span>
          ))}
          {project.stack.length > 7 ? (
            <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 text-[11px] text-muted">
              +{project.stack.length - 7}
            </span>
          ) : null}
        </div>

        {project.metrics.length ? (
          <div className="mt-5 grid grid-cols-3 divide-x divide-line rounded-xl border border-line bg-paper/55">
            {project.metrics.slice(0, 3).map((metric) => (
              <div key={metric.label} className="px-3 py-3 sm:px-4">
                <div className="font-display text-[20px] leading-none tracking-[-0.01em] text-ink">
                  {metric.value}
                </div>
                <div className="mt-1.5 text-[10.5px] leading-tight text-muted">
                  {metric.label}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {project.caveats.length ? (
          <div className="mt-4 flex items-start gap-2 rounded-xl border border-warn/20 bg-warn/5 px-3.5 py-3">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" />
            <p className="text-[12px] leading-[1.55] text-warn/90">
              {project.caveats[0]}
            </p>
          </div>
        ) : null}

        {onAsk ? (
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-line pt-4">
            <button
              type="button"
              onClick={() => onAsk(`How does ${project.name} work?`)}
              className="group inline-flex items-center gap-1.5 rounded-full bg-ink px-3.5 py-2 text-[12px] text-paper transition-colors hover:bg-accent"
            >
              <Play className="h-3 w-3" />
              How it works
              <ArrowUpRight className="h-3 w-3 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
            </button>
            <button
              type="button"
              onClick={() => onAsk(`Show me the ${project.name} architecture`)}
              className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper/70 px-3.5 py-2 text-[12px] text-ink-soft transition-colors hover:border-accent/35 hover:bg-accent-soft/50 hover:text-ink"
            >
              Architecture
            </button>
            <span className="ml-auto hidden text-[10.5px] text-muted sm:block">
              {project.role} · {project.timeline}
            </span>
          </div>
        ) : null}
      </div>
    </motion.article>
  );
}
