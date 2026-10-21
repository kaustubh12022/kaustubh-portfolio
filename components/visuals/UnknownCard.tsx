"use client";

import { motion, useReducedMotion } from "motion/react";
import { HelpCircle } from "lucide-react";

type UnknownCardProps = {
  reason: string;
};

export function UnknownCard({ reason }: UnknownCardProps) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: reduceMotion ? 0.01 : 0.32,
        ease: [0.22, 1, 0.36, 1],
      }}
      className="flex items-start gap-3 rounded-[18px] border border-dashed border-line-strong bg-paper/60 px-4 py-4"
    >
      <HelpCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
      <div>
        <p className="text-[13px] font-medium text-ink">
          Not enough verified information
        </p>
        <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{reason}</p>
      </div>
    </motion.div>
  );
}
