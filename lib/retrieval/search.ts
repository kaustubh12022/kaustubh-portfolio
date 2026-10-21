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
}

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
   GROUP BY c.id
   ORDER BY kw_score DESC, c.path, c.start_line
   LIMIT $3`;

/**
 * Keyword sub-leg 3: exact substring fallback over the chunk content.
 *
 * The rows are ordered by the NUMBER of query tokens they contain, not by
 * their length: a one line chunk that mentions "booking" is less relevant
 * than the function that mentions "booking" AND "overlap". Counting the
 * hits needs a lateral join, which is what the `m.n` column is.
 */
const CONTENT_LEG_SQL = `
  SELECT ${CHUNK_COLUMNS},
         (CASE WHEN c.content ILIKE $4 THEN 100 ELSE 0 END) + COALESCE(m.n, 0)
           AS kw_score
    FROM chunks c
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n
        FROM unnest($1::text[]) AS p(pattern)
       WHERE c.content ILIKE p.pattern OR c.header ILIKE p.pattern
    ) m ON true
   WHERE (
           c.content ILIKE $4
        OR c.header  ILIKE $4
        OR c.content ILIKE ANY($1::text[])
        OR c.header  ILIKE ANY($1::text[])
         )
     AND ($2::text IS NULL OR c.project_id = $2)
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
/* RRF                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Fuse ranked lists with Reciprocal Rank Fusion.
 *
 * `score(d) = sum over legs of 1 / (k + rank_in_leg(d))`
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
    leg.ids.forEach((id, index) => {
      const rank = index + 1;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
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
      VECTOR_MIN_CONTENT_CHARS,
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
): Promise<ChunkRow[]> {
  const tokens = extractKeywords(text);
  const { tokens: matchTokens, patterns } = likeTokenPairs(tokens);
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
    ]),
    tokens.length > 0
      ? query<ChunkRow>(TRIGRAM_LEG_SQL, [
          matchTokens,
          projectId ?? null,
          limit,
          patterns,
        ])
      : Promise.resolve({ rows: [] as ChunkRow[], rowCount: 0 }),
    tokens.length > 0
      ? query<ChunkRow>(CONTENT_LEG_SQL, [
          patterns,
          projectId ?? null,
          limit,
          fullPattern,
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
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Run a hybrid search.
 *
 * @param params    the question plus the optional project filter
 * @param embedding the embedded query. It is passed IN on purpose: the
 *                  caller owns the model, so the same embedding can be
 *                  reused across several searches (and so the tests can
 *                  inject a fake one).
 */
export async function searchChunks(
  params: SearchParams,
  embedding: Float32Array,
): Promise<SearchHit[]> {
  const text = params.query.trim();
  if (!text) return [];

  const limit = params.limit ?? DEFAULT_LIMIT;
  const candidates = params.candidates ?? DEFAULT_CANDIDATES;

  const [vectorRows, keywordRows] = await Promise.all([
    vectorLeg(embedding, params.projectId, candidates),
    keywordLeg(text, params.projectId, candidates),
  ]);

  const byId = new Map<string, ChunkRef>();
  for (const row of [...vectorRows, ...keywordRows]) {
    if (!byId.has(row.id)) byId.set(row.id, toChunkRef(row));
  }

  const fused = fuseReciprocalRankFusion([
    { name: "vector", ids: vectorRows.map((row) => row.id) },
    { name: "keyword", ids: keywordRows.map((row) => row.id) },
  ]);

  const hits: SearchHit[] = [];
  for (const entry of fused) {
    const ref = byId.get(entry.id);
    if (!ref) continue;
    hits.push({
      ...ref,
      score: entry.score,
      vectorRank: entry.ranks.vector ?? null,
      keywordRank: entry.ranks.keyword ?? null,
    });
    if (hits.length >= limit) break;
  }
  return hits;
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
