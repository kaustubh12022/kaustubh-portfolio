"use client";

import { motion, useReducedMotion } from "motion/react";
import { ChevronRight, Info } from "lucide-react";

import type { Architecture } from "@/lib/content/schemas";
import { cn } from "@/lib/utils";

const toneStyles = {
  ink: "border-line-strong/80 bg-white/80 text-ink",
  accent: "border-accent/30 bg-accent-soft/60 text-ink",
  muted: "border-line bg-paper-deep/70 text-ink-soft",
  warn: "border-warn/25 bg-warn/5 text-ink",
} as const;

type ArchitectureDiagramProps = {
  architecture: Architecture;
};

export function ArchitectureDiagram({ architecture }: ArchitectureDiagramProps) {
  const reduceMotion = useReducedMotion();

  const derivedColumns =
    architecture.columns ??
    Array.from(new Set(architecture.nodes.map((node) => node.column ?? 0)))
      .sort((a, b) => a - b)
      .map((column) => ({ id: String(column), label: `Stage ${column + 1}` }));

  function columnIndex(nodeId: string) {
    const node = architecture.nodes.find((item) => item.id === nodeId);
    return node?.column ?? 0;
  }

  function edgeLabels(fromColumn: number, toColumn: number) {
    return architecture.edges
      .filter(
        (edge) =>
          columnIndex(edge.from) === fromColumn &&
          columnIndex(edge.to) === toColumn &&
          edge.label,
      )
      .map((edge) => edge.label);
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
            {architecture.title}
          </h3>
          {architecture.subtitle ? (
            <p className="mt-1.5 text-[12px] text-muted">{architecture.subtitle}</p>
          ) : null}
        </div>
        <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
          architecture
        </span>
      </div>

      {/*
        The diagram is wider than a phone, so this region scrolls sideways.
        A scroll container that cannot be focused is unreachable for anyone
        who navigates with a keyboard, so it carries a role, a label and a
        tab stop.
      */}
      <div
        className="thin-scrollbar overflow-x-auto px-5 py-6 sm:px-6"
        tabIndex={0}
        role="region"
        aria-label={`${architecture.title} - scrollable architecture diagram`}
      >
        <div className="flex min-w-[720px] items-stretch">
          {derivedColumns.map((column, columnIndexValue) => {
            const nodes = architecture.nodes.filter(
              (node) => (node.column ?? 0) === columnIndexValue,
            );
            const labels = edgeLabels(columnIndexValue, columnIndexValue + 1);

            return (
              <div key={column.id} className="flex flex-1 items-stretch">
                <div className="flex flex-1 flex-col">
                  <div className="mb-3 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
                    {column.label}
                  </div>
                  <div className="flex flex-1 flex-col gap-3">
                    {nodes.map((node, index) => (
                      <motion.div
                        key={node.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                          duration: reduceMotion ? 0.01 : 0.32,
                          delay: reduceMotion ? 0 : index * 0.05,
                          ease: [0.22, 1, 0.36, 1],
                        }}
                        className={cn(
                          "rounded-xl border px-3.5 py-3 shadow-[0_1px_0_rgba(20,19,15,0.02)]",
                          toneStyles[node.tone ?? "ink"],
                        )}
                      >
                        <div className="text-[13px] font-medium leading-tight">
                          {node.label}
                        </div>
                        {node.detail ? (
                          <div className="mt-1 text-[11px] leading-snug text-muted">
                            {node.detail}
                          </div>
                        ) : null}
                      </motion.div>
                    ))}
                  </div>
                </div>

                {columnIndexValue < derivedColumns.length - 1 ? (
                  <div
                    className="flex w-10 shrink-0 items-center justify-center px-1"
                    title={labels.length ? labels.join(" · ") : undefined}
                  >
                    <div className="flex items-center text-line-strong">
                      <span className="h-px w-5 bg-line-strong" />
                      <ChevronRight className="h-3.5 w-3.5" />
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <p className="px-5 pb-1 text-[10px] text-muted sm:hidden">
        Scroll to see all stages →
      </p>

      {architecture.notes.length ? (
        <div className="border-t border-line bg-paper/45 px-5 py-4 sm:px-6">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
            <Info className="h-3 w-3" />
            Notes
          </div>
          <ul className="space-y-1.5">
            {architecture.notes.map((note) => (
              <li key={note} className="flex gap-2 text-[12px] leading-[1.55] text-ink-soft">
                <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-line-strong" />
                {note}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </motion.section>
  );
}
