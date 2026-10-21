"use client";

import { motion, useReducedMotion } from "motion/react";
import { Database, Link2, Table2 } from "lucide-react";

import type { DataModelEntity } from "@/lib/types/chat";
import { cn } from "@/lib/utils";

type DataModelDiagramProps = {
  entities: DataModelEntity[];
  projectId?: string;
};

type Relation = {
  from: string;
  to: string;
  label: string;
  kind: "1-1" | "1-n" | "n-n";
};

const kindStyles: Record<Relation["kind"], string> = {
  "1-1": "border-line bg-paper-deep/70 text-muted",
  "1-n": "border-accent/25 bg-accent-soft/70 text-accent",
  "n-n": "border-live/25 bg-live/10 text-live",
};

function collectRelations(entities: DataModelEntity[]): Relation[] {
  const seen = new Set<string>();
  const relations: Relation[] = [];

  for (const entity of entities) {
    for (const relation of entity.relations ?? []) {
      const key = `${relation.from}->${relation.to}:${relation.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relations.push({
        from: relation.from,
        to: relation.to,
        label: relation.label,
        kind: relation.kind ?? "1-n",
      });
    }
  }

  return relations;
}

export function DataModelDiagram({
  entities,
  projectId,
}: DataModelDiagramProps) {
  const list = entities ?? [];
  const relations = collectRelations(list);
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
            Data model
          </h3>
          <p className="mt-1.5 text-[12px] text-muted">
            {list.length
              ? "Entities and the relations between them, as captured from the project."
              : "Only tables that were actually captured are drawn."}
          </p>
        </div>
        <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
          {projectId ? `${projectId} · data-model` : "data-model"}
        </span>
      </div>

      {list.length ? (
        <>
          <div className="grid gap-3 p-5 sm:grid-cols-2 sm:p-6 xl:grid-cols-3">
            {list.map((entity, index) => (
              <motion.div
                key={entity.name}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: reduceMotion ? 0.01 : 0.3,
                  delay: reduceMotion ? 0 : index * 0.05,
                  ease: [0.22, 1, 0.36, 1],
                }}
                className="rounded-xl border border-line bg-paper/55"
              >
                <div className="flex items-center gap-2 border-b border-line px-3.5 py-2.5">
                  <Table2 className="h-3.5 w-3.5 shrink-0 text-accent" />
                  <span className="truncate font-mono text-[12.5px] font-medium text-ink">
                    {entity.name}
                  </span>
                </div>

                {entity.fields.length ? (
                  <ul className="divide-y divide-line">
                    {entity.fields.map((field) => (
                      <li
                        key={`${entity.name}.${field.name}`}
                        className="flex items-baseline justify-between gap-3 px-3.5 py-2"
                      >
                        <span className="flex min-w-0 items-baseline gap-1.5">
                          <span className="truncate font-mono text-[11.5px] text-ink-soft">
                            {field.name}
                          </span>
                          {field.required ? (
                            <span
                              className="font-mono text-[10px] text-accent"
                              title="Required"
                            >
                              *
                            </span>
                          ) : null}
                        </span>

                        <span className="flex shrink-0 items-center gap-1.5">
                          {field.relation ? (
                            <span
                              className="inline-flex items-center gap-1 rounded-full border border-line bg-white/70 px-1.5 py-0.5 font-mono text-[9.5px] text-muted"
                              title={`References ${field.relation}`}
                            >
                              <Link2 className="h-2.5 w-2.5" />
                              {field.relation}
                            </span>
                          ) : null}
                          <span className="font-mono text-[10.5px] text-muted">
                            {field.type}
                          </span>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-3.5 py-3 text-[11.5px] text-muted">
                    No fields were captured for this entity.
                  </p>
                )}
              </motion.div>
            ))}
          </div>

          {relations.length ? (
            <div className="border-t border-line bg-paper/45 px-5 py-4 sm:px-6">
              <div className="mb-2.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
                <Link2 className="h-3 w-3" />
                Relations
              </div>
              <ul className="space-y-1.5">
                {relations.map((relation) => (
                  <li
                    key={`${relation.from}-${relation.to}-${relation.label}`}
                    className="flex flex-wrap items-center gap-2 text-[12px] text-ink-soft"
                  >
                    <span className="font-mono text-[11.5px] text-ink">
                      {relation.from}
                    </span>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 font-mono text-[10px]",
                        kindStyles[relation.kind],
                      )}
                    >
                      {relation.kind}
                    </span>
                    <span className="text-muted">{relation.label}</span>
                    <span className="text-line-strong">→</span>
                    <span className="font-mono text-[11.5px] text-ink">
                      {relation.to}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : (
        <div className="px-5 py-8 text-center sm:px-6">
          <Database className="mx-auto h-5 w-5 text-line-strong" />
          <p className="mt-2.5 text-[13px] font-medium text-ink">
            No data model is captured for this project
          </p>
          <p className="mx-auto mt-1 max-w-[48ch] text-[12.5px] leading-relaxed text-muted">
            The schemas for this project were never extracted into the verified
            content layer. I would rather show an empty frame than invent
            tables and fields that may not exist.
          </p>
        </div>
      )}
    </motion.section>
  );
}
