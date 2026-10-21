"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, Info } from "lucide-react";
import { useRef, useState } from "react";

import type { Architecture } from "@/lib/content/schemas";
import { cn } from "@/lib/utils";

type ArchitectureNode = Architecture["nodes"][number];
type ArchitectureEdge = Architecture["edges"][number];

type FlowStep = {
  node: ArchitectureNode;
  /** Edges leaving this node that do not continue the main chain. */
  branches: ArchitectureEdge[];
};

type FlowDiagramProps = {
  architecture: Architecture;
};

const toneStyles = {
  ink: "border-line-strong/80 bg-white/80",
  accent: "border-accent/30 bg-accent-soft/60",
  muted: "border-line bg-paper-deep/70",
  warn: "border-warn/25 bg-warn/5",
} as const;

/**
 * Turns the captured graph into a single walk-through.
 *
 * The chain follows the edges from the nodes that have no incoming edge, so
 * the reader sees the real order of operations. Nodes that branch off (a
 * second entry point, for example) are appended and their extra edges are
 * shown on the step itself instead of being silently dropped.
 */
function linearize(architecture: Architecture): FlowStep[] {
  const nodes = architecture.nodes ?? [];
  const edges = architecture.edges ?? [];

  const columnOf = (id: string) =>
    nodes.find((node) => node.id === id)?.column ?? 0;

  const ordered = [...nodes].sort(
    (a, b) => columnOf(a.id) - columnOf(b.id) || a.id.localeCompare(b.id),
  );

  const outgoing = new Map<string, ArchitectureEdge[]>();
  for (const edge of edges) {
    const list = outgoing.get(edge.from) ?? [];
    list.push(edge);
    outgoing.set(edge.from, list);
  }

  const visited = new Set<string>();
  const sequence: string[] = [];

  const walk = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    sequence.push(id);
    const next = (outgoing.get(id) ?? [])[0];
    if (next) walk(next.to);
  };

  const hasIncoming = new Set(edges.map((edge) => edge.to));
  for (const node of ordered) {
    if (!hasIncoming.has(node.id)) walk(node.id);
  }
  for (const node of ordered) {
    if (!visited.has(node.id)) walk(node.id);
  }

  return sequence
    .map((id) => nodes.find((node) => node.id === id))
    .filter((node): node is ArchitectureNode => Boolean(node))
    .map((node, index) => {
      const nextId = sequence[index + 1];
      const branches = (outgoing.get(node.id) ?? []).filter(
        (edge) => edge.to !== nextId,
      );
      return { node, branches };
    });
}

