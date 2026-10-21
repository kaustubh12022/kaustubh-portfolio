"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { motion } from "motion/react";

import { VisualRenderer } from "@/components/chat/VisualRenderer";
import type { Architecture, Claim, Profile, Project } from "@/lib/content/schemas";
import type { ChatMessage } from "@/lib/types/chat";
import { cn } from "@/lib/utils";

type MessageProps = {
  message: ChatMessage;
  profile: Profile;
  projects: Project[];
  claims: Claim[];
  architectures: Record<string, Architecture>;
  onAsk: (question: string) => void;
};

export function Message({
  message,
  profile,
  projects,
  claims,
  architectures,
  onAsk,
}: MessageProps) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
        className="flex justify-end py-2"
      >
        <div className="max-w-[85%] rounded-[20px] rounded-br-md bg-ink px-4 py-3 text-[15px] leading-6 text-paper">
          {message.text}
        </div>
      </motion.div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.34, ease: [0.22, 1, 0.36, 1] }}
      className="flex gap-3 py-3 sm:gap-4"
    >
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-strong/70 bg-white/70 font-display text-[15px] text-ink shadow-sm">
        K
      </div>

      <div className="min-w-0 flex-1">
        <div className="answer-prose max-w-[68ch]">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              p: ({ children }) => <p>{children}</p>,
              ul: ({ children }) => <ul>{children}</ul>,
              li: ({ children }) => <li>{children}</li>,
              strong: ({ children }) => <strong>{children}</strong>,
              code: ({ children }) => <code>{children}</code>,
              a: ({ href, children }) => (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              ),
            }}
          >
            {message.text}
          </ReactMarkdown>
        </div>

        {message.visual ? (
          <div className="mt-4">
            <VisualRenderer
              spec={message.visual}
              profile={profile}
              projects={projects}
              claims={claims}
              architectures={architectures}
              onAsk={onAsk}
            />
          </div>
        ) : null}

        {message.evidence?.length ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
              Evidence
            </span>
            {message.evidence.map((item) => (
              <span
                key={item}
                className={cn(
                  "rounded-full border border-line bg-paper-deep/60 px-2.5 py-1 font-mono text-[10.5px] text-muted",
                )}
              >
                {item}
              </span>
            ))}
          </div>
        ) : null}

        {message.confidence ? (
          <div className="mt-3 flex items-center gap-2 text-[10.5px] text-muted">
            <span className="font-medium uppercase tracking-[0.16em]">
              Confidence
            </span>
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 font-mono text-[10px]",
                message.confidence === "high" &&
                  "border-live/40 bg-live/10 text-live",
                message.confidence === "medium" &&
                  "border-accent/35 bg-accent-soft/60 text-accent",
                message.confidence === "low" &&
                  "border-line-strong/60 bg-paper-deep/60 text-muted",
              )}
            >
              {message.confidence}
            </span>
          </div>
        ) : null}

        {message.caveats?.length ? (
          <ul className="mt-2 space-y-1 text-[12px] leading-relaxed text-muted">
            {message.caveats.map((caveat) => (
              <li key={caveat} className="flex gap-1.5">
                <span aria-hidden className="text-accent/70">
                  ·
                </span>
                <span>{caveat}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {message.followUps?.length ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {message.followUps.map((question) => (
              <button
                key={question}
                type="button"
                onClick={() => onAsk(question)}
                className="rounded-full border border-line bg-white/50 px-3 py-1.5 text-left text-[12.5px] text-ink-soft transition-colors hover:border-accent/40 hover:bg-accent-soft/60 hover:text-ink"
              >
                {question}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}
