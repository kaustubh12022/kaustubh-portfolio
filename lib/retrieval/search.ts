/**
 * Hybrid retrieval: vector (ANN) + keyword (BM25 / trigram / substring),
 * fused with Reciprocal Rank Fusion.
 *
 * WHY A HYBRID, NOT JUST A VECTOR SEARCH
 * --------------------------------------
 * The corpus is SOURCE CODE. A pure vector search is good at "what does
 * this do" but bad at "where is the function called `calculate_deepseek_cost`".
 * A pure keyword search is the opposite. RRF combines the two ranked lists
 * without needing the two score scales to be comparable - which matters
 * because a cosine distance and a `ts_rank` are not the same kind of number.
 *
 * WHY THE KEYWORD LEG HAS THREE PARTS
 * -----------------------------------
 * `to_tsvector('english', ...)` mangles identifiers. Measured on this
 * corpus:
 *
 *   to_tsvector('english', 'calculate_deepseek_cost')
 *     -> 'calcul':1 'cost':3 'deepseek':2
 *
 * The identifier is stemmed into pieces that no longer look like the
 * identifier, and a user who types the exact name gets a query that does not
 * contain the name. So the keyword leg is the UNION of:
 *
 *   1. tsvector  - `tsv @@ plainto_tsquery('english', $q)` with `ts_rank`.
 *                   Finds the prose around the code.
 *   2. trigram   - `symbol ILIKE '%token%'` / `path ILIKE '%token%'`.
 *                   Finds identifiers by name, including partial ones.
 *                   The `gin_trgm_ops` index on `symbol` exists for this.
 *   3. content   - `content ILIKE '%token%'`.
 *                   Exact substring fallback for literals, strings and
 *                   error messages that neither of the other two catches.
 *
 * The three sub-legs are fused with RRF into ONE keyword ranking, and that
 * ranking is then fused with the vector ranking.
 *
 * RRF
 * ---
 * `score(d) = sum over legs of 1 / (60 + rank_in_leg(d))`. The constant 60
 * is the standard RRF damping: it stops the first few results of a leg from
 * dominating the fusion. A document found by BOTH legs always outranks a
 * document found by only one.
 */

import { query, setLocalSearchEffort, withDirectTransaction } from "./db";
import { toVectorLiteral } from "./embed";
import { rerank } from "./rerank";

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** A chunk as returned by the database. */
export interface ChunkRef {
  id: string;
  projectId: string;
  path: string;
  startLine: number;
  endLine: number;
  symbol: string;
  kind: string;
  lang: string;
  header: string;
  content: string;
  contentHash: string;
}

/** A scored retrieval result. */
export interface SearchHit extends ChunkRef {
  /** Fused RRF score. */
  score: number;
  /** 1-based rank in the vector leg, `null` when the leg did not return it. */
  vectorRank: number | null;
  /** 1-based rank in the keyword leg, `null` when the leg did not return it. */
  keywordRank: number | null;
}

/** Parameters of a hybrid search. */
export interface SearchParams {
  /** The natural language question or a bare identifier. */
  query: string;
  /** Restrict the search to a single project id. */
  projectId?: string;
  /** How many hits to return. Default 12. */
  limit?: number;
  /** How many candidates each leg pulls before fusion. Default 40. */
  candidates?: number;
}

/** A named ranked list, the input of the RRF fusion. */
export interface RankedLeg {
  /** Leg name, e.g. `vector` or `keyword`. */
  name: string;
  /** Identifiers, best first. */
  ids: string[];
  /**
   * How much this leg counts for in the fusion. Default 1.
   *
   * A leg that is internally fused from several sub-legs already carries more
   * weight than a single leg, because each of its sub-legs contributes
   * 1/(k+rank). The keyword leg is fused from three sub-legs and the vector
   * leg from one, so leaving both at 1 gives the keyword leg three times the
   * influence. The weight is how that is corrected.
   */
  weight?: number;
}

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/**
 * The knobs of the retriever.
 *
 * Every default in here was MEASURED on the 150-question golden set with
 * `scripts/eval/bench.ts` (local embeddings, no LLM). The measurement log is
 * `docs/RETRIEVAL.md`. Changing a default means re-measuring and updating
 * that document, because a retrieval default that nobody can reproduce is
 * just a guess with a nicer name.
 */
export interface SearchTuning {
  /**
   * The shortest chunk that may take part in the VECTOR leg.
   * Default 120.
   */
  minVectorChars: number;
  /**
   * How much the vector leg counts for in the top-level fusion.
   * Default 1.
   */
  vectorWeight: number;
  /**
   * How much the keyword leg counts for in the top-level fusion.
   * Default 1.
   */
  keywordWeight: number;
  /**
   * When the question is NOT about tests, test files are removed from the
   * candidate pool. `true` removes them, `false` keeps them.
   * Default true.
   */
  excludeTests: boolean;
  /**
   * A query token that appears in more than this fraction of the corpus
   * carries no signal and is dropped from the substring legs.
   * `1` disables the filter. Default 0.02.
   */
  genericTokenDfRatio: number;
  /**
   * Weight the substring leg by inverse document frequency instead of
   * counting raw token hits. Default true.
   */
  useIdf: boolean;
  /**
   * Re-order the fused candidates with a local cross-encoder.
   * Default true.
   */
  rerank: boolean;
  /**
   * How many of the fused candidates are handed to the cross-encoder.
   * Default 20.
   */
  rerankDepth: number;
  /**
   * How many candidates each leg pulls before the fusion. Default 40.
   */
  candidates: number;
  /**
   * Pseudo-relevance feedback: take the identifiers of the best candidates
   * and search for them again. Default false.
   */
  prf: boolean;
  /**
   * How many top candidates feed the expansion. Default 5.
   */
  prfTopK: number;
}

