"use client";

import { motion, useReducedMotion } from "motion/react";
import { ExternalLink, Mail, MapPin, Phone } from "lucide-react";

import { GitHubIcon, LinkedInIcon } from "@/components/icons/BrandIcons";

import type { Profile } from "@/lib/content/schemas";
import { cn } from "@/lib/utils";

type ContactCardProps = {
  profile: Profile;
};

/** Strips the protocol so the visible text is a plain, readable link. */
function displayUrl(url: string) {
  return (url ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function ContactCard({ profile }: ContactCardProps) {
  const { links, availability } = profile;
  const email = profile.email?.trim() ?? "";
  const phone = profile.phone?.trim() ?? "";
  const github = links?.github?.trim() ?? "";
  const linkedin = links?.linkedin?.trim() ?? "";
  const location = profile.location?.trim() ?? "";
  const hasEmail = email.length > 0;
  const hasPhone = phone.length > 0;
  const hasGithub = github.length > 0;
  const hasLinkedin = linkedin.length > 0;
  const hasLocation = location.length > 0;
  const hasAnything =
    hasEmail ||
    hasPhone ||
    hasGithub ||
    hasLinkedin ||
    hasLocation ||
    Boolean(availability?.status) ||
    Boolean(availability?.roles?.length);
  const reduceMotion = useReducedMotion();

  if (!hasAnything) {
    return (
      <motion.section
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{
          duration: reduceMotion ? 0.01 : 0.4,
          ease: [0.22, 1, 0.36, 1],
        }}
        className="overflow-hidden rounded-[22px] border border-line bg-white/65 shadow-[0_1px_0_rgba(20,19,15,0.03)]"
      >
        <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-4 sm:px-6">
          <div>
            <h3 className="font-display text-[22px] leading-none tracking-[-0.02em] text-ink">
              Get in touch
            </h3>
            <p className="mt-1.5 text-[12px] text-muted">
              No contact details are recorded in the profile.
            </p>
          </div>
          <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
            contact
          </span>
        </div>
        <div className="px-5 py-8 text-center sm:px-6">
          <Mail className="mx-auto h-5 w-5 text-line-strong" />
          <p className="mt-2.5 text-[13px] font-medium text-ink">
            No contact details are recorded
          </p>
          <p className="mx-auto mt-1 max-w-[44ch] text-[12.5px] leading-relaxed text-muted">
            profile.yaml has no email, phone, or links. Nothing is guessed here
            rather than pointing a reader at an address that may not exist.
          </p>
        </div>
      </motion.section>
    );
  }

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: reduceMotion ? 0.01 : 0.4,
        ease: [0.22, 1, 0.36, 1],
      }}
      className="overflow-hidden rounded-[22px] border border-line bg-white/65 shadow-[0_1px_0_rgba(20,19,15,0.03)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-4 sm:px-6">
        <div>
          <h3 className="font-display text-[22px] leading-none tracking-[-0.02em] text-ink">
            Get in touch
          </h3>
          <p className="mt-1.5 text-[12px] text-muted">
            {profile.name} · {profile.headline} · {profile.location}
          </p>
        </div>
        <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
          contact
        </span>
      </div>

      <div className="p-5 sm:p-6">
        <div className="flex items-center gap-2 rounded-xl border border-live/20 bg-live/5 px-3.5 py-2.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-live" />
          <span className="text-[12.5px] font-medium text-live">
            {availability.status}
          </span>
        </div>

        <ul className="mt-4 space-y-2">
          {hasEmail ? (
            <li>
              <a
                href={`mailto:${email}`}
                className="group flex items-center gap-3 rounded-xl border border-line bg-paper/55 px-3.5 py-3 transition-colors hover:border-accent/35 hover:bg-accent-soft/40"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-white/70 text-muted transition-colors group-hover:text-accent">
                  <Mail className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
                    Email
                  </span>
                  <span className="block truncate font-mono text-[12.5px] text-ink-soft">
                    {email}
                  </span>
                </span>
              </a>
            </li>
          ) : null}

          {hasPhone ? (
            <li>
              <a
                href={`tel:${phone.replace(/\s+/g, "")}`}
                className="group flex items-center gap-3 rounded-xl border border-line bg-paper/55 px-3.5 py-3 transition-colors hover:border-accent/35 hover:bg-accent-soft/40"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-white/70 text-muted transition-colors group-hover:text-accent">
                  <Phone className="h-4 w-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
                    Phone
                  </span>
                  <span className="block truncate font-mono text-[12.5px] text-ink-soft">
                    {phone}
                  </span>
                </span>
              </a>
            </li>
          ) : null}

          {hasGithub ? (
            <li>
              <a
                href={github}
                target="_blank"
                rel="noreferrer"
                className="group flex items-center gap-3 rounded-xl border border-line bg-paper/55 px-3.5 py-3 transition-colors hover:border-accent/35 hover:bg-accent-soft/40"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-white/70 text-muted transition-colors group-hover:text-accent">
                  <GitHubIcon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
                    GitHub
                  </span>
                  <span className="block truncate font-mono text-[12.5px] text-ink-soft">
                    {displayUrl(github)}
                  </span>
                </span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted" />
              </a>
            </li>
          ) : null}

          {hasLinkedin ? (
            <li>
              <a
                href={linkedin}
                target="_blank"
                rel="noreferrer"
                className="group flex items-center gap-3 rounded-xl border border-line bg-paper/55 px-3.5 py-3 transition-colors hover:border-accent/35 hover:bg-accent-soft/40"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-white/70 text-muted transition-colors group-hover:text-accent">
                  <LinkedInIcon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
                    LinkedIn
                  </span>
                  <span className="block truncate font-mono text-[12.5px] text-ink-soft">
                    {displayUrl(linkedin)}
                  </span>
                </span>
                <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted" />
              </a>
            </li>
          ) : null}

          {hasLocation ? (
            <li className="flex items-center gap-3 rounded-xl border border-line bg-paper/55 px-3.5 py-3">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line bg-white/70 text-muted">
                <MapPin className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
                  Based in
                </span>
                <span className="block truncate text-[12.5px] text-ink-soft">
                  {location}
                </span>
              </span>
            </li>
          ) : null}
        </ul>

        {availability.roles?.length ? (
          <div className="mt-4 border-t border-line pt-4">
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
              Open to
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {availability.roles.map((role) => (
                <span
                  key={role}
                  className="rounded-full border border-line bg-paper/70 px-2.5 py-1 text-[11.5px] text-ink-soft"
                >
                  {role}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {availability.locations?.length ? (
          <div className="mt-3.5">
            <p className="text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
              Locations
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {availability.locations.map((location) => (
                <span
                  key={location}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-[11.5px] text-muted",
                    "border-line bg-white/50",
                  )}
                >
                  {location}
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </motion.section>
  );
}
