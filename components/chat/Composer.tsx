"use client";

import { useEffect, useRef, type FormEvent, type KeyboardEvent } from "react";
import { motion } from "motion/react";
import { ArrowUp } from "lucide-react";

import { cn } from "@/lib/utils";

type ComposerProps = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
  compact?: boolean;
};

export function Composer({
  value,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = "Ask about my projects, code, or experience…",
  compact = false,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, compact ? 132 : 160)}px`;
  }, [value, compact]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!value.trim() || disabled) return;
    onSubmit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!value.trim() || disabled) return;
      onSubmit();
    }
  }

  return (
    <motion.form
      layoutId="composer"
      onSubmit={handleSubmit}
      className={cn(
        "group relative flex w-full items-end gap-2 rounded-[28px] border border-line-strong/80 bg-white/75 p-2 pl-5 shadow-[0_8px_40px_rgba(20,19,15,0.06)] backdrop-blur-xl transition-shadow duration-200 focus-within:border-accent/40 focus-within:shadow-[0_10px_50px_rgba(47,75,255,0.10)]",
        compact ? "min-h-[58px]" : "min-h-[64px]",
      )}
    >
      <label htmlFor="portfolio-composer" className="sr-only">
        Ask about Kaustubh&apos;s work
      </label>
      <textarea
        id="portfolio-composer"
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={1}
        disabled={disabled}
        className="max-h-[160px] min-h-[28px] flex-1 resize-none bg-transparent py-2.5 text-[16px] leading-6 text-ink outline-none placeholder:text-muted/80 disabled:cursor-not-allowed disabled:opacity-60 sm:text-[15px]"
        aria-describedby="composer-hint"
      />
      <span id="composer-hint" className="sr-only">
        Press Enter to send, Shift + Enter for a new line.
      </span>
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        aria-label="Send question"
        className="mb-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-ink text-paper transition-all duration-200 hover:bg-accent disabled:cursor-not-allowed disabled:bg-line-strong disabled:text-muted"
      >
        <ArrowUp className="h-[18px] w-[18px]" strokeWidth={2.2} />
      </button>
    </motion.form>
  );
}
