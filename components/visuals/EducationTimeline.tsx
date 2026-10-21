"use client";

import { motion, useReducedMotion } from "motion/react";
import { GraduationCap, MapPin } from "lucide-react";

import type { Profile } from "@/lib/content/schemas";

type EducationEntry = Profile["education"][number];

type EducationTimelineProps = {
  education: EducationEntry[];
};

type SplitGrade = {
  value: string;
  suffix: string;
  label: string;
};

/**
 * Turns the recorded grade into a number worth showing large.
 *
 * "CGPA 7.51 / 10.0" becomes 7.51 with a "/10.0" suffix, "82.33%" becomes
 * 82.33 with a "%" suffix. Anything unrecognised is shown verbatim rather
 * than guessed at.
 */
function splitGrade(grade: string): SplitGrade {
  const trimmed = (grade ?? "").trim();

  if (!trimmed) {
    return { value: "not recorded", suffix: "", label: "Grade" };
  }

  const cgpa = trimmed.match(/^cgpa\s*([\d.]+)\s*(\/\s*[\d.]+)?$/i);
  if (cgpa) {
    return {
      value: cgpa[1] ?? trimmed,
      suffix: cgpa[2] ? ` ${cgpa[2].replace(/\s+/g, "")}` : "",
      label: "CGPA",
    };
  }

  const percent = trimmed.match(/^([\d.]+)\s*(%?)$/);
  if (percent) {
    return {
      value: percent[1] ?? trimmed,
      suffix: percent[2] ?? "",
      label: "Result",
    };
  }

  return { value: trimmed, suffix: "", label: "Grade" };
}

export function EducationTimeline({ education }: EducationTimelineProps) {
  const entries = education ?? [];
  const reduceMotion = useReducedMotion();

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
            Education
          </h3>
          <p className="mt-1.5 text-[12px] text-muted">
            Degree, then board results. The grade is the headline; the rest is
            context.
          </p>
        </div>
        <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
          profile.yaml
        </span>
      </div>

      {entries.length ? (
        <div className="relative px-5 py-6 pl-9 sm:px-6 sm:pl-10">
          <motion.div
            initial={{ scaleY: 0 }}
            animate={{ scaleY: 1 }}
            transition={{
              duration: reduceMotion ? 0.01 : 0.7,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="absolute bottom-8 left-[17px] top-7 w-[2px] origin-top rounded-full bg-line-strong sm:left-[21px]"
          />

          {entries.map((entry, index) => {
            const grade = splitGrade(entry.grade ?? "");

            return (
              <motion.div
                key={`${entry.institution}-${entry.credential}-${index}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: reduceMotion ? 0.01 : 0.32,
                  delay: reduceMotion ? 0 : 0.12 + index * 0.05,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="relative pb-7 last:pb-0"
              >
                <span className="absolute -left-[31px] top-0 flex h-[22px] w-[22px] items-center justify-center rounded-full border border-line-strong bg-paper font-mono text-[9.5px] text-muted sm:-left-[35px]">
                  {String(index + 1).padStart(2, "0")}
                </span>

                <div className="rounded-xl border border-line bg-paper/55 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted">
                        <GraduationCap className="h-3.5 w-3.5" />
                        {entry.credential}
                      </div>
                      <h4 className="mt-1.5 font-display text-[19px] leading-tight tracking-[-0.01em] text-ink">
                        {entry.institution}
                      </h4>
                      <p className="mt-1 text-[12.5px] text-muted">
                        {entry.dates}
                        {entry.board ? ` · ${entry.board}` : ""}
                      </p>
                      {entry.location ? (
                        <p className="mt-1 inline-flex items-center gap-1.5 text-[11.5px] text-muted">
                          <MapPin className="h-3 w-3" />
                          {entry.location}
                        </p>
                      ) : null}
                    </div>

                    <div className="shrink-0 rounded-xl border border-line bg-white/70 px-3.5 py-2.5 text-right">
                      <div className="text-[9.5px] font-medium uppercase tracking-[0.14em] text-muted">
                        {grade.label}
                      </div>
                      <div className="mt-1 font-display text-[26px] leading-none tracking-[-0.02em] text-ink">
                        {grade.value}
                        {grade.suffix ? (
                          <span className="ml-1 font-sans text-[12px] tracking-normal text-muted">
                            {grade.suffix}
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      ) : (
        <div className="px-5 py-8 text-center sm:px-6">
          <GraduationCap className="mx-auto h-5 w-5 text-line-strong" />
          <p className="mt-2.5 text-[13px] font-medium text-ink">
            No education entries are recorded
          </p>
          <p className="mx-auto mt-1 max-w-[44ch] text-[12.5px] leading-relaxed text-muted">
            profile.yaml has no education block yet. Nothing is filled in here,
            because a placeholder would be a guess.
          </p>
        </div>
      )}
    </motion.section>
  );
}
