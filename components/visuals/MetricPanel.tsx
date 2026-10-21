"use client";

import { motion, useReducedMotion } from "motion/react";
import { ChevronDown, ClipboardCheck } from "lucide-react";

import type { MetricRow } from "@/lib/types/chat";
import { cn } from "@/lib/utils";

type MetricPanelProps = {
  metrics: MetricRow[];
};

export function MetricPanel({ metrics }: MetricPanelProps) {
  const rows = metrics ?? [];
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
            Verified metrics
          </h3>
          <p className="mt-1.5 text-[12px] text-muted">
            Every number carries the method and the source it came from. Open a
            card to see how it was measured.
          </p>
        </div>
        <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
          metrics.yaml
        </span>
      </div>

      {rows.length ? (
        <div className="grid gap-3 p-5 sm:grid-cols-2 sm:p-6">
          {rows.map((metric, index) => (
            <motion.div
              key={`${metric.label}-${metric.source}-${index}`}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: reduceMotion ? 0.01 : 0.3,
                delay: reduceMotion ? 0 : index * 0.05,
                ease: [0.22, 1, 0.36, 1],
              }}
              className="rounded-xl border border-line bg-paper/55 p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-display text-[34px] leading-none tracking-[-0.02em] text-ink">
                    {metric.value}
                    {metric.unit ? (
                      <span className="ml-1.5 font-sans text-[12.5px] tracking-normal text-muted">
                        {metric.unit}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-2 text-[12.5px] leading-snug text-ink-soft">
                    {metric.label}
                  </p>
                </div>
                <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0 text-live" />
              </div>

              <details className="group mt-3">
                <summary className="flex list-none cursor-pointer items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted transition-colors hover:text-ink">
                  <ChevronDown className="h-3 w-3 transition-transform duration-200 group-open:rotate-180" />
                  How this was measured
                </summary>

                <div className="mt-2 rounded-lg border border-line bg-white/70 p-3">
                  <p className="text-[11.5px] leading-[1.55] text-ink-soft">
                    {metric.method || "No method was recorded."}
                  </p>
                  <dl className="mt-2.5 space-y-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                        source
                      </dt>
                      <dd className="min-w-0 break-all font-mono text-[10.5px] text-ink-soft">
                        {metric.source || "not recorded"}
                      </dd>
                    </div>
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-muted">
                        verified
                      </dt>
                      <dd
                        className={cn(
                          "font-mono text-[10.5px] text-ink-soft",
                          !metric.verifiedAt && "text-muted",
                        )}
                      >
                        {metric.verifiedAt || "not recorded"}
                      </dd>
                    </div>
                  </dl>
                </div>
              </details>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="px-5 py-8 text-center sm:px-6">
          <ClipboardCheck className="mx-auto h-5 w-5 text-line-strong" />
          <p className="mt-2.5 text-[13px] font-medium text-ink">
            No verified metric is attached to this answer
          </p>
          <p className="mx-auto mt-1 max-w-[46ch] text-[12.5px] leading-relaxed text-muted">
            metrics.yaml holds the recorded numbers with their method and
            source. Nothing is shown here rather than a figure with no
            provenance.
          </p>
        </div>
      )}
    </motion.section>
  );
}
