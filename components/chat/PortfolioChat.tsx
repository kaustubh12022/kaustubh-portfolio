"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUpRight, Mail, MapPin } from "lucide-react";

import { GitHubIcon, LinkedInIcon } from "@/components/icons/BrandIcons";

import { Composer } from "@/components/chat/Composer";
import { Message } from "@/components/chat/Message";
import { readChatStream, type VisualPayload } from "@/components/chat/stream";
import { buildDemoAnswer, suggestedQuestions } from "@/lib/demo/answers";
import type { Architecture, Claim, Profile, Project } from "@/lib/content/schemas";
import type { ChatMessage, DemoAnswer } from "@/lib/types/chat";

type PortfolioChatProps = {
  profile: Profile;
  projects: Project[];
  featured: Project[];
  claims: Claim[];
  architectures: Record<string, Architecture>;
};

/** How many past turns are sent to the server. */
const HISTORY_WINDOW = 12;

function createId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}

/* ------------------------------------------------------------------ */
/* Message list helpers                                                */
/* ------------------------------------------------------------------ */

/** Append a streamed text delta to the assistant message. */
function appendDelta(
  list: ChatMessage[],
  id: string,
  delta: string,
): ChatMessage[] {
  const index = list.findIndex((message) => message.id === id);
  if (index === -1) {
    return [
      ...list,
      { id, role: "assistant", text: delta, pending: true },
    ];
  }
  const next = [...list];
  const current = next[index];
  next[index] = { ...current, text: current.text + delta, pending: true };
  return next;
}

/** Attach the validated visual, evidence and caveats. */
function attachVisual(
  list: ChatMessage[],
  id: string,
  payload: VisualPayload,
): ChatMessage[] {
  const index = list.findIndex((message) => message.id === id);
  if (index === -1) return list;
  const next = [...list];
  const current = next[index];
  next[index] = {
    ...current,
    visual: payload.visual ?? current.visual,
    evidence: payload.evidence.map((item) => item.label),
    followUps: payload.followUps,
    confidence: payload.confidence,
    caveats: payload.caveats,
  };
  return next;
}

/** Add a caveat to the assistant message. */
function appendCaveat(
  list: ChatMessage[],
  id: string,
  caveat: string,
): ChatMessage[] {
  const index = list.findIndex((message) => message.id === id);
  if (index === -1) return list;
  const next = [...list];
  const current = next[index];
  next[index] = {
    ...current,
    caveats: [...(current.caveats ?? []), caveat],
  };
  return next;
}

/** Mark the assistant message as finished. */
function finalise(list: ChatMessage[], id: string): ChatMessage[] {
  const index = list.findIndex((message) => message.id === id);
  if (index === -1) {
    return [...list, { id, role: "assistant", text: "", pending: false }];
  }
  const next = [...list];
  const current = next[index];
  next[index] = { ...current, pending: false };
  return next;
}

/**
 * Replace the assistant message with the offline demo answer.
 *
 * The site must never look broken: if the live route fails, the visitor
 * still gets an answer, clearly labelled as the offline one.
 */
function replaceWithDemo(
  list: ChatMessage[],
  id: string,
  answer: DemoAnswer,
  reason: string,
): ChatMessage[] {
  const demo: ChatMessage = {
    id,
    role: "assistant",
    text: answer.text,
    visual: answer.visual,
    evidence: answer.evidence,
    followUps: answer.followUps,
    confidence: "low",
    caveats: [
      `The live assistant was unavailable (${reason}). This is the offline demo answer.`,
    ],
  };
  const index = list.findIndex((message) => message.id === id);
  if (index === -1) return [...list, demo];
  const next = [...list];
  next[index] = demo;
  return next;
}

