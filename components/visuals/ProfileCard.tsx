"use client";

import { motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, Building2, Mail, MapPin } from "lucide-react";

import { GitHubIcon, LinkedInIcon } from "@/components/icons/BrandIcons";

import type { Profile, Project } from "@/lib/content/schemas";

type ProfileCardProps = {
  profile: Profile;
  featured: Project[];
  onAsk?: (question: string) => void;
};

export function ProfileCard({ profile, featured, onAsk }: ProfileCardProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: reduceMotion ? 0.01 : 0.35,
        ease: [0.22, 1, 0.36, 1],
      }}
      className="overflow-hidden rounded-[22px] border border-line bg-white/65 shadow-[0_1px_0_rgba(20,19,15,0.03)] backdrop-blur-sm"
    >
      <div className="flex flex-col gap-5 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
        <div className="flex items-start gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border border-line-strong/80 bg-paper font-display text-[20px] shadow-sm">
            KK
          </div>
          <div>
            <h3 className="font-display text-[24px] leading-none tracking-[-0.02em] text-ink">
              {profile.name}
            </h3>
            <p className="mt-1.5 text-[13px] text-muted">
              {profile.headline} · {profile.location}
            </p>
            <p className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] text-live">
              <span className="h-1.5 w-1.5 rounded-full bg-live" />
              {profile.availability.status}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 sm:pt-1">
          <a
            href={profile.links.github}
            target="_blank"
            rel="noreferrer"
            aria-label="GitHub"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-paper/70 text-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            <GitHubIcon className="h-4 w-4" />
          </a>
          <a
            href={profile.links.linkedin}
            target="_blank"
            rel="noreferrer"
            aria-label="LinkedIn"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-paper/70 text-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            <LinkedInIcon className="h-4 w-4" />
          </a>
          <a
            href={`mailto:${profile.email}`}
            aria-label="Email"
            className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-paper/70 text-muted transition-colors hover:border-line-strong hover:text-ink"
          >
            <Mail className="h-4 w-4" />
          </a>
        </div>
      </div>

      <div className="border-t border-line px-5 py-4 sm:px-6">
        <p className="max-w-[62ch] text-[14px] leading-[1.65] text-ink-soft">
          {profile.summary}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line bg-paper/45 px-5 py-3.5 text-[11.5px] text-muted sm:px-6">
        <span className="inline-flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5" />
          {profile.location}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Building2 className="h-3.5 w-3.5" />
          B.E. IT · 2022 - 2026
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          {profile.availability.roles.slice(0, 3).join(" · ")}
        </span>
      </div>

      {featured.length ? (
        <div className="border-t border-line px-5 py-4 sm:px-6">
          <p className="mb-2.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
            Featured work
          </p>
          <div className="flex flex-wrap gap-2">
            {featured.slice(0, 4).map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => onAsk?.(`Tell me about ${project.name}`)}
                className="group inline-flex items-center gap-1.5 rounded-full border border-line bg-paper/70 px-3 py-1.5 text-[12px] text-ink-soft transition-colors hover:border-accent/35 hover:bg-accent-soft/50 hover:text-ink"
              >
                {project.name}
                <ArrowUpRight className="h-3 w-3 text-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </motion.div>
  );
}