export function FlowDiagram({ architecture }: FlowDiagramProps) {
  const steps = linearize(architecture);
  const [activeIndex, setActiveIndex] = useState<number | null>(0);
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const reduceMotion = useReducedMotion();

  function focusStep(index: number) {
    const next = Math.min(Math.max(index, 0), Math.max(steps.length - 1, 0));
    setActiveIndex(next);
    buttonRefs.current[next]?.focus();
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!steps.length) return;
    const current = activeIndex ?? 0;

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      focusStep(current + 1);
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      focusStep(current - 1);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusStep(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusStep(steps.length - 1);
    }
  }

  if (!steps.length) {
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
              <p className="mt-1.5 text-[12px] text-muted">
                {architecture.subtitle}
              </p>
            ) : null}
          </div>
          <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
            flow
          </span>
        </div>
        <div className="px-5 py-8 text-center sm:px-6">
          <p className="text-[13px] font-medium text-ink">
            No steps are captured for this flow
          </p>
          <p className="mx-auto mt-1 max-w-[46ch] text-[12.5px] leading-relaxed text-muted">
            The architecture file for this project has no nodes, so there is
            nothing to walk through. Nothing is invented to fill the gap.
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
            {architecture.title}
          </h3>
          {architecture.subtitle ? (
            <p className="mt-1.5 text-[12px] text-muted">
              {architecture.subtitle}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
            step {Math.min((activeIndex ?? 0) + 1, steps.length)} of {steps.length}
          </span>
          <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
            flow
          </span>
        </div>
      </div>

      <div
        className="px-5 py-6 sm:px-6"
        onKeyDown={handleKeyDown}
        role="group"
        aria-label="Step-by-step flow. Use the arrow keys to move between steps."
      >
        <ol className="space-y-0">
          {steps.map((step, index) => {
            const isActive = activeIndex === index;
            const nextStep = steps[index + 1];
            const connector = nextStep
              ? (architecture.edges ?? []).find(
                  (edge) => edge.from === step.node.id && edge.to === nextStep.node.id,
                )
              : undefined;

            return (
              <li key={step.node.id} className="relative pl-10">
                <motion.span
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{
                    duration: reduceMotion ? 0.01 : 0.28,
                    delay: reduceMotion ? 0 : index * 0.05,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                  className={cn(
                    "absolute left-0 top-0.5 flex h-[22px] w-[22px] items-center justify-center rounded-full border font-mono text-[9.5px]",
                    isActive
                      ? "border-accent/40 bg-accent-soft text-accent"
                      : "border-line-strong bg-paper text-muted",
                  )}
                >
                  {String(index + 1).padStart(2, "0")}
                </motion.span>

                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: reduceMotion ? 0.01 : 0.3,
                    delay: reduceMotion ? 0 : index * 0.05,
                    ease: [0.22, 1, 0.36, 1],
                  }}
                >
                  <button
                    ref={(node) => {
                      buttonRefs.current[index] = node;
                    }}
                    type="button"
                    aria-expanded={isActive}
                    aria-controls={`flow-step-${index}`}
                    onClick={() => setActiveIndex(isActive ? null : index)}
                    className={cn(
                      "w-full rounded-xl border px-3.5 py-3 text-left transition-colors",
                      toneStyles[step.node.tone ?? "ink"],
                      isActive
                        ? "border-accent/45 shadow-[0_1px_0_rgba(20,19,15,0.02)]"
                        : "hover:border-line-strong",
                    )}
                  >
                    <span className="flex items-center justify-between gap-3">
                      <span className="text-[13.5px] font-medium leading-tight text-ink">
                        {step.node.label}
                      </span>
                      <ChevronDown
                        className={cn(
                          "h-3.5 w-3.5 shrink-0 text-muted transition-transform duration-200",
                          isActive && "rotate-180",
                        )}
                      />
                    </span>
                    {step.node.detail ? (
                      <span className="mt-1 block text-[11.5px] leading-snug text-muted">
                        {step.node.detail}
                      </span>
                    ) : null}
                  </button>

                  <AnimatePresence>
                    {isActive ? (
                      <motion.div
                        key="detail"
                        id={`flow-step-${index}`}
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{
                          duration: reduceMotion ? 0.01 : 0.24,
                          ease: [0.22, 1, 0.36, 1],
                        }}                        className="overflow-hidden"
                      >
                        <div className="mt-1.5 rounded-xl border border-dashed border-line bg-paper/40 px-3.5 py-2.5">
                          <p className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted">
                            Step {index + 1} detail
                          </p>
                          <p className="mt-1.5 text-[12px] leading-[1.55] text-ink-soft">
                            {step.node.detail ??
                              "No further detail was captured for this step."}
                          </p>
                          {step.branches.length ? (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <span className="text-[10.5px] uppercase tracking-[0.12em] text-muted">
                                Also feeds
                              </span>
                              {step.branches.map((edge) => (
                                <span
                                  key={`${edge.from}-${edge.to}-${edge.label ?? ""}`}
                                  className="rounded-full border border-line bg-white/70 px-2.5 py-1 font-mono text-[10px] text-muted"
                                >
                                  {edge.label
                                    ? `${edge.label} → ${edge.to}`
                                    : `→ ${edge.to}`}
                                </span>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </motion.div>
                    ) : null}
                  </AnimatePresence>
                </motion.div>

                {nextStep ? (
                  <div className="relative flex min-h-10 items-center pl-[11px]">
                    <span className="absolute left-[10px] top-0 h-full w-px bg-line-strong" />
                    {connector?.label ? (
                      <span className="ml-3 inline-flex items-center gap-1.5 rounded-full border border-line bg-paper/80 px-2.5 py-1 font-mono text-[10px] text-muted">
                        {connector.label}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>

      {architecture.notes?.length ? (
        <div className="border-t border-line bg-paper/45 px-5 py-4 sm:px-6">
          <div className="mb-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
            <Info className="h-3 w-3" />
            Notes
          </div>
          <ul className="space-y-1.5">
            {(architecture.notes ?? []).map((note) => (
              <li
                key={note}
                className="flex gap-2 text-[12px] leading-[1.55] text-ink-soft"
              >
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
