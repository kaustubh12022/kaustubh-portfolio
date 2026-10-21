export type ChatRole = "user" | "assistant";

/**
 * The visual contract.
 *
 * The model picks a `kind` and a set of IDs. It NEVER passes arbitrary chart
 * data, markup, or JSX. Every visual is rendered by a React component that
 * reads from the validated content layer (`content/*.yaml`) or from the
 * retrieval index, so a visual can never show a number that is not already
 * verified.
 *
 * An unknown or invalid spec falls back to `UnknownCard`, which states
 * honestly that there is no verified visual for the answer.
 */
export type VisualSpec =
  | { kind: "profile" }
  | { kind: "education" }
  | { kind: "skills" }
  | { kind: "project"; projectId: string }
  | { kind: "architecture"; projectId: string }
  | { kind: "flow"; projectId: string }
  | { kind: "data-model"; projectId: string; entities?: DataModelEntity[] }
  | {
      kind: "code";
      projectId: string;
      path: string;
      startLine: number;
      endLine: number;
      /**
       * The exact source lines the citation points at.
       *
       * The server resolves and attaches these; a spec without them renders
       * an honest "no source attached" state rather than a fabricated file.
       */
      code?: string;
      /** A Shiki language id, e.g. `python`. Inferred from `path` when absent. */
      language?: string;
    }
  | {
      kind: "comparison";
      projectIds: string[];
      dimension?: string;
      /** Resolved comparison rows. Derived from the project index when absent. */
      rows?: ComparisonRow[];
    }
  | { kind: "metrics"; projectId?: string; rows?: MetricRow[] }
  | { kind: "claims"; claimIds: string[] }
  | { kind: "contact" };

/**
 * One table in a captured data model.
 *
 * The entity is only ever drawn when it came from the verified content
 * layer, so the shape mirrors what a reviewer can check.
 */
export type DataModelEntity = {
  name: string;
  fields: {
    name: string;
    type: string;
    required?: boolean;
    /** The related entity this field points at, when it is a foreign key. */
    relation?: string;
  }[];
  relations?: {
    from: string;
    to: string;
    label: string;
    kind?: "1-1" | "1-n" | "n-n";
  }[];
};

/** One project as shown next to its peers in a comparison. */
export type ComparisonRow = {
  id: string;
  name: string;
  tagline?: string;
  status?: string;
  stack?: string[];
  metrics?: { label: string; value: string; note?: string }[];
  caveats?: string[];
  summary?: string;
};

/** One verified number, with the method and source that make it checkable. */
export type MetricRow = {
  label: string;
  value: string;
  unit?: string;
  method: string;
  source: string;
  verifiedAt: string;
};

/** The kinds of visual a question can be answered with. */
export const VISUAL_KINDS = [
  "profile",
  "education",
  "skills",
  "project",
  "architecture",
  "flow",
  "data-model",
  "code",
  "comparison",
  "metrics",
  "claims",
  "contact",
] as const satisfies readonly VisualSpec["kind"][];

export type ChatMessage = {
  id: string;
  role: ChatRole;
  text: string;
  visual?: VisualSpec;
  evidence?: string[];
  followUps?: string[];
  /** Set while the answer is still streaming in. */
  pending?: boolean;
  /** The confidence the server assigned to this answer. */
  confidence?: "high" | "medium" | "low";
  /** Honest caveats attached to the answer. */
  caveats?: string[];
};

/**
 * A citation into the source index.
 *
 * `path` and the line range are resolved SERVER-SIDE against the pinned
 * commit before the answer is emitted, so a model cannot invent a line
 * number: an unresolvable reference is dropped and the answer's confidence is
 * downgraded.
 */
export type EvidenceRef = {
  projectId: string;
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  /**
   * The exact source lines the answer relied on.
   *
   * The validator re-reads the index and compares this against the file at
   * [startLine, endLine]. A citation whose quote does not match is dropped,
   * so a model cannot invent a line number and keep the citation.
   */
  quote?: string;
  /** A short human-readable label, e.g. "src/ai_engine.py:59". */
  label: string;
  /** True when the reference was verified against the pinned commit. */
  verified: boolean;
};

export type DemoAnswer = {
  text: string;
  visual?: VisualSpec;
  evidence?: string[];
  followUps?: string[];
};
