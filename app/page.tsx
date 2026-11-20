import Link from "next/link";
import { ArrowUpRight, Mail, MapPin } from "lucide-react";

import { GitHubIcon, LinkedInIcon } from "@/components/icons/BrandIcons";
import { EducationTimeline } from "@/components/visuals/EducationTimeline";
import { SkillMap } from "@/components/visuals/SkillMap";
import { getFeaturedProjects, getProfile } from "@/lib/content/load";

export default function HomePage() {
  const profile = getProfile();
  const featured = getFeaturedProjects().slice(0, 3);
  const [firstName, ...surname] = profile.name.split(" ");

  return (
    <main className="paper-grain relative min-h-dvh bg-paper">
      <div className="pointer-events-none absolute inset-0 hero-grid" aria-hidden />
      <div className="relative mx-auto max-w-5xl px-5 sm:px-8">
        <header className="flex flex-wrap items-center justify-between gap-3 py-6">
          <Link href="/" className="inline-flex items-center gap-2.5 text-[13px] text-ink">
            <span aria-hidden className="grid size-9 place-items-center rounded-[11px] border border-line-strong/80 bg-white/70 font-display text-[15px] shadow-sm">
              KK
            </span>
            {profile.name}
          </Link>
          <span className="inline-flex items-center gap-1.5 text-[12px] text-muted">
            <MapPin className="size-3.5" aria-hidden /> {profile.location}
          </span>
        </header>

        <section className="mx-auto max-w-3xl pb-10 pt-12 text-center sm:pb-16 sm:pt-20">
          <p className="inline-flex items-center gap-2 rounded-full border border-line bg-white/60 px-3 py-1.5 text-[10.5px] font-medium uppercase tracking-[0.13em] text-muted">
            <span className="size-1.5 rounded-full bg-accent" aria-hidden />
            {profile.headline} · B.E. IT
          </p>
          <h1 className="mt-5 font-display text-[clamp(3.7rem,11vw,7.6rem)] leading-[0.9] tracking-[-0.035em] text-ink">
            {firstName} <em className="text-muted">{surname.join(" ")}</em>
          </h1>
          <p className="mx-auto mt-6 max-w-[34ch] text-[17px] leading-relaxed text-ink-soft sm:text-[19px]">
            I build AI automation, real-time voice agents, and backend systems.
          </p>
          <Link href="/projects" className="mt-7 inline-flex items-center gap-2 rounded-full bg-ink px-5 py-3 text-sm font-medium text-paper transition-colors hover:bg-accent">
            Browse projects <ArrowUpRight className="size-4" aria-hidden />
          </Link>
          <p className="mt-4 text-[12px] text-muted">{profile.availability.status}</p>
        </section>

        <nav aria-label="Featured projects" className="grid gap-3 sm:grid-cols-3">
          {featured.map((project) => (
            <Link key={project.id} href={"/projects/" + project.id} className="group flex items-start justify-between gap-3 rounded-2xl border border-line bg-white/65 p-4 transition-colors hover:border-line-strong">
              <div>
                <span className="font-display text-[23px] leading-tight text-ink">{project.name}</span>
                <p className="mt-1 text-[12px] leading-relaxed text-muted">{project.tagline}</p>
              </div>
              <ArrowUpRight className="mt-1 size-4 shrink-0 text-muted group-hover:text-accent" aria-hidden />
            </Link>
          ))}
        </nav>

        <section aria-labelledby="about" className="mx-auto mt-12 grid max-w-3xl gap-4 sm:mt-16">
          <h2 id="about" className="font-display text-[32px] leading-tight text-ink">About me</h2>
          <p className="max-w-[65ch] text-[15px] leading-relaxed text-ink-soft">{profile.summary}</p>
          {profile.experience.map((entry) => (
            <div key={entry.company + entry.dates} className="rounded-[22px] border border-line bg-white/65 px-5 py-4 sm:px-6">
              <h3 className="font-display text-[22px] leading-tight text-ink">{entry.role}</h3>
              <p className="mt-1 text-[13px] text-muted">{entry.company} · {entry.dates}</p>
            </div>
          ))}
          <EducationTimeline education={profile.education} />
          <SkillMap skills={profile.skills} />
        </section>

        <footer className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3 py-10 text-[12px] text-muted">
          <a className="inline-flex items-center gap-1.5 hover:text-accent" href={profile.links.github}>
            <GitHubIcon className="size-3.5" /> GitHub
          </a>
          <a className="inline-flex items-center gap-1.5 hover:text-accent" href={profile.links.linkedin}>
            <LinkedInIcon className="size-3.5" /> LinkedIn
          </a>
          <a className="inline-flex items-center gap-1.5 hover:text-accent" href={"mailto:" + profile.email}>
            <Mail className="size-3.5" aria-hidden /> Email
          </a>
        </footer>
      </div>
    </main>
  );
}