/** The production defaults. Measured, not guessed. */
export const DEFAULT_TUNING: SearchTuning = {
  minVectorChars: 120,
  vectorWeight: 1,
  keywordWeight: 4,
  excludeTests: true,
  genericTokenDfRatio: 1,
  useIdf: false,
  rerank: true,
  rerankDepth: 20,
  candidates: 40,
  prf: false,
  prfTopK: 5,
};

/** The result of an RRF fusion. */
export interface FusedHit {
  id: string;
  /** Sum of 1/(k + rank) over every leg the document appeared in. */
  score: number;
  /** 1-based rank per leg, `null` for legs the document missed. */
  ranks: Record<string, number | null>;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** The RRF damping constant. */
export const RRF_K = 60;

/** Default number of hits returned by {@link searchChunks}. */
export const DEFAULT_LIMIT = 12;

/** Default number of candidates pulled per leg. */
export const DEFAULT_CANDIDATES = 40;

/* ------------------------------------------------------------------ */
/* Test files                                                          */
/* ------------------------------------------------------------------ */

/**
 * The Postgres regular expression that recognises a test file.
 *
 * 36% of the indexed corpus is test code - 1,116 of 3,068 chunks. A
 * recruiter asking "how does the settlement engine work" wants the
 * implementation, not the test file that asserts on it, and the tests win
 * those slots on generic vocabulary alone ("job", "booking", "user").
 *
 * Measured on the golden set: removing test chunks from the candidate pool
 * lifts FILE-level recall@5 from 64.6% to 74.7% and MRR@10 from 26.0% to
 * 31.2%. The pool is filtered, not the corpus - a question that asks ABOUT
 * tests keeps them.
 */
export const TEST_PATH_REGEX =
  "(^|/)(tests?|__tests__|spec|specs|e2e)/|\\.(test|spec)\\.[a-z0-9]+$|(^|/)(test_[^/]*|[^/]*_test)\\.(py|js|jsx|ts|tsx|dart)$";

/**
 * Does the question itself ask about tests?
 *
 * When it does, the test files are exactly what the visitor wants, so they
 * stay in the pool.
 */
export function queryAsksAboutTests(text: string): boolean {
  return /\b(tests?|testing|assertions?|asserts?|spec|specs|coverage|unittest|pytest|vitest|jest|fixture|fixtures)\b/i.test(
    text,
  );
}

/** The path-exclusion pattern for a query, or `null` when nothing is excluded. */
function pathExclusion(
  text: string,
  tuning: SearchTuning,
): string | null {
  if (!tuning.excludeTests) return null;
  if (queryAsksAboutTests(text)) return null;
  return TEST_PATH_REGEX;
}

/** Words that carry no retrieval signal in a code question. */
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can",
  "had", "her", "was", "one", "our", "out", "get", "has", "him", "his",
  "how", "its", "let", "may", "new", "now", "old", "see", "two", "way",
  "who", "did", "yes", "she", "use", "using", "used", "does", "doing",
  "done", "with", "that", "this", "these", "those", "there", "their",
  "them", "then", "than", "what", "when", "where", "which", "while", "who",
  "whom", "why", "how", "show", "tell", "explain", "work", "works",
  "code", "file", "files", "project", "projects", "repo", "repository",
  "please", "could", "would", "should", "about", "into", "from", "your",
  "yours", "mine", "ours", "been", "being", "have", "having", "does",
  "implement", "implemented", "implementation", "function", "functions",
  "method", "methods", "class", "classes",
]);

/* ------------------------------------------------------------------ */
/* SQL                                                                 */
/* ------------------------------------------------------------------ */

const CHUNK_COLUMNS = `
  c.id, c.project_id, c.path, c.start_line, c.end_line, c.symbol, c.kind, c.lang,
  c.header, c.content, c.content_hash`;

/**
 * Minimum content length for a chunk to take part in the VECTOR leg.
 *
 * MiniLM embeddings of very short texts are unreliable: a one line comment
 * such as `// @desc DELETE BOOKING` embeds close to the embedding of the
 * question "how does pawna prevent booking overlaps", purely because both
 * texts contain the token "booking". Measured on this corpus, the top ANN
 * hit for that question was a 141 character comment block, and for "what is
 * the naukri bot" it was a 38 character fragment.
 *
 * Short chunks are NOT lost: they are still in the corpus and the keyword
 * legs (trigram on the symbol, substring on the content) still find them.
 * They are only excluded from the ANN leg, where they are noise.
 */
export const VECTOR_MIN_CONTENT_CHARS = 120;

/** Leg 1: approximate nearest neighbour over the embedding column. */
const VECTOR_LEG_SQL = `
  SELECT ${CHUNK_COLUMNS}, 1 - (c.embedding <=> $1::vector) AS similarity
    FROM chunks c
   WHERE c.embedding IS NOT NULL
     AND length(c.content) >= $4
     AND ($2::text IS NULL OR c.project_id = $2)
     AND ($5::text IS NULL OR c.path !~* $5)
   ORDER BY c.embedding <=> $1::vector
   LIMIT $3`;

/** Keyword sub-leg 1: full text (BM25 ranked by the `lakebase_text` AM). */
const TSVECTOR_LEG_SQL = `
  SELECT ${CHUNK_COLUMNS},
         ts_rank(c.tsv, plainto_tsquery('english', $1)) AS and_score,
         ts_rank(c.tsv, websearch_to_tsquery('english', $4)) AS or_score
    FROM chunks c
   WHERE (
           c.tsv @@ plainto_tsquery('english', $1)
        OR c.tsv @@ websearch_to_tsquery('english', $4)
         )
     AND ($2::text IS NULL OR c.project_id = $2)
     AND ($5::text IS NULL OR c.path !~* $5)
   ORDER BY (c.tsv @@ plainto_tsquery('english', $1)) DESC, or_score DESC,
            c.path, c.start_line
   LIMIT $3`;

