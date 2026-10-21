"use client";

import { motion, useReducedMotion } from "motion/react";
import { Check, Copy, FileCode } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { createHighlighterCore } from "shiki/core";

import { cn } from "@/lib/utils";

const THEME = "github-dark";

/** Long excerpts are trimmed so one citation cannot flood the answer. */
const MAX_LINES = 120;

type CoreOptions = Parameters<typeof createHighlighterCore>[0];
type LangInput = NonNullable<CoreOptions["langs"]>[number];
type ThemeInput = NonNullable<CoreOptions["themes"]>[number];

type HighlightedToken = { content: string; color?: string };
type HighlightedLine = HighlightedToken[];

type CodeExplorerProps = {
  projectId: string;
  path: string;
  startLine: number;
  endLine: number;
  code: string;
  language: string;
};

const LANGUAGE_ALIASES: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  yml: "yaml",
  md: "markdown",
  htm: "html",
  dockerfile: "docker",
};

const PATH_LANGUAGES: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".ts": "typescript",
  ".tsx": "tsx",
  ".java": "java",
  ".sql": "sql",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".dart": "dart",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".json": "json",
  ".md": "markdown",
  ".sh": "bash",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".php": "php",
};

/** Best-effort language id for a file path, used when the spec omits one. */
export function inferLanguage(path: string) {
  const match = path.match(/\.([a-z0-9]+)$/i);
  if (!match) return "text";
  const extension = `.${match[1].toLowerCase()}`;
  return PATH_LANGUAGES[extension] ?? match[1].toLowerCase();
}

function normalizeLanguage(language: string) {
  const key = (language ?? "").trim().toLowerCase();
  return LANGUAGE_ALIASES[key] ?? key;
}

export function CodeExplorer({
  projectId,
  path,
  startLine,
  endLine,
  code,
  language,
}: CodeExplorerProps) {
  const source = code ?? "";
  const hasSource = source.trim().length > 0;
  const lang = normalizeLanguage(language) || "text";

  const lines = useMemo(
    () => (hasSource ? source.replace(/\n+$/, "").split("\n") : []),
    [source, hasSource],
  );
  const shown = useMemo(() => lines.slice(0, MAX_LINES), [lines]);
  const elided = Math.max(lines.length - shown.length, 0);
  const visibleText = shown.join("\n");

  const [tokens, setTokens] = useState<HighlightedLine[] | null>(null);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setTokens(null);

    if (!visibleText.trim()) return;

    async function run() {
      try {
        const [
          { createHighlighterCore: createCore },
          { createJavaScriptRegexEngine },
          { bundledLanguages },
          { bundledThemes },
        ] = await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
          import("shiki/langs"),
          import("shiki/themes"),
        ]);

        const langInput = (bundledLanguages as unknown as Record<
          string,
          LangInput
        >)[lang];
        const themeInput = (bundledThemes as unknown as Record<
          string,
          ThemeInput
        >)[THEME];

        if (!langInput || !themeInput) return;

        const highlighter = await createCore({
          themes: [themeInput],
          langs: [langInput],
          engine: createJavaScriptRegexEngine(),
        });

        if (cancelled || !mounted.current) return;

        const result = highlighter.codeToTokens(visibleText, {
          lang,
          theme: THEME,
        });

        if (cancelled || !mounted.current) return;

        setTokens(result.tokens as unknown as HighlightedLine[]);
      } catch {
        // Unknown language, blocked wasm, or a slow network. The plain
        // rendering stays on screen, so nothing ever flashes an error.
        if (!cancelled && mounted.current) setTokens(null);
      }
    }

    void run();

    return () => {
      cancelled = true;
    };
  }, [lang, visibleText]);

  async function handleCopy() {
    try {
      if (typeof navigator === "undefined" || !navigator.clipboard) return;
      await navigator.clipboard.writeText(source);
      if (!mounted.current) return;
      setCopied(true);
      window.setTimeout(() => {
        if (mounted.current) setCopied(false);
      }, 1600);
    } catch {
      // Clipboard access can be denied. Leave the button unchanged.
    }
  }

  const declaredSpan = Math.max(endLine - startLine + 1, 0);
  const isExcerpt = hasSource && lines.length !== declaredSpan;

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
        <div className="min-w-0">
          <h3 className="font-display text-[22px] leading-none tracking-[-0.02em] text-ink">
            Source
          </h3>
          <p className="mt-1.5 truncate font-mono text-[12px] text-muted">
            {path}
            {hasSource ? ` · L${startLine}–L${endLine}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isExcerpt ? (
            <span className="rounded-full border border-warn/25 bg-warn/5 px-2.5 py-1 font-mono text-[10px] text-warn">
              excerpt · {lines.length} lines attached
            </span>
          ) : null}
          <span className="rounded-full border border-line bg-paper/70 px-2.5 py-1 font-mono text-[10px] text-muted">
            {projectId}
          </span>
        </div>
      </div>

      {hasSource ? (
        <div className="p-4 sm:p-5">
          <div className="overflow-hidden rounded-xl border border-line bg-code">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-4 py-2.5">
              <FileCode className="h-3.5 w-3.5 shrink-0 text-paper/45" />
              <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-paper/85">
                {path}
              </span>
              <span className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] text-paper/55">
                L{startLine}–L{endLine}
              </span>
              <span className="rounded-full border border-white/15 px-2 py-0.5 font-mono text-[10px] text-paper/55">
                {lang}
              </span>
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex items-center gap-1.5 rounded-full border border-white/15 px-2.5 py-1 font-mono text-[10px] text-paper/70 transition-colors hover:border-white/35 hover:text-paper"
              >
                {copied ? (
                  <Check className="h-3 w-3" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                {copied ? "copied" : "copy"}
              </button>
            </div>

            <pre className="thin-scrollbar overflow-x-auto bg-code py-3 font-mono text-[12px] leading-[1.75] text-paper/80">
              <code className="block">
                {shown.map((line, index) => (
                  <span key={index} className="flex">
                    <span className="sticky left-0 z-10 w-12 shrink-0 select-none border-r border-white/10 bg-code pr-3 text-right text-[11px] text-paper/30">
                      {startLine + index}
                    </span>
                    <span className="whitespace-pre px-4">
                      {tokens?.[index]
                        ? tokens[index].map((token, tokenIndex) => (
                            <span
                              key={tokenIndex}
                              style={token.color ? { color: token.color } : undefined}
                            >
                              {token.content}
                            </span>
                          ))
                        : line}
                    </span>
                  </span>
                ))}
              </code>
            </pre>

            {elided > 0 ? (
              <p className="border-t border-white/10 px-4 py-2.5 font-mono text-[10.5px] text-paper/45">
                {elided} more line{elided === 1 ? "" : "s"} elided — showing L
                {startLine}–L{startLine + shown.length - 1} of {lines.length}
              </p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="px-5 py-8 text-center sm:px-6">
          <FileCode className="mx-auto h-5 w-5 text-line-strong" />
          <p className="mt-2.5 text-[13px] font-medium text-ink">
            No source text is attached to this citation
          </p>
          <p className="mx-auto mt-1 max-w-[46ch] text-[12.5px] leading-relaxed text-muted">
            The citation resolves to {path || "a file path"} at lines{" "}
            {startLine}–{endLine}, but the lines themselves were not attached to
            the answer. Nothing is shown here rather than something invented.
          </p>
        </div>
      )}
    </motion.section>
  );
}