export function PortfolioChat({
  profile,
  projects,
  featured,
  claims,
  architectures,
}: PortfolioChatProps) {
  const [started, setStarted] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const firstName = profile.name.split(" ")[0] ?? profile.name;
  const lastName = profile.name.split(" ").slice(1).join(" ");
  const prompts = suggestedQuestions({ profile, projects, claims });

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!started) return;
    const frame = window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;
      element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages, thinking, started]);

  const submit = useCallback(
    (value: string) => {
      const text = value.trim();
      if (!text || thinking) return;

      setStarted(true);
      setDraft("");

      const userMessage: ChatMessage = { id: createId(), role: "user", text };
      const assistantId = createId();

      setMessages((previous) => [...previous, userMessage]);
      setThinking(true);

      const history = [...messages, userMessage]
        .slice(-HISTORY_WINDOW)
        .map((message) => ({
          id: message.id,
          role: message.role,
          parts: [{ type: "text" as const, text: message.text }],
        }));

      const controller = new AbortController();
      abortRef.current = controller;

      void (async () => {
        let receivedText = false;
        try {
          const response = await fetch("/api/chat", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ messages: history }),
            signal: controller.signal,
          });

          if (!response.ok) {
            const detail = (await response.json().catch(() => null)) as {
              error?: string;
            } | null;
            throw new Error(
              detail?.error ?? `The assistant replied with ${response.status}.`,
            );
          }

          await readChatStream(response, {
            onTextDelta: (delta) => {
              receivedText = true;
              setThinking(false);
              setMessages((previous) =>
                appendDelta(previous, assistantId, delta),
              );
            },
            onVisual: (payload) => {
              setMessages((previous) =>
                attachVisual(previous, assistantId, payload),
              );
            },
            onError: (message) => {
              setMessages((previous) =>
                appendCaveat(previous, assistantId, message),
              );
            },
          });

          if (!receivedText) {
            // The route answered but produced no text. Fall back so the
            // thread is never empty.
            const answer = buildDemoAnswer(text, { profile, projects, claims });
            setMessages((previous) =>
              replaceWithDemo(
                previous,
                assistantId,
                answer,
                "the live answer was empty",
              ),
            );
          } else {
            setMessages((previous) => finalise(previous, assistantId));
          }
        } catch (error) {
          if (controller.signal.aborted) return;
          const reason =
            error instanceof Error ? error.message : "unknown error";
          const answer = buildDemoAnswer(text, { profile, projects, claims });
          setMessages((previous) =>
            replaceWithDemo(previous, assistantId, answer, reason),
          );
        } finally {
          if (!controller.signal.aborted) setThinking(false);
        }
      })();
    },
    [claims, messages, profile, projects, thinking],
  );

  function reset() {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setDraft("");
    setThinking(false);
    setStarted(false);
  }

  return (
    <div className="paper-grain relative min-h-dvh overflow-hidden bg-paper">
      <div className="pointer-events-none absolute inset-0 hero-grid" aria-hidden />

      <AnimatePresence mode="wait">
        {!started ? (
          <motion.main
            key="hero"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className="relative mx-auto flex min-h-dvh w-full max-w-5xl flex-col px-5 sm:px-8"
          >
            <header className="flex items-center justify-between py-6 sm:py-7">
              <button
                type="button"
                onClick={reset}
                className="flex items-center gap-2.5 text-left"
                aria-label="Kaustubh Kale — home"
              >
                <span className="flex h-9 w-9 items-center justify-center rounded-[11px] border border-line-strong/80 bg-white/70 font-display text-[15px] shadow-sm">
                  KK
                </span>
                <span className="hidden text-[13px] font-medium tracking-[-0.01em] text-ink sm:block">
                  Kaustubh Kale
                </span>
              </button>

              <div className="flex items-center gap-4 text-[12px] text-muted">
                <span className="hidden items-center gap-1.5 sm:flex">
                  <MapPin className="h-3.5 w-3.5" />
                  Pune, India
                </span>
                <span className="flex items-center gap-2 rounded-full border border-line bg-white/50 px-3 py-1.5">
                  <span className="relative flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-live opacity-40" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-live" />
                  </span>
                  Open to roles
                </span>
              </div>
            </header>

            <div className="flex flex-1 flex-col items-center justify-center pb-14 pt-8 sm:pb-20">
              <motion.div
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
                className="flex w-full flex-col items-center text-center"
              >
                <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-line bg-white/55 px-3.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted backdrop-blur">
                  <span className="h-1 w-1 rounded-full bg-accent" />
                  Graduate Engineer · B.E. IT 2026
                </div>

                <h1 className="font-display text-[clamp(3.8rem,11vw,7.6rem)] leading-[0.86] tracking-[-0.035em] text-ink">
                  {firstName}{" "}
                  <span className="italic text-muted">{lastName}</span>
                </h1>

                <p className="mt-7 max-w-[34rem] text-balance text-[17px] leading-[1.6] text-ink-soft sm:text-[18px]">
                  I build AI agents, automation pipelines, and backend systems.
                  <span className="mt-1.5 block text-muted">
                    Ask me anything about how they work.
                  </span>
                </p>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.12, ease: [0.22, 1, 0.36, 1] }}
                className="mt-10 w-full max-w-[680px]"
              >
                <Composer
                  value={draft}
                  onChange={setDraft}
                  onSubmit={() => submit(draft)}
                  placeholder="Ask about SmartApply, Pawna, or the voice agent…"
                />
              </motion.div>

              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.5, delay: 0.24 }}
                className="mt-6 grid w-full max-w-[680px] grid-cols-1 gap-2 sm:grid-cols-2"
              >
                {prompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => submit(prompt)}
                    className="group inline-flex items-center justify-center gap-1.5 rounded-full border border-line bg-white/45 px-3.5 py-2 text-[12.5px] text-ink-soft backdrop-blur transition-all hover:border-accent/35 hover:bg-accent-soft/50 hover:text-ink"
                  >
                    {prompt}
                    <ArrowUpRight className="h-3 w-3 text-muted transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5" />
                  </button>
                ))}
              </motion.div>

              <div className="mt-12 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11.5px] text-muted">
                <a
                  href={profile.links.github}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
                >
                  <GitHubIcon className="h-3.5 w-3.5" />
                  GitHub
                </a>
                <a
                  href={profile.links.linkedin}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
                >
                  <LinkedInIcon className="h-3.5 w-3.5" />
                  LinkedIn
                </a>
                <a
                  href={`mailto:${profile.email}`}
                  className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
                >
                  <Mail className="h-3.5 w-3.5" />
                  Email
                </a>
                <span className="hidden sm:inline">·</span>
                <span>{profile.location}</span>
              </div>
            </div>
          </motion.main>
        ) : (
          <motion.div
            key="thread"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3 }}
            className="relative mx-auto flex min-h-dvh w-full max-w-4xl flex-col px-4 sm:px-6"
          >
            <header className="fixed inset-x-0 top-0 z-30 border-b border-line/70 bg-paper/80 backdrop-blur-xl">
              <div className="mx-auto flex w-full max-w-4xl items-center justify-between px-4 py-3.5 sm:px-6">
                <button
                  type="button"
                  onClick={reset}
                  className="flex items-center gap-2.5 text-left"
                  aria-label="Start a new conversation"
                >
                  <span className="flex h-8 w-8 items-center justify-center rounded-[10px] border border-line-strong/80 bg-white/70 font-display text-[13px]">
                    KK
                  </span>
                  <span>
                    <span className="block text-[13px] font-medium leading-tight text-ink">
                      Kaustubh Kale
                    </span>
                    <span className="block text-[10.5px] leading-tight text-muted">
                      AI · automation · backend
                    </span>
                  </span>
                </button>

                <button
                  type="button"
                  onClick={reset}
                  className="rounded-full border border-line bg-white/50 px-3 py-1.5 text-[11.5px] text-muted transition-colors hover:border-line-strong hover:text-ink"
                >
                  New chat
                </button>
              </div>
            </header>

            <div
              ref={scrollRef}
              className="no-scrollbar flex-1 overflow-y-auto pb-44 pt-24"
              aria-live="polite"
              aria-label="Conversation"
            >
              {messages.map((message) => (
                <Message
                  key={message.id}
                  message={message}
                  profile={profile}
                  projects={projects}
                  claims={claims}
                  architectures={architectures}
                  onAsk={submit}
                />
              ))}

              {thinking ? (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex gap-3 py-3 sm:gap-4"
                  aria-label="Thinking"
                >
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-line-strong/70 bg-white/70 font-display text-[15px]">
                    K
                  </div>
                  <div className="flex items-center gap-1.5 rounded-2xl border border-line bg-white/55 px-4 py-3">
                    {[0, 1, 2].map((index) => (
                      <motion.span
                        key={index}
                        className="h-1.5 w-1.5 rounded-full bg-muted"
                        animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
                        transition={{
                          duration: 1,
                          repeat: Infinity,
                          delay: index * 0.14,
                        }}
                      />
                    ))}
                  </div>
                </motion.div>
              ) : null}
            </div>

            <div className="pointer-events-none fixed inset-x-0 bottom-0 z-30 bg-gradient-to-t from-paper via-paper/95 to-transparent pb-4 pt-10">
              <div className="pointer-events-auto mx-auto w-full max-w-4xl px-4 sm:px-6">
                <Composer
                  value={draft}
                  onChange={setDraft}
                  onSubmit={() => submit(draft)}
                  disabled={thinking}
                  compact
                  placeholder="Ask a follow-up…"
                />
                <p className="mt-2.5 text-center text-[10.5px] text-muted">
                  Answers are grounded in source code and labelled when they are not.
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
