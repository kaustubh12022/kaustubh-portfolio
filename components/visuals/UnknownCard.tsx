"use client";

import { motion } from "motion/react";
import { HelpCircle } from "lucide-react";

type UnknownCardProps = {
  reason: string;
};

export function UnknownCard({ reason }: UnknownCardProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.32 }}
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