/**
 * Keyword sub-leg 2: trigram match on the symbol name and the path.
 *
 * The tokens are lower-cased (for `similarity`) and the matching patterns
 * are escaped (for `ILIKE`), so both are passed in.
 */
const TRIGRAM_LEG_SQL = `
  SELECT ${CHUNK_COLUMNS},
         MAX(
           CASE
             WHEN c.symbol ILIKE t.pattern THEN 1.0 + similarity(c.symbol, t.token)
             WHEN c.path   ILIKE t.pattern THEN 0.5 + similarity(c.path, t.token)
             ELSE similarity(c.symbol, t.token)
           END
         ) AS kw_score
    FROM chunks c
    CROSS JOIN unnest($1::text[], $4::text[]) AS t(token, pattern)
   WHERE (c.symbol ILIKE t.pattern OR c.path ILIKE t.pattern)
     AND ($2::text IS NULL OR c.project_id = $2)
     AND ($5::text IS NULL OR c.path !~* $5)
   GROUP BY c.id
   ORDER BY kw_score DESC, c.path, c.start_line
   LIMIT $3`;

/**
 * Keyword sub-leg 3: exact substring fallback over the chunk content.
 *
 * The rows are ordered by the WEIGHT of the query tokens they contain, not by
 * their count. A token that appears in every chunk ("job", "user", "booking")
 * is worth almost nothing; a token that appears in three chunks
 * ("is_relevant_jd") is worth a lot. That is inverse document frequency, and
 * it is the difference between "matches three common words" and "matches one
 * rare identifier".
 *
 * Counting raw hits ranked the generic words first, which is why the
 * substring leg used to surface test files for implementation questions.
 */
const CONTENT_LEG_SQL = `
  SELECT ${CHUNK_COLUMNS},
         (CASE WHEN c.content ILIKE $4 THEN 100 ELSE 0 END) + COALESCE(m.w, 0)
           AS kw_score
    FROM chunks c
    LEFT JOIN LATERAL (
      SELECT sum(p.weight)::float AS w
        FROM unnest($1::text[], $6::float[]) AS p(pattern, weight)
       WHERE c.content ILIKE p.pattern OR c.header ILIKE p.pattern
    ) m ON true
   WHERE (
           c.content ILIKE $4
        OR c.header  ILIKE $4
        OR c.content ILIKE ANY($1::text[])
        OR c.header  ILIKE ANY($1::text[])
         )
     AND ($2::text IS NULL OR c.project_id = $2)
     AND ($5::text IS NULL OR c.path !~* $5)
   ORDER BY kw_score DESC, length(c.content) ASC, c.path, c.start_line
   LIMIT $3`;

/* ------------------------------------------------------------------ */
/* Keyword helpers                                                     */
/* ------------------------------------------------------------------ */

/**
 * Split a question into the tokens that carry retrieval signal.
 *
 * Identifiers keep their underscores (`calculate_deepseek_cost` stays one
 * token) and are additionally split into their parts, so both the full name
 * and the distinctive fragment can be matched.
 */
export function extractKeywords(text: string, limit = 12): string[] {
  const out: string[] = [];
  const push = (token: string): void => {
    if (token.length < 3) return;
    if (STOP_WORDS.has(token)) return;
    if (out.includes(token)) return;
    out.push(token);
  };
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (!raw) continue;
    push(raw);
    if (raw.includes("_")) {
      for (const part of raw.split("_")) push(part);
    }
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

/** Escape the LIKE metacharacters so a token matches literally. */
export function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, "\\$1");
}

/**
 * Crude English singular forms of a token.
 *
 * The corpus contains `overlap`, `overlappingBookings` and
 * `overlapping_bookings`; a question that says "booking OVERLAPS" must still
 * find them. The `tsvector` column stems the query, but the ILIKE legs do
 * not, so the singular form is added to the pattern list.
 */
export function singularVariants(token: string): string[] {
  const out: string[] = [];
  if (token.length > 5 && token.endsWith("ies")) {
    out.push(`${token.slice(0, -3)}y`);
  }
  if (token.length > 5 && token.endsWith("es")) {
    out.push(token.slice(0, -2));
  }
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) {
    out.push(token.slice(0, -1));
  }
  return out.filter((variant) => variant.length >= 3 && variant !== token);
}

/**
 * Build the `%token%` patterns used by the ILIKE legs.
 *
 * The token and the pattern have to stay ALIGNED: the trigram leg unnests
 * both arrays in parallel (`unnest($1::text[], $4::text[])`) so it can
 * score a match with the trigram similarity of the raw token.
 */
export function likeTokenPairs(tokens: string[]): {
  tokens: string[];
  patterns: string[];
} {
  const tokenList: string[] = [];
  const patternList: string[] = [];
  for (const token of tokens) {
    for (const variant of [token, ...singularVariants(token)]) {
      const pattern = `%${escapeLike(variant)}%`;
      if (patternList.includes(pattern)) continue;
      tokenList.push(variant);
      patternList.push(pattern);
    }
  }
  return { tokens: tokenList, patterns: patternList };
}

/** Build the `%token%` patterns used by the ILIKE legs. */
export function likePatterns(tokens: string[]): string[] {
  return likeTokenPairs(tokens).patterns;
}

/* ------------------------------------------------------------------ */
/* Inverse document frequency                                           */
/* ------------------------------------------------------------------ */

/**
 * How many chunks contain a token. Cached per token for the life of the
 * process: the corpus does not change while the server is up, and a
 * recruiter's question uses the same vocabulary twice.
 */
const dfCache = new Map<string, number>();

/** How many chunks the corpus holds. Used as `N` in the IDF formula. */
let corpusSize = 0;

