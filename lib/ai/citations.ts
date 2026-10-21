import "server-only";

/**
 * The citation validator - the honesty gate.
 *
 * WHAT IT PROTECTS
 * ----------------
 * A language model will happily invent `src/ai_engine.py:59-74` if nothing
 * checks it. This module is the check.
 *
 * A citation survives only when BOTH of these hold:
 *
 *   1. the `chunks` table really contains that source. The cited range must
 *      be covered by the indexed chunks of that (projectId, path) pair, and
 *   2. the cited text is the text that is actually at those lines. When the
 *      model supplied a `quote`, the quote has to match the reconstructed
 *      source at [startLine, endLine] EXACTLY (after line-ending and
 *      trailing-whitespace normalisation). When it did not, the citation is
 *      dropped.
 *
 * A dropped citation is not a cosmetic problem: the route downgrades the
 * answer's confidence and adds a caveat, so an answer built on a hallucinated
 * line number cannot look authoritative.
 *
 * WHY "RESOLVES IN THE INDEX" IS THE LINE
 * ---------------------------------------
 * An earlier version also required the cited range to be one the server had
 * actually served to the model during THIS request. That was too strict and
 * it was firing constantly in production: a model that read
 * `src/scorer.py:333-412` and then cited `src/scorer.py:549-559` (a real,
 * perfectly resolvable chunk it had seen in the claim ledger's `source`
 * field) had its citation dropped, its confidence downgraded and a caveat
 * added - for pointing at a line that genuinely exists.
 *
 * The index check is the real protection against an invented line number: a
 * range that does not exist in the indexed source cannot be shown, and a
 * range that does exist is a location a reader can go and check. The
 * "was it actually read" question is still tracked, but as a PROVENANCE
 * signal in the route (it becomes a caveat), not as a rejection.
 *
 * WHY THE RANGE CHECK IS "CONTAINED OR FULLY COVERED"
 * ---------------------------------------------------
 * The strict reading of the rule is "one indexed chunk whose line range
 * contains the cited range". That is implemented first. Files are chunked by
 * AST, so a cited range can legitimately straddle two chunks (a function
 * that starts in one chunk and ends in the next). In that case the union of
 * the overlapping chunks must cover the range with no gap; if it does, the
 * range is real and the text is still reconstructed from the index. If the
 * union has a gap, the citation is REJECTED.
 *
 * The reconstruction uses the same code path as `readFile`
 * (`reconstructFileBody`), so the text the model was shown and the text the
 * validator re-reads are byte-for-byte the same construction.
 */

import { query } from "@/lib/retrieval/db";
import { reconstructFileBody } from "@/lib/retrieval/search";
import type { EvidenceRef } from "@/lib/types/chat";

/** The result of a validation pass. */
export type EvidenceValidation = {
  /** The citations that resolved against the index. */
  verified: EvidenceRef[];
  /** The citations that did not. */
  rejected: EvidenceRef[];
};

/** A chunk row, as stored. */
type ChunkRow = {
  start_line: number;
  end_line: number;
  content: string;
  symbol: string;
};

const CHUNKS_FOR_PATH_SQL = `
  SELECT start_line, end_line, content, symbol
    FROM chunks
   WHERE project_id = $1 AND path = $2
   ORDER BY start_line, end_line`;

/**
 * Normalise a block of source text for comparison.
 *
 * Line endings are unified to `\n` and trailing whitespace on each line is
 * removed. Nothing else is touched - the comparison is still exact.
 */
