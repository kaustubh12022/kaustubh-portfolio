"use client";

import { motion } from "motion/react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  CircleDot,
} from "lucide-react";

import type { Claim } from "@/lib/content/schemas";
import { cn } from "@/lib/utils";

const statusMeta = {
  verified: {
    label: "Verified",
    className: "border-live/25 bg-live/10 text-live",
    icon: CheckCircle2,
  },
  partial: {
    label: "Partial",
    className: "border-warn/25 bg-warn/10 text-warn",
    icon: CircleDot,
  },
  unverified: {
    label: "Unverified",
    className: "border-line bg-paper-deep text-muted",
    icon: CircleDashed,
  },
  contradicted: {
    label: "Contradicted",
    className: "border-danger/25 bg-danger/10 text-danger",
    icon: AlertTriangle,
  },
} as const;

type EvidenceTableProps = {
  claims: Claim[];
};

export function EvidenceTable({ claims }: EvidenceTableProps) {
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
            Claim ledger
          </h3>
          <p className="mt-1.5 text-[12px] text-muted">
            What the old resume said, and what the code supports.
          </p>
        </div>
        <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
          claims.yaml
        </span>
      </div>

      <div className="space-y-3 p-4 sm:p-5">
        {claims.map((claim, index) => {
          const meta = statusMeta[claim.status];
          const Icon = meta.icon;

          return (
            <motion.div
              key={claim.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: index * 0.06 }}
              className="rounded-xl border border-line bg-paper/55 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted">
                  {claim.topic}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10.5px] font-medium",
                    meta.className,
                  )}
                >
                  <Icon className="h-3 w-3" />
                  {meta.label}
                </span>
              </div>

              <p className="mt-2.5 text-[12px] leading-snug text-muted line-through decoration-line-strong">
                “{claim.claim}”
              </p>

              <p className="mt-2.5 text-[13.5px] leading-[1.6] text-ink-soft">
                {claim.publicWording}
              </p>

              <p className="mt-2.5 text-[11.5px] leading-snug text-muted">
                {claim.evidence}
              </p>

              {claim.source ? (
                <code className="mt-2 inline-block rounded border border-line bg-white/70 px-2 py-0.5 font-mono text-[10px] text-muted">
                  {claim.source}
                </code>
              ) : null}
            </motion.div>
          );
        })}
      </div>
    </motion.section>
  );
}