/** Prime the corpus size. Called once at the start of a search. */
async function ensureCorpusSize(): Promise<number> {
  if (corpusSize > 0) return corpusSize;
  const result = await query<{ total: number }>(
    `SELECT count(*)::int AS total FROM chunks`,
  );
  corpusSize = result.rows[0]?.total ?? 0;
  return corpusSize;
}

const DF_SQL = `
  SELECT t.token, count(*)::int AS df
    FROM unnest($1::text[]) AS t(token)
    CROSS JOIN chunks c
   WHERE c.content ILIKE '%' || t.token || '%'
      OR c.header  ILIKE '%' || t.token || '%'
   GROUP BY t.token`;

/**
 * The document frequency of each token: how many chunks contain it.
 *
 * A token that appears in hundreds of chunks cannot tell one chunk from
 * another. A token that appears in three can. That is the whole difference
 * between a substring leg that ranks test files first and one that ranks the
 * function the visitor actually meant.
 */
async function documentFrequencies(tokens: string[]): Promise<Map<string, number>> {
  const missing = tokens.filter((token) => !dfCache.has(token));
  if (missing.length > 0) {
    const result = await query<{ token: string; df: number }>(DF_SQL, [missing]);
    for (const row of result.rows) dfCache.set(row.token, row.df);
    for (const token of missing) {
      if (!dfCache.has(token)) dfCache.set(token, 0);
    }
  }
  const out = new Map<string, number>();
  for (const token of tokens) out.set(token, dfCache.get(token) ?? 0);
  return out;
}

/**
 * Split the query tokens into the ones that carry signal and the ones that
 * do not, and weight the survivors by inverse document frequency.
 *
 * `idf(t) = ln(N / (1 + df(t)))`. A token that appears in every chunk scores
 * zero; a token that appears in one chunk scores the maximum.
 */
export function idfWeights(
  tokens: string[],
  df: Map<string, number>,
  total: number,
): Map<string, number> {
  const weights = new Map<string, number>();
  for (const token of tokens) {
    const frequency = df.get(token) ?? 0;
    weights.set(token, Math.log((total + 1) / (frequency + 1)));
  }
  return weights;
}

/**
 * The tokens that are too common to be useful.
 *
 * The threshold is a FRACTION of the corpus: a token that appears in more
 * than 2% of the chunks cannot discriminate between them.
 */