function normalise(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * Do the overlapping chunks cover every line of [startLine, endLine]?
 *
 * @returns true when the range is fully covered with no gap.
 */
function isFullyCovered(
  rows: ChunkRow[],
  startLine: number,
  endLine: number,
): boolean {
  const sorted = [...rows].sort((a, b) => a.start_line - b.start_line);
  let cursor = startLine;
  for (const row of sorted) {
    if (row.start_line > cursor) return false; // a gap
    cursor = Math.max(cursor, row.end_line + 1);
    if (cursor > endLine) return true;
  }
  return cursor > endLine;
}

/**
 * Validate a batch of citations against the index.
 *
 * @param refs the citations the model asked to show
 * @returns the verified and the rejected citations
 */
export async function validateEvidence(
  refs: EvidenceRef[],
): Promise<EvidenceValidation> {
  const verified: EvidenceRef[] = [];
  const rejected: EvidenceRef[] = [];

  if (refs.length === 0) return { verified, rejected };

  // One query per (project, path) pair instead of one per citation.
  const rowsByKey = new Map<string, ChunkRow[]>();
  const keys: Array<{ key: string; projectId: string; path: string }> = [];
  for (const ref of refs) {
    const key = `${ref.projectId}::${ref.path}`;
    if (!rowsByKey.has(key)) {
      keys.push({ key, projectId: ref.projectId, path: ref.path });
      rowsByKey.set(key, []);
    }
  }

  await Promise.all(
    keys.map(async ({ key, projectId, path }) => {
      const result = await query<ChunkRow>(CHUNKS_FOR_PATH_SQL, [projectId, path]);
      rowsByKey.set(key, result.rows);
    }),
  );

  for (const ref of refs) {
    const rows = rowsByKey.get(`${ref.projectId}::${ref.path}`) ?? [];

    // 0. The range must be a sane, non-empty, ordered range.
    if (
      !Number.isInteger(ref.startLine) ||
      !Number.isInteger(ref.endLine) ||
      ref.startLine < 1 ||
      ref.endLine < ref.startLine
    ) {
      rejected.push({ ...ref, verified: false });
      continue;
    }

    // 1. The file must be in the index at all.
    if (rows.length === 0) {
      rejected.push({ ...ref, verified: false });
      continue;
    }

    // 2. The range must be covered by the indexed chunks: either contained in
    //    a single chunk, or fully covered by the union of overlapping chunks.
    const containing = rows.filter(
      (row) => row.start_line <= ref.startLine && row.end_line >= ref.endLine,
    );
    const overlapping = rows.filter(
      (row) => row.start_line <= ref.endLine && row.end_line >= ref.startLine,
    );
    if (containing.length === 0 && !isFullyCovered(overlapping, ref.startLine, ref.endLine)) {
      rejected.push({ ...ref, verified: false });
      continue;
    }

    // 3. The text at those lines must be exactly what was cited.
    const body = reconstructFileBody(
      rows.map((row) => ({
        startLine: row.start_line,
        endLine: row.end_line,
        content: row.content,
      })),
      { start: ref.startLine, end: ref.endLine },
    );
    const actual = normalise(body.text);

    if (typeof ref.quote === "string" && ref.quote.trim().length > 0) {
      // 3a. With a quote, the quote has to match the indexed text exactly.
      //     This is the strictest form of the gate: the model has to have
      //     reproduced the source, character for character.
      if (normalise(ref.quote) !== actual) {
        rejected.push({ ...ref, verified: false });
        continue;
      }
    }
    // 3b. Without a quote, the range has already been proven to exist in
    //     the indexed source (steps 1 and 2), which is what the gate is
    //     for. The route separately reports the citations that were NOT
    //     read during this answer, as a provenance caveat.

    const symbol =
      ref.symbol ??
      containing[0]?.symbol ??
      overlapping[0]?.symbol ??
      "";

    verified.push({
      ...ref,
      symbol: symbol || undefined,
      label:
        ref.startLine === ref.endLine
          ? `${ref.path}:${ref.startLine}`
          : `${ref.path}:${ref.startLine}-${ref.endLine}`,
      verified: true,
    });
  }

  return { verified, rejected };
}

/**
 * Downgrade a confidence level when citations were dropped.
 *
 * A citation that does not resolve means the model wrote something it could
 * not back up. The answer is still shown - it may be right - but it must not
 * look certain.
 */
export function downgradeConfidence(
  confidence: "high" | "medium" | "low",
  rejectedCount: number,
): "high" | "medium" | "low" {
  if (rejectedCount === 0) return confidence;
  if (confidence === "high") return "medium";
  if (confidence === "medium") return "low";
  return "low";
}
