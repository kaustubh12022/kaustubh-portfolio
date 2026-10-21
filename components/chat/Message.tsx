"use client";

import { useState } from "react";
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

/**
 * Does this evidence label point at the file the code excerpt shows?
 *
 * The label is a human-readable string such as `src/ai_engine.py:59` or
 * `smartapply src/ai_engine.py:59-74`, so the comparison is done on the
 * path part, from both ends: a label may carry the project prefix and a
 * path may carry a directory the label dropped.
 */
function citesSameFile(label: string, path: string): boolean {
  if (!path) return false;
  const withoutLines = label.includes(":")
    ? label.slice(0, label.lastIndexOf(":"))
    : label;
  const trimmed = withoutLines.trim();
  if (!trimmed) return false;
  return trimmed.endsWith(path) || path.endsWith(trimmed);
}

export function Message({
  message,
  profile,
  projects,
  claims,
  architectures,
  onAsk,
}: MessageProps) {
  const isUser = message.role === "user";

  /**
   * Which citation chip is open.
   *
   * The chips used to be static `<span>`s: a keyboard user could not
   * activate them and they did nothing. They are real buttons now, and the
   * one that matches the code excerpt opens the excerpt.
   */
  const [openCitation, setOpenCitation] = useState<number | null>(null);

  /**
   * The code visual, and the chip that cites it.
   *
   * The excerpt is rendered INSIDE the chip's panel, so the chip really does
   * toggle the source instead of sitting next to it. When no chip cites the
   * file, the excerpt stays where it was: inline, above the chips.
   */
  const codeVisual = message.visual?.kind === "code" ? message.visual : null;
  const codeCitationIndex = codeVisual
    ? (message.evidence ?? []).findIndex((item) =>
        citesSameFile(item, codeVisual.path),
      )
    : -1;

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

        {message.visual && codeCitationIndex === -1 ? (
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
          <div className="mt-3">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[10px] font-medium uppercase tracking-[0.16em] text-muted">
                Evidence
              </span>
              {message.evidence.map((item, index) => (
                <button
                  key={`${item}-${index}`}
                  type="button"
                  id={`citation-${message.id}-${index}`}
                  aria-expanded={openCitation === index}
                  aria-controls={`citation-panel-${message.id}-${index}`}
                  onClick={() =>
                    setOpenCitation((current) =>
                      current === index ? null : index,
                    )
                  }
                  className={cn(
                    "cursor-pointer rounded-full border border-line bg-paper-deep/60 px-2.5 py-1 font-mono text-[10.5px] text-muted transition-colors hover:border-accent/40 hover:text-ink",
                    openCitation === index &&
                      "border-accent/45 bg-accent-soft/60 text-ink",
                  )}
                >
                  {item}
                </button>
              ))}
            </div>

            {message.evidence.map((item, index) => (
              <div
                key={`panel-${item}-${index}`}
                id={`citation-panel-${message.id}-${index}`}
                hidden={openCitation !== index}
                className="mt-3"
              >
                {index === codeCitationIndex && codeVisual ? (
                  <VisualRenderer
                    spec={codeVisual}
                    profile={profile}
                    projects={projects}
                    claims={claims}
                    architectures={architectures}
                    onAsk={onAsk}
                  />
                ) : (
                  <p className="rounded-[14px] border border-line bg-paper-deep/40 px-3.5 py-2.5 text-[12px] leading-relaxed text-muted">
                    This citation was verified against the pinned commit before
                    the answer was sent. The source excerpt for this file was
                    not attached to the answer, so nothing is shown here rather
                    than something invented.
                  </p>
                )}
              </div>
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