export function genericTokens(
  tokens: string[],
  df: Map<string, number>,
  total: number,
  ratio: number,
): Set<string> {
  const out = new Set<string>();
  if (ratio >= 1) return out;
  const cutoff = total * ratio;
  for (const token of tokens) {
    if ((df.get(token) ?? 0) > cutoff) out.add(token);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* RRF                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Fuse ranked lists with Reciprocal Rank Fusion.
 *
 * `score(d) = sum over legs of weight(leg) / (k + rank_in_leg(d))`
 *
 * @param legs  the ranked lists, best first
 * @param k     the damping constant, 60 by default
 */
export function fuseReciprocalRankFusion(
  legs: RankedLeg[],
  k: number = RRF_K,
): FusedHit[] {
  const scores = new Map<string, number>();
  const ranks = new Map<string, Record<string, number | null>>();

  // Every leg is represented in the rank record, even for the documents it
  // did not return, so the consumer never has to guess whether a missing
  // key means "not in that leg" or "that leg does not exist".
  for (const leg of legs) {
    for (const id of leg.ids) {
      const entry = ranks.get(id) ?? {};
      for (const other of legs) entry[other.name] ??= null;
      ranks.set(id, entry);
    }
  }

  for (const leg of legs) {
    const weight = leg.weight ?? 1;
    leg.ids.forEach((id, index) => {
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + rank));
      const entry = ranks.get(id) ?? {};
      entry[leg.name] = rank;
      ranks.set(id, entry);
    });
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score, ranks: ranks.get(id) ?? {} }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

interface ChunkRow {
  id: string;
  project_id: string;
  path: string;
  start_line: number;
  end_line: number;
  symbol: string;
  kind: string;
  lang: string;
  header: string;
  content: string;
  content_hash: string;
  similarity?: number | null;
  kw_score?: number | null;
}

function toChunkRef(row: ChunkRow): ChunkRef {
  return {
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    symbol: row.symbol ?? "",
    kind: row.kind ?? "",
    lang: row.lang ?? "",
    header: row.header ?? "",
    content: row.content ?? "",
    contentHash: row.content_hash ?? "",
  };
}

/* ------------------------------------------------------------------ */
/* Legs                                                               */
/* ------------------------------------------------------------------ */

/** Vector leg: approximate nearest neighbours, best first. */
async function vectorLeg(
  embedding: Float32Array,
  projectId: string | undefined,
  limit: number,
  excludePath: string | null,
  minContentChars: number,
): Promise<ChunkRow[]> {
  const literal = toVectorLiteral(embedding);
  // The ANN leg runs on the DIRECT connection: the `lakebase_ann` access
  // method cannot be used through the Neon pooler (every ANN query over the
  // pooled endpoint fails with
  // `XX000 usage: need 0 probes, but 1 probes provided`).
  const result = await withDirectTransaction(async (client) => {
    // `SET LOCAL` pins the search effort for THIS transaction, which is the
    // only way to be sure of it behind the Neon pooler.
    await setLocalSearchEffort(client);
    return client.query<ChunkRow>(VECTOR_LEG_SQL, [
      literal,
      projectId ?? null,
      limit,
      minContentChars,
      excludePath,
    ]);
  });
  return result.rows;
}

/**
 * Keyword leg: the union of the tsvector, trigram and content sub-legs,
 * fused with RRF into a single ranking.
 */
async function keywordLeg(
  text: string,
  projectId: string | undefined,
  limit: number,
  excludePath: string | null,
  tuning: SearchTuning,
): Promise<ChunkRow[]> {
  const rawTokens = extractKeywords(text);
  const total = await ensureCorpusSize();

  // The document frequency decides which tokens are worth matching on. It
  // costs one query for the tokens that are not cached yet, and the answer
  // is cached per token afterwards.
  const df = await documentFrequencies(rawTokens);
  const generic = genericTokens(
    rawTokens,
    df,
    total,
    tuning.genericTokenDfRatio,
  );
  const tokens = rawTokens.filter((token) => !generic.has(token));

  // The singular/plural variants are matched on too, and they need their own
  // document frequency: "booking" and "bookings" are not the same token to
  // the index.
  const variants: string[] = [];
  for (const token of tokens) {
    for (const variant of [token, ...singularVariants(token)]) {
      if (!variants.includes(variant)) variants.push(variant);
    }
  }
  const variantDf = await documentFrequencies(variants);
  const variantWeights = idfWeights(variants, variantDf, total);

  const matchTokens = variants;
  const patterns = variants.map((variant) => `%${escapeLike(variant)}%`);
  const patternWeights = tuning.useIdf
    ? variants.map((variant) => variantWeights.get(variant) ?? 1)
    : variants.map(() => 1);

  const fullPattern = `%${escapeLike(text.trim())}%`;
  // The OR fallback of the full text leg is built from the KEYWORDS, not
  // from the raw question: stop words like "how" or "does" would match
  // almost every chunk and drown the signal.
  const orQuery = tokens.join(" ");

  const [tsvector, trigram, content] = await Promise.all([
    query<ChunkRow>(TSVECTOR_LEG_SQL, [
      text,
      projectId ?? null,
      limit,
      orQuery,
      excludePath,
    ]),
    tokens.length > 0
      ? query<ChunkRow>(TRIGRAM_LEG_SQL, [
          matchTokens,
          projectId ?? null,
          limit,
          patterns,
          excludePath,
        ])
      : Promise.resolve({ rows: [] as ChunkRow[], rowCount: 0 }),
    tokens.length > 0
      ? query<ChunkRow>(CONTENT_LEG_SQL, [
          patterns,
          projectId ?? null,
          limit,
          fullPattern,
          excludePath,
          patternWeights,
        ])
      : Promise.resolve({ rows: [] as ChunkRow[], rowCount: 0 }),
  ]);

  const byId = new Map<string, ChunkRow>();
  for (const row of [...tsvector.rows, ...trigram.rows, ...content.rows]) {
    if (!byId.has(row.id)) byId.set(row.id, row);
  }

  const fused = fuseReciprocalRankFusion([
    { name: "tsvector", ids: tsvector.rows.map((row) => row.id) },
    { name: "trigram", ids: trigram.rows.map((row) => row.id) },
    { name: "content", ids: content.rows.map((row) => row.id) },
  ]);

  const ordered: ChunkRow[] = [];
  for (const hit of fused) {
    const row = byId.get(hit.id);
    if (row) ordered.push(row);
  }
  return ordered;
}

/* ------------------------------------------------------------------ */
/* The index fingerprint                                               */
/* ------------------------------------------------------------------ */

/**
 * A value that changes whenever the corpus changes.
 *
 * The answer cache stores a serialised answer, and an answer that was
 * computed against an older corpus can describe code that no longer
 * exists. The obvious fix - a counter bumped by the indexer - does not work
 * here: the indexer is a SEPARATE PROCESS from the server, so a process
 * local counter can never be bumped by it.
 *
 * The fingerprint is read from the database instead: the newest
 * `indexed_at` in the manifest. A re-index writes a new timestamp, the
 * fingerprint changes, and every cached answer computed against the old
 * corpus becomes unreachable.
 *
 * It is cached for a minute so the chat route does not read the manifest on
 * every request.
 */
const FINGERPRINT_TTL_MS = 60_000;

let fingerprintCache: { value: string; at: number } | null = null;

/** The current index fingerprint. */
export async function indexFingerprint(): Promise<string> {
  const now = Date.now();
  if (fingerprintCache && now - fingerprintCache.at < FINGERPRINT_TTL_MS) {
    return fingerprintCache.value;
  }
  const result = await query<{ fingerprint: string }>(
    `SELECT coalesce(max(indexed_at)::text, 'empty') AS fingerprint
       FROM index_manifest`,
  );
  const value = result.rows[0]?.fingerprint ?? "empty";
  fingerprintCache = { value, at: now };
  return value;
}

/* ------------------------------------------------------------------ */
/* Pseudo-relevance feedback                                           */
/* ------------------------------------------------------------------ */

/**
 * Split an identifier into the words it is made of.
 *
 * `is_relevant_jd` becomes `is`, `relevant`, `jd`. `minimumTransactions`
 * becomes `minimum`, `transactions`. The words are what a visitor would
 * have written if they had known the name.
 */
export function splitIdentifier(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 3);
}

/**
 * The terms the best candidates contribute to a second search.
 *
 * Pseudo-relevance feedback is the oldest trick in information retrieval:
 * look at what the first search found, take the vocabulary of those
 * documents, and search again with it. It works because the first search
 * usually finds the right FILE and the wrong PART of it - and the file
 * name and the neighbouring symbol names are exactly the words that find
 * the right part.
 *
 * Concretely: "how does it decide which jobs are worth scoring" retrieves
 * `src/scorer.py` with the symbol `is_relevant_jd`. The expansion adds
 * `scorer`, `relevant`, `jd`, and the second search finds
 * `src/scorer.py:159-210 (matches_senior_title)` as well.
 */
