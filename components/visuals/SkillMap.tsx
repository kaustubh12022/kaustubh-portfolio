"use client";

import { motion } from "motion/react";
import { BookOpen, Briefcase, CheckCircle2, Hammer } from "lucide-react";
import type { ReactNode } from "react";

import type { Profile } from "@/lib/content/schemas";

type SkillMapProps = {
  profile: Profile;
};

export function SkillMap({ profile }: SkillMapProps) {
  const shippedGroups = Object.entries(profile.skills.shipped);

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden rounded-[22px] border border-line bg-white/65 shadow-[0_1px_0_rgba(20,19,15,0.03)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-5 py-4 sm:px-6">
        <div>
          <h3 className="font-display text-[22px] leading-none tracking-[-0.02em] text-ink">
            Skills, split by evidence
          </h3>
          <p className="mt-1.5 text-[12px] text-muted">
            No proficiency bars. The category tells you where the skill comes from.
          </p>
        </div>
        <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
          profile.yaml
        </span>
      </div>

      <div className="space-y-5 p-5 sm:p-6">
        <div>
          <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-live">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Shipped in code
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {shippedGroups.map(([group, items]) => (
              <div
                key={group}
                className="rounded-xl border border-line bg-paper/55 p-3.5"
              >
                <div className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted">
                  {group}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {items.map((item) => (
                    <span
                      key={item}
                      className="rounded-full border border-live/20 bg-live/5 px-2.5 py-1 text-[11.5px] text-ink-soft"
                    >
                      {item}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <SkillRow
            icon={<Briefcase className="h-3.5 w-3.5" />}
            label="Internship"
            items={profile.skills.internship}
            tone="muted"
          />
          <SkillRow
            icon={<BookOpen className="h-3.5 w-3.5" />}
            label="Coursework"
            items={profile.skills.coursework}
            tone="muted"
          />
          <SkillRow
            icon={<Hammer className="h-3.5 w-3.5" />}
            label="Currently building"
            items={profile.skills.building}
            tone="accent"
          />
        </div>
      </div>
    </motion.section>
  );
}

function SkillRow({
  icon,
  label,
  items,
  tone,
}: {
  icon: ReactNode;
  label: string;
  items: string[];
  tone: "muted" | "accent";
}) {
  return (
    <div className="rounded-xl border border-line bg-paper/55 p-3.5">
      <div
        className={
          tone === "accent"
            ? "mb-2 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-accent"
            : "mb-2 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.12em] text-muted"
        }
      >
        {icon}
        {label}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="rounded-full border border-line bg-white/60 px-2.5 py-1 text-[11.5px] text-ink-soft"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}
