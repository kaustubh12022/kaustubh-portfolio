"use client";

import { motion, useReducedMotion } from "motion/react";
import { AlertTriangle, GitCompare } from "lucide-react";

import type { ComparisonRow } from "@/lib/types/chat";
import { cn } from "@/lib/utils";

type ComparisonCardsProps = {
  projects: ComparisonRow[];
  dimension?: string;
};

const statusStyles: Record<string, { label: string; className: string; dot: string }> = {
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

const fallbackStatus = {
  label: "Status not recorded",
  className: "border-line bg-paper-deep text-muted",
  dot: "bg-muted",
};
function countValues<T extends string>(values: T[]) {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

export function ComparisonCards({ projects, dimension }: ComparisonCardsProps) {
  const rows = projects ?? [];

  const stackCounts = countValues(rows.flatMap((row) => row.stack ?? []));
  const metricLabelCounts = countValues(
    rows.flatMap((row) => (row.metrics ?? []).map((metric) => metric.label)),
  );

  const gridClass =
    {
      2: "sm:grid-cols-2 xl:grid-cols-2",
      3: "sm:grid-cols-2 xl:grid-cols-3",
      4: "sm:grid-cols-2 xl:grid-cols-4",
    }[Math.min(rows.length, 4)] ?? "sm:grid-cols-2";

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
            {dimension ? `Compared on ${dimension}` : "Side by side"}
          </h3>
          <p className="mt-1.5 text-[12px] text-muted">
            The accent dot marks what only that project has. The shared parts
            are the boring part.
          </p>
        </div>
        <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
          comparison
        </span>
      </div>

      {rows.length ? (
        <>
          {/*
            On a phone the cards sit in a horizontal scroller. A scroll
            container that cannot be focused is unreachable for anyone who
            navigates with a keyboard, so it carries a role, a label and a
            tab stop.
          */}
          <div
            className={cn(
              "thin-scrollbar flex gap-3 overflow-x-auto p-5 pb-4 sm:grid sm:gap-3 sm:overflow-x-visible sm:p-6",
              gridClass,
            )}
            tabIndex={0}
            role="region"
            aria-label={
              dimension
                ? `Project comparison on ${dimension} - scrollable`
                : "Project comparison - scrollable"
            }
          >
            {rows.map((row, index) => {
              const status = row.status
                ? (statusStyles[row.status] ?? fallbackStatus)
                : fallbackStatus;

              return (
                <motion.article
                  key={row.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: reduceMotion ? 0.01 : 0.3,
                    delay: reduceMotion ? 0 : index * 0.05,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  className="w-[262px] shrink-0 rounded-xl border border-line bg-paper/55 p-4 sm:w-auto sm:shrink"
                >
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="font-display text-[18px] leading-tight tracking-[-0.01em] text-ink">
                      {row.name}
                    </h4>
                    {status ? (
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium",
                          status.className,
                        )}
                      >
                        <span
                          className={cn("h-1.5 w-1.5 rounded-full", status.dot)}
                        />
                        {status.label}
                      </span>
                    ) : null}
                  </div>

                  {row.tagline ? (
                    <p className="mt-1.5 text-[12px] leading-snug text-muted">
                      {row.tagline}
                    </p>
                  ) : null}

                  {row.summary ? (
                    <p className="mt-3 line-clamp-3 text-[12.5px] leading-[1.6] text-ink-soft">
                      {row.summary}
                    </p>
                  ) : null}

                  {row.stack?.length ? (
                    <div className="mt-3.5">
                      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
                        Stack
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {row.stack.map((item) => {
                          const unique = (stackCounts.get(item) ?? 0) === 1;
                          return (
                            <span
                              key={item}
                              title={
                                unique
                                  ? `Only ${row.name} lists ${item}`
                                  : undefined
                              }
                              className={cn(
                                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]",
                                unique
                                  ? "border-accent/30 bg-accent-soft/60 text-ink"
                                  : "border-line bg-white/60 text-muted",
                              )}
                            >
                              {unique ? (
                                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                              ) : null}
                              {item}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-3.5 text-[11.5px] text-muted">
                      Stack not recorded
                    </p>
                  )}

                  {row.metrics?.length ? (
                    <div className="mt-3.5">
                      <div className="mb-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted">
                        Metrics
                      </div>
                      <ul className="space-y-1.5">
                        {row.metrics.map((metric) => {
                          const unique =
                            (metricLabelCounts.get(metric.label) ?? 0) === 1;
                          return (
                            <li
                              key={metric.label}
                              className="flex items-baseline justify-between gap-2"
                            >
                              <span className="min-w-0 truncate text-[11.5px] text-muted">
                                {metric.label}
                              </span>
                              <span className="flex shrink-0 items-baseline gap-1.5">
                                <span className="font-display text-[15px] leading-none text-ink">
                                  {metric.value}
                                </span>
                                {unique ? (
                                  <span
                                    className="h-1.5 w-1.5 rounded-full bg-accent"
                                    title={`Only ${row.name} records this metric`}
                                  />
                                ) : null}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ) : (
                    <p className="mt-3.5 text-[11.5px] text-muted">
                      Metrics not recorded
                    </p>
                  )}

                  {row.caveats?.length ? (
                    <div className="mt-3.5 space-y-1.5 rounded-xl border border-warn/20 bg-warn/5 px-3 py-2.5">
                      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-warn">
                        <AlertTriangle className="h-3 w-3" />
                        Caveats
                      </div>
                      <ul className="space-y-1">
                        {row.caveats.map((caveat) => (
                          <li
                            key={caveat}
                            className="text-[11.5px] leading-snug text-warn/90"
                          >
                            {caveat}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : (
                    <p className="mt-3.5 text-[11.5px] text-muted">
                      No caveats recorded
                    </p>
                  )}
                </motion.article>
              );
            })}
          </div>

          <p className="px-5 pb-4 text-[10px] text-muted sm:hidden">
            Scroll sideways to see every project →
          </p>
        </>
      ) : (
        <div className="px-5 py-8 text-center sm:px-6">
          <GitCompare className="mx-auto h-5 w-5 text-line-strong" />
          <p className="mt-2.5 text-[13px] font-medium text-ink">
            There is nothing to compare yet
          </p>
          <p className="mx-auto mt-1 max-w-[44ch] text-[12.5px] leading-relaxed text-muted">
            None of the requested projects are in the verified project index, so
            no columns are drawn.
          </p>
        </div>
      )}
    </motion.section>
  );
}