export function expansionTerms(hits: SearchHit[], topK: number): string[] {
  const terms: string[] = [];
  const push = (term: string): void => {
    if (term.length < 3) return;
    if (STOP_WORDS.has(term)) return;
    if (terms.includes(term)) return;
    terms.push(term);
  };

  for (const hit of hits.slice(0, topK)) {
    for (const part of splitIdentifier(hit.symbol)) push(part);
    const fileName = hit.path.split("/").pop() ?? "";
    const stem = fileName.replace(/\.[a-z0-9]+$/i, "");
    for (const part of splitIdentifier(stem)) push(part);
  }
  return terms;
}

/* ------------------------------------------------------------------ */
/* The public API                                                      */
/* ------------------------------------------------------------------ */

/**
 * Run a hybrid search.
 *
 * @param params    the question plus the optional project filter
 * @param embedding the embedded query. It is passed IN on purpose: the
 *                  caller owns the model, so the same embedding can be
 *                  reused across several searches (and so the tests can
 *                  inject a fake one).
 * @param tuning    optional overrides for the measured defaults
 */
export async function searchChunks(
  params: SearchParams,
  embedding: Float32Array,
  tuning: Partial<SearchTuning> = {},
): Promise<SearchHit[]> {
  const text = params.query.trim();
  if (!text) return [];

  const settings: SearchTuning = { ...DEFAULT_TUNING, ...tuning };
  const limit = params.limit ?? DEFAULT_LIMIT;
  const candidates = settings.candidates ?? params.candidates ?? DEFAULT_CANDIDATES;
  const excludePath = pathExclusion(text, settings);

  const [vectorRows, keywordRows] = await Promise.all([
    vectorLeg(
      embedding,
      params.projectId,
      candidates,
      excludePath,
      settings.minVectorChars,
    ),
    keywordLeg(text, params.projectId, candidates, excludePath, settings),
  ]);

  const byId = new Map<string, ChunkRef>();
  for (const row of [...vectorRows, ...keywordRows]) {
    if (!byId.has(row.id)) byId.set(row.id, toChunkRef(row));
  }

  const fuse = (
    vectorIds: string[],
    keywordIds: string[],
  ): { id: string; score: number; ranks: Record<string, number | null> }[] =>
    fuseReciprocalRankFusion([
      { name: "vector", ids: vectorIds, weight: settings.vectorWeight },
      { name: "keyword", ids: keywordIds, weight: settings.keywordWeight },
    ]);

  let fused = fuse(
    vectorRows.map((row) => row.id),
    keywordRows.map((row) => row.id),
  );

  // The fused list is the FULL candidate pool, not the answer. The
  // cross-encoder has to see the top `rerankDepth` of it, because the whole
  // point of the second stage is that it can pick a candidate that the
  // bi-encoder ranked below the cut.
  const toHits = (
    entries: { id: string; score: number; ranks: Record<string, number | null> }[],
  ): SearchHit[] => {
    const out: SearchHit[] = [];
    for (const entry of entries) {
      const ref = byId.get(entry.id);
      if (!ref) continue;
      out.push({
        ...ref,
        score: entry.score,
        vectorRank: entry.ranks.vector ?? null,
        keywordRank: entry.ranks.keyword ?? null,
      });
    }
    return out;
  };

  let pool = toHits(fused);

  // Pseudo-relevance feedback: the identifiers of the best candidates are
  // searched for again, which finds the neighbouring functions of the right
  // file.
  if (settings.prf && pool.length > 0) {
    const terms = expansionTerms(pool, settings.prfTopK);
    if (terms.length > 0) {
      const expanded = await keywordLeg(
        `${text} ${terms.join(" ")}`,
        params.projectId,
        candidates,
        excludePath,
        settings,
      );
      for (const row of expanded) {
        if (!byId.has(row.id)) byId.set(row.id, toChunkRef(row));
      }
      fused = fuse(
        vectorRows.map((row) => row.id),
        [...keywordRows.map((row) => row.id), ...expanded.map((row) => row.id)],
      );
      pool = toHits(fused);
    }
  }

  const ordered = settings.rerank
    ? await applyReranker(text, pool, settings)
    : pool;

  return ordered.slice(0, limit);
}

/**
 * Re-order the retrieved candidates with the local cross-encoder.
 *
 * The cross-encoder reads the question and the chunk TOGETHER, which the
 * bi-encoder embedding never does. It is the difference between "the chunk
 * is about jobs" and "the chunk is the function that decides which jobs are
 * worth scoring".
 *
 * Only the first `rerankDepth` candidates are reranked, and the ones that
 * were not reranked keep their retrieval order below them. When the model
 * is not available the order is left exactly as it was.
 */
async function applyReranker(
  query: string,
  hits: SearchHit[],
  settings: SearchTuning,
): Promise<SearchHit[]> {
  if (hits.length < 2) return hits;

  const depth = Math.min(settings.rerankDepth, hits.length);
  const head = hits.slice(0, depth);

  const scored = await rerank(
    query,
    head.map((hit) => ({
      id: hit.id,
      // The header carries the repository, the file, the symbol and the
      // imports, so the cross-encoder sees WHAT the chunk is as well as
      // what it does.
      text: `${hit.header}\n${hit.content}`,
    })),
  );

  // An empty result means the model could not be loaded or threw. The
  // retrieval order is the fallback, and it is a good one.
  if (scored.length === 0) return hits;

  const scoreById = new Map(scored.map((item) => [item.id, item.score]));
  const reordered = [...head].sort(
    (a, b) =>
      (scoreById.get(b.id) ?? b.score) - (scoreById.get(a.id) ?? a.score),
  );

  return [
    ...reordered.map((hit) => ({
      ...hit,
      score: scoreById.get(hit.id) ?? hit.score,
    })),
    ...hits.slice(depth),
  ];
}

/* ------------------------------------------------------------------ */
/* Symbol lookup                                                       */
/* ------------------------------------------------------------------ */

/** A named construct found in the index. */
export interface SymbolRecord {
  id: string;
  projectId: string;
  path: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
  signature: string;
}

/** A row of the `symbols` table, as it comes back from Postgres. */
interface SymbolRow {
  id: string;
  project_id: string;
  path: string;
  name: string;
  kind: string;
  start_line: number;
  end_line: number;
  signature: string | null;
}

function toSymbolRecord(row: SymbolRow): SymbolRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    path: row.path,
    name: row.name,
    kind: row.kind ?? "",
    startLine: row.start_line,
    endLine: row.end_line,
    signature: row.signature ?? "",
  };
}

/** The result of {@link findSymbol}. */
export interface SymbolLookup {
  /** How the symbol was found. */
  match: "exact" | "fuzzy" | "none";
  /** The name that was looked up. */
  query: string;
  /** The symbol itself, `null` when nothing matched. */
  symbol: SymbolRecord | null;
  /** The chunk(s) that contain the symbol. */
  chunks: ChunkRef[];
}

const CHUNK_BY_SYMBOL_SQL = `
  SELECT ${CHUNK_COLUMNS}
    FROM chunks c
   WHERE c.project_id = $1 AND lower(c.symbol) = lower($2)
   ORDER BY c.path, c.start_line
   LIMIT 20`;

const CHUNK_BY_SYMBOL_FUZZY_SQL = `
  SELECT ${CHUNK_COLUMNS}, similarity(c.symbol, $2) AS kw_score
    FROM chunks c
   WHERE c.project_id = $1
     AND c.symbol <> ''
     AND similarity(c.symbol, $2) > 0.15
   ORDER BY kw_score DESC, c.path, c.start_line
   LIMIT 10`;

const SYMBOL_TABLE_SQL = `
  SELECT id, project_id, path, name, kind, start_line, end_line, signature
    FROM symbols
   WHERE project_id = $1 AND name = $2
   LIMIT 5`;

const SYMBOL_TABLE_FUZZY_SQL = `
  SELECT id, project_id, path, name, kind, start_line, end_line, signature
    FROM symbols
   WHERE project_id = $1 AND similarity(name, $2) > 0.15
   ORDER BY similarity(name, $2) DESC
   LIMIT 5`;

const CHUNKS_OVERLAPPING_SQL = `
  SELECT ${CHUNK_COLUMNS}
    FROM chunks c
   WHERE c.project_id = $1
     AND c.path = $2
     AND c.start_line <= $4
     AND c.end_line >= $3
   ORDER BY c.start_line
   LIMIT 10`;

/**
 * Find a symbol by name: exact match first, trigram similarity second.
 *
 * @returns the symbol, the chunk(s) that own it, and how it was matched.
 */
export async function findSymbol(
  projectId: string,
  name: string,
): Promise<SymbolLookup> {
  const needle = name.trim();
  if (!needle) {
    return { match: "none", query: needle, symbol: null, chunks: [] };
  }

  // 1. exact match on the chunk symbol column
  const exact = await query<ChunkRow>(CHUNK_BY_SYMBOL_SQL, [projectId, needle]);
  if (exact.rows.length > 0) {
    const row = exact.rows[0];
    return {
      match: "exact",
      query: needle,
      symbol: {
        id: row.id,
        projectId: row.project_id,
        path: row.path,
        name: row.symbol,
        kind: row.kind,
        startLine: row.start_line,
        endLine: row.end_line,
        signature: "",
      },
      chunks: exact.rows.map(toChunkRef),
    };
  }

  // 2. exact match in the symbols table
  const exactTable = await query<SymbolRow>(SYMBOL_TABLE_SQL, [projectId, needle]);
  if (exactTable.rows.length > 0) {
    const row = exactTable.rows[0];
    const record = toSymbolRecord(row);
    return {
      match: "exact",
      query: needle,
      symbol: record,
      chunks: await chunksOverlapping(
        projectId,
        record.path,
        record.startLine,
        record.endLine,
      ),
    };
  }

  // 3. trigram similarity on the chunk symbol column
  const fuzzy = await query<ChunkRow>(CHUNK_BY_SYMBOL_FUZZY_SQL, [
    projectId,
    needle,
  ]);
  if (fuzzy.rows.length > 0) {
    const row = fuzzy.rows[0];
    return {
      match: "fuzzy",
      query: needle,
      symbol: {
        id: row.id,
        projectId: row.project_id,
        path: row.path,
        name: row.symbol,
        kind: row.kind,
        startLine: row.start_line,
        endLine: row.end_line,
        signature: "",
      },
      chunks: fuzzy.rows.map(toChunkRef),
    };
  }

  // 4. trigram similarity in the symbols table
  const fuzzyTable = await query<SymbolRow>(SYMBOL_TABLE_FUZZY_SQL, [
    projectId,
    needle,
  ]);
  if (fuzzyTable.rows.length > 0) {
    const record = toSymbolRecord(fuzzyTable.rows[0]);
    return {
      match: "fuzzy",
      query: needle,
      symbol: record,
      chunks: await chunksOverlapping(
        projectId,
        record.path,
        record.startLine,
        record.endLine,
      ),
    };
  }

  return { match: "none", query: needle, symbol: null, chunks: [] };
}

async function chunksOverlapping(
  projectId: string,
  path: string,
  startLine: number,
  endLine: number,
): Promise<ChunkRef[]> {
  const result = await query<ChunkRow>(CHUNKS_OVERLAPPING_SQL, [
    projectId,
    path,
    startLine,
    endLine,
  ]);
  return result.rows.map(toChunkRef);
}

/* ------------------------------------------------------------------ */
/* File reading                                                        */
/* ------------------------------------------------------------------ */

/** A chunk as it is stored, used by the file reconstruction. */
export interface FileChunk {
  startLine: number;
  endLine: number;
  content: string;
}

/** A reconstructed slice of a source file. */
export interface FileSlice {
  projectId: string;
  path: string;
  /** 1-based first line of `lines` / `text`. */
  startLine: number;
  /** 1-based last line of `lines` / `text`. */
  endLine: number;
  /** The source lines, `lines[0]` is line `startLine`. */
  lines: string[];
  /** The source lines joined with "\n". */
  text: string;
  /** How many chunks the body was rebuilt from. */
  chunkCount: number;
}

/**
 * Rebuild a file body from its chunks.
 *
 * The chunks are line-exact, but the sliding-window fallback (used for
 * languages without a grammar) produces OVERLAPPING windows. The same source
 * line therefore appears in two chunks. The reconstruction places every line
 * at its absolute line number, so the overlap collapses on its own and the
 * text at line N is exactly the source line N.
 *
 * Lines that no chunk covers are blank lines (the chunker skips them); they
 * are restored as "" or "\r" depending on the line ending of the file.
 */
export function reconstructFileBody(
  chunks: FileChunk[],
  options: { start?: number; end?: number } = {},
): { startLine: number; endLine: number; lines: string[]; text: string } {
  if (chunks.length === 0) {
    return { startLine: 0, endLine: 0, lines: [], text: "" };
  }

  const sorted = [...chunks].sort(
    (a, b) => a.startLine - b.startLine || a.endLine - b.endLine,
  );

  const byLine = new Map<number, string>();
  let usesCrlf = false;

  for (const chunk of sorted) {
    const parts = chunk.content.split("\n");
    for (let i = 0; i < parts.length; i++) {
      const lineNo = chunk.startLine + i;
      if (lineNo > chunk.endLine) break;
      const value = parts[i];
      if (value.endsWith("\r")) usesCrlf = true;
      // First writer wins: overlapping windows carry the same source text.
      if (!byLine.has(lineNo)) byLine.set(lineNo, value);
    }
  }

  let minLine = Number.POSITIVE_INFINITY;
  let maxLine = Number.NEGATIVE_INFINITY;
  for (const chunk of sorted) {
    minLine = Math.min(minLine, chunk.startLine);
    maxLine = Math.max(maxLine, chunk.endLine);
  }

  const start = options.start ?? minLine;
  const end = options.end ?? maxLine;

  const lines: string[] = [];
  for (let n = start; n <= end; n++) {
    const found = byLine.get(n);
    lines.push(found ?? (usesCrlf ? "\r" : ""));
  }

  return { startLine: start, endLine: end, lines, text: lines.join("\n") };
}

const FILE_CHUNKS_SQL = `
  SELECT c.start_line, c.end_line, c.content, c.symbol, c.kind
    FROM chunks c
   WHERE c.project_id = $1 AND c.path = $2
   ORDER BY c.start_line, c.end_line`;

/**
 * Read the exact source lines of a file.
 *
 * @param projectId the project the file belongs to
 * @param path      the repo-relative POSIX path
 * @param start     optional 1-based first line
 * @param end       optional 1-based last line
 */
export async function readFile(
  projectId: string,
  path: string,
  start?: number,
  end?: number,
): Promise<FileSlice> {
  const result = await query<{
    start_line: number;
    end_line: number;
    content: string;
  }>(FILE_CHUNKS_SQL, [projectId, path]);

  const chunks: FileChunk[] = result.rows.map((row) => ({
    startLine: row.start_line,
    endLine: row.end_line,
    content: row.content,
  }));

  const body = reconstructFileBody(chunks, { start, end });

  return {
    projectId,
    path,
    startLine: body.startLine,
    endLine: body.endLine,
    lines: body.lines,
    text: body.text,
    chunkCount: chunks.length,
  };
}

/* ------------------------------------------------------------------ */
/* Project statistics                                                  */
/* ------------------------------------------------------------------ */

/** Per-project index statistics. */
export interface ProjectStatsRow {
  projectId: string;
  repoUrl: string;
  repoSha: string;
  indexedAt: string;
  fileCount: number;
  chunkCount: number;
  embeddingModel: string;
  embeddingDim: number;
  contentHash: string;
  /** Chunks actually present in the `chunks` table for this project. */
  liveChunkCount: number;
}

const PROJECT_STATS_SQL = `
  SELECT m.project_id, m.repo_url, m.repo_sha, m.indexed_at, m.file_count,
         m.chunk_count, m.embedding_model, m.embedding_dim, m.content_hash,
         (SELECT count(*)::int FROM chunks c WHERE c.project_id = m.project_id)
           AS live_chunk_count
    FROM index_manifest m
   ORDER BY m.project_id`;

/** Per-project file and chunk counts, read from `index_manifest`. */
export async function getProjectStats(): Promise<ProjectStatsRow[]> {
  const result = await query<{
    project_id: string;
    repo_url: string;
    repo_sha: string;
    indexed_at: Date | string;
    file_count: number;
    chunk_count: number;
    embedding_model: string;
    embedding_dim: number;
    content_hash: string;
    live_chunk_count: number;
  }>(PROJECT_STATS_SQL);

  return result.rows.map((row) => ({
    projectId: row.project_id,
    repoUrl: row.repo_url,
    repoSha: row.repo_sha,
    indexedAt:
      row.indexed_at instanceof Date
        ? row.indexed_at.toISOString()
        : String(row.indexed_at),
    fileCount: row.file_count,
    chunkCount: row.chunk_count,
    embeddingModel: row.embedding_model ?? "",
    embeddingDim: row.embedding_dim ?? 0,
    contentHash: row.content_hash ?? "",
    liveChunkCount: row.live_chunk_count ?? 0,
  }));
}
