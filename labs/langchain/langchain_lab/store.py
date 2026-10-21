"""The database layer: the same Neon database, the same `chunks` table.

WHY THIS FILE IS LONGER THAN A "LANGCHAIN VERSION" SHOULD BE
-------------------------------------------------------------
LangChain has no equivalent of this pipeline. There is no Postgres
retriever that does vector ANN + BM25 + trigram + substring with
Reciprocal Rank Fusion, so the keyword legs have to be written by hand in
SQL no matter which framework is used. The framework only replaces the
vector leg and the document plumbing.

The SQL below is COPIED from `lib/retrieval/search.ts` on purpose. If the
two implementations ran different SQL, the comparison would measure the
SQL and not the framework. Every comment that explains WHY a piece of SQL
looks the way it does is carried over.

THE TWO CONNECTIONS
-------------------
`lakebase_ann` cannot be used through the Neon pooler:
`XX000 usage: need 0 probes, but 1 probes provided`. The vector leg
therefore needs the DIRECT endpoint and the keyword legs can use the
pooled one. The TypeScript pipeline keeps two pools for the same reason
(`lib/retrieval/db.ts`); the lab does the same.
"""

from __future__ import annotations

import math
import re
import time
from dataclasses import dataclass
from typing import Any, Iterable

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

from .embeddings import to_vector_literal

# --------------------------------------------------------------------------
# The SQL, copied from lib/retrieval/search.ts
# --------------------------------------------------------------------------

CHUNK_COLUMNS = """
  c.id, c.project_id, c.path, c.start_line, c.end_line, c.symbol, c.kind, c.lang,
  c.header, c.content, c.content_hash
"""

#: Leg 1: approximate nearest neighbour over the embedding column.
VECTOR_LEG_SQL = f"""
  SELECT {CHUNK_COLUMNS}, 1 - (c.embedding <=> %s::vector) AS similarity
    FROM chunks c
   WHERE c.embedding IS NOT NULL
     AND length(c.content) >= %s
     AND (%s::text IS NULL OR c.project_id = %s)
     AND (%s::text IS NULL OR c.path !~* %s)
   ORDER BY c.embedding <=> %s::vector
   LIMIT %s"""

#: Keyword sub-leg 1: full text (BM25 ranked by the `lakebase_text` AM).
TSVECTOR_LEG_SQL = f"""
  SELECT {CHUNK_COLUMNS},
         ts_rank(c.tsv, plainto_tsquery('english', %s)) AS and_score,
         ts_rank(c.tsv, websearch_to_tsquery('english', %s)) AS or_score
    FROM chunks c
   WHERE (
           c.tsv @@ plainto_tsquery('english', %s)
        OR c.tsv @@ websearch_to_tsquery('english', %s)
         )
     AND (%s::text IS NULL OR c.project_id = %s)
     AND (%s::text IS NULL OR c.path !~* %s)
   ORDER BY (c.tsv @@ plainto_tsquery('english', %s)) DESC, or_score DESC,
            c.path, c.start_line
   LIMIT %s"""

#: Keyword sub-leg 2: trigram match on the symbol name and the path.
TRIGRAM_LEG_SQL = f"""
  SELECT {CHUNK_COLUMNS},
         MAX(
           CASE
             WHEN c.symbol ILIKE t.pattern THEN 1.0 + similarity(c.symbol, t.token)
             WHEN c.path   ILIKE t.pattern THEN 0.5 + similarity(c.path, t.token)
             ELSE similarity(c.symbol, t.token)
           END
         ) AS kw_score
    FROM chunks c
    CROSS JOIN unnest(%s::text[], %s::text[]) AS t(token, pattern)
   WHERE (c.symbol ILIKE t.pattern OR c.path ILIKE t.pattern)
     AND (%s::text IS NULL OR c.project_id = %s)
     AND (%s::text IS NULL OR c.path !~* %s)
   GROUP BY c.id
   ORDER BY kw_score DESC, c.path, c.start_line
   LIMIT %s"""

#: Keyword sub-leg 3: exact substring fallback over the chunk content.
CONTENT_LEG_SQL = f"""
  SELECT {CHUNK_COLUMNS},
         (CASE WHEN c.content ILIKE %s THEN 100 ELSE 0 END) + COALESCE(m.w, 0)
           AS kw_score
    FROM chunks c
    LEFT JOIN LATERAL (
      SELECT sum(p.weight)::float AS w
        FROM unnest(%s::text[], %s::float[]) AS p(pattern, weight)
       WHERE c.content ILIKE p.pattern OR c.header ILIKE p.pattern
    ) m ON true
   WHERE (
           c.content ILIKE %s
        OR c.header  ILIKE %s
        OR c.content ILIKE ANY(%s::text[])
        OR c.header  ILIKE ANY(%s::text[])
         )
     AND (%s::text IS NULL OR c.project_id = %s)
     AND (%s::text IS NULL OR c.path !~* %s)
   ORDER BY kw_score DESC, length(c.content) ASC, c.path, c.start_line
   LIMIT %s"""

#: Document frequency of the query tokens.
#:
#: NOTE: psycopg3 reads `%` as a placeholder marker, so the literal percent
#: signs of the LIKE patterns are doubled here.
DF_SQL = """
  SELECT t.token, count(*)::int AS df
    FROM unnest(%s::text[]) AS t(token)
    CROSS JOIN chunks c
   WHERE c.content ILIKE '%%' || t.token || '%%'
      OR c.header  ILIKE '%%' || t.token || '%%'
   GROUP BY t.token"""

# --------------------------------------------------------------------------
# Constants copied from lib/retrieval/search.ts
# --------------------------------------------------------------------------

#: The RRF damping constant.
RRF_K = 60

#: The shortest chunk that may take part in the VECTOR leg.
VECTOR_MIN_CONTENT_CHARS = 120

#: The Postgres regular expression that recognises a test file.
TEST_PATH_REGEX = (
    r"(^|/)(tests?|__tests__|spec|specs|e2e)/|\.(test|spec)\.[a-z0-9]+$"
    r"|(^|/)(test_[^/]*|[^/]*_test)\.(py|js|jsx|ts|tsx|dart)$"
)

#: Words that carry no retrieval signal in a code question.
STOP_WORDS = {
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
}


# --------------------------------------------------------------------------
# Helpers copied from lib/retrieval/search.ts
# --------------------------------------------------------------------------


def query_asks_about_tests(text: str) -> bool:
    """Does the question itself ask about tests?"""
    return bool(
        re.search(
            r"\b(tests?|testing|assertions?|asserts?|spec|specs|coverage|unittest|pytest|vitest|jest|fixture|fixtures)\b",
            text,
            re.IGNORECASE,
        )
    )


def path_exclusion(text: str, exclude_tests: bool) -> str | None:
    """The path-exclusion pattern for a query, or `None` when nothing is excluded."""
    if not exclude_tests:
        return None
    if query_asks_about_tests(text):
        return None
    return TEST_PATH_REGEX


def extract_keywords(text: str, limit: int = 12) -> list[str]:
    """Split a question into the tokens that carry retrieval signal.

    Identifiers keep their underscores (`calculate_deepseek_cost` stays one
    token) and are additionally split into their parts.
    """
    out: list[str] = []

    def push(token: str) -> None:
        if len(token) < 3 or token in STOP_WORDS or token in out:
            return
        out.append(token)

    for raw in text.lower().split(r"[^a-z0-9_]+"):
        if not raw:
            continue
        push(raw)
        if "_" in raw:
            for part in raw.split("_"):
                push(part)
        if len(out) >= limit:
            break
    return out[:limit]


def escape_like(value: str) -> str:
    """Escape the LIKE metacharacters so a token matches literally."""
    return re.sub(r"([\\%_])", r"\\\1", value)


def singular_variants(token: str) -> list[str]:
    """Crude English singular forms of a token."""
    out: list[str] = []
    if len(token) > 5 and token.endswith("ies"):
        out.append(token[:-3] + "y")
    if len(token) > 5 and token.endswith("es"):
        out.append(token[:-2])
    if len(token) > 4 and token.endswith("s") and not token.endswith("ss"):
        out.append(token[:-1])
    return [variant for variant in out if len(variant) >= 3 and variant != token]


def like_token_pairs(tokens: Iterable[str]) -> tuple[list[str], list[str]]:
    """Build the `%token%` patterns used by the ILIKE legs.

    The token and the pattern have to stay ALIGNED: the trigram leg unnests
    both arrays in parallel so it can score a match with the trigram
    similarity of the raw token.
    """
    token_list: list[str] = []
    pattern_list: list[str] = []
    for token in tokens:
        for variant in [token, *singular_variants(token)]:
            pattern = "%" + escape_like(variant) + "%"
            if pattern in pattern_list:
                continue
            token_list.append(variant)
            pattern_list.append(pattern)
    return token_list, pattern_list


def split_identifier(identifier: str) -> list[str]:
    """Split an identifier into the words it is made of.

    `is_relevant_jd` becomes `is`, `relevant`, `jd`.
    """
    spaced = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", identifier)
    return [
        part.lower()
        for part in re.split(r"[^A-Za-z0-9]+", spaced)
        if len(part) >= 3
    ]


def expansion_terms(chunks: list[Chunk], top_k: int) -> list[str]:
    """The terms the best candidates contribute to a second search.

    Pseudo-relevance feedback is the oldest trick in information retrieval:
    look at what the first search found, take the vocabulary of those
    documents, and search again with it.

    Ported from `expansionTerms` in `lib/retrieval/search.ts`.
    """
    terms: list[str] = []

    def push(term: str) -> None:
        if len(term) < 3 or term in STOP_WORDS or term in terms:
            return
        terms.append(term)

    for chunk in chunks[:top_k]:
        for part in split_identifier(chunk.symbol):
            push(part)
        file_name = chunk.path.rsplit("/", 1)[-1]
        stem = re.sub(r"\.[a-z0-9]+$", "", file_name, flags=re.IGNORECASE)
        for part in split_identifier(stem):
            push(part)
    return terms


def fuse_rrf(legs: list[tuple[str, list[str], float]], k: int = RRF_K) -> list[tuple[str, float]]:
    """Fuse ranked lists with Reciprocal Rank Fusion.

    `score(d) = sum over legs of weight(leg) / (k + rank_in_leg(d))`
    """
    scores: dict[str, float] = {}
    for _name, ids, weight in legs:
        for index, chunk_id in enumerate(ids):
            scores[chunk_id] = scores.get(chunk_id, 0.0) + weight / (k + index + 1)
    return sorted(scores.items(), key=lambda item: (-item[1], item[0]))


# --------------------------------------------------------------------------
# The store
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Chunk:
    """A chunk as it comes back from the database."""

    id: str
    project_id: str
    path: str
    start_line: int
    end_line: int
    symbol: str
    kind: str
    lang: str
    header: str
    content: str
    content_hash: str


@dataclass
class Tuning:
    """The retriever knobs, with the production defaults of the TypeScript pipeline.

    Every default here is the value in `DEFAULT_TUNING`
    (`lib/retrieval/search.ts`). They were measured on the same 79
    scorable questions with `scripts/eval/bench.ts`.
    """

    min_vector_chars: int = VECTOR_MIN_CONTENT_CHARS
    vector_weight: float = 1.0
    keyword_weight: float = 4.0
    exclude_tests: bool = True
    generic_token_df_ratio: float = 1.0
    use_idf: bool = False
    rerank: bool = True
    rerank_depth: int = 20
    candidates: int = 40
    prf: bool = False
    prf_top_k: int = 5


class NeonStore:
    """Raw access to the `chunks` table, over two connections."""

    def __init__(self, pooled_url: str, direct_url: str) -> None:
        self.pool = ConnectionPool(
            pooled_url, min_size=1, max_size=4, open=True, kwargs={"row_factory": dict_row}
        )
        self.direct_pool = ConnectionPool(
            direct_url, min_size=1, max_size=2, open=True, kwargs={"row_factory": dict_row}
        )
        self._df_cache: dict[str, int] = {}
        self._corpus_size: int | None = None

    def close(self) -> None:
        """Close both pools."""
        self.pool.close()
        self.direct_pool.close()

    # ------------------------------------------------------------------
    # Corpus statistics
    # ------------------------------------------------------------------

    def corpus_size(self) -> int:
        """How many chunks the corpus holds. Used as `N` in the IDF formula."""
        if self._corpus_size is None:
            with self.pool.connection() as conn:
                row = conn.execute("SELECT count(*)::int AS total FROM chunks").fetchone()
                self._corpus_size = int(row["total"])
        return self._corpus_size

    def document_frequencies(self, tokens: list[str]) -> dict[str, int]:
        """How many chunks contain each token. Cached per token, like the TS version."""
        missing = [token for token in tokens if token not in self._df_cache]
        if missing:
            with self.pool.connection() as conn:
                rows = conn.execute(DF_SQL, (missing,)).fetchall()
                for row in rows:
                    self._df_cache[row["token"]] = int(row["df"])
            for token in missing:
                self._df_cache.setdefault(token, 0)
        return {token: self._df_cache.get(token, 0) for token in tokens}

    # ------------------------------------------------------------------
    # The vector leg
    # ------------------------------------------------------------------

    def vector_leg(
        self,
        embedding: Any,
        project_id: str | None,
        limit: int,
        exclude_path: str | None,
        min_content_chars: int,
    ) -> list[Chunk]:
        """Leg 1: approximate nearest neighbours, best first.

        Runs on the DIRECT connection because the `lakebase_ann` access
        method cannot be used through the Neon pooler.
        """
        literal = to_vector_literal(embedding)
        with self.direct_pool.connection() as conn:
            conn.execute("BEGIN")
            try:
                # `SET LOCAL` pins the ANN search effort for THIS
                # transaction, which is the only way to be sure of it behind
                # the Neon pooler.
                conn.execute("SAVEPOINT ann_search_effort")
                try:
                    # Load pgvector into this backend so the GUC exists.
                    conn.execute("SELECT '[0]'::vector")
                    conn.execute("SET LOCAL hnsw.ef_search = 100")
                    conn.execute("RELEASE SAVEPOINT ann_search_effort")
                except Exception:
                    conn.execute("ROLLBACK TO SAVEPOINT ann_search_effort")

                rows = conn.execute(
                    VECTOR_LEG_SQL,
                    (
                        literal,
                        min_content_chars,
                        project_id,
                        project_id,
                        exclude_path,
                        exclude_path,
                        literal,
                        limit,
                    ),
                ).fetchall()
            finally:
                conn.execute("COMMIT")
        return [_to_chunk(row) for row in rows]

    # ------------------------------------------------------------------
    # The keyword leg
    # ------------------------------------------------------------------

    def keyword_leg(
        self,
        text: str,
        project_id: str | None,
        limit: int,
        exclude_path: str | None,
        tuning: Tuning,
    ) -> list[Chunk]:
        """The union of the tsvector, trigram and content sub-legs.

        The three sub-legs are fused with RRF into ONE keyword ranking, and
        that ranking is then fused with the vector ranking by the caller.
        """
        raw_tokens = extract_keywords(text)
        total = self.corpus_size()

        df = self.document_frequencies(raw_tokens)
        generic = generic_tokens(raw_tokens, df, total, tuning.generic_token_df_ratio)
        tokens = [token for token in raw_tokens if token not in generic]

        variants: list[str] = []
        for token in tokens:
            for variant in [token, *singular_variants(token)]:
                if variant not in variants:
                    variants.append(variant)

        variant_df = self.document_frequencies(variants)
        variant_weights = idf_weights(variants, variant_df, total)

        match_tokens = variants
        # IMPORTANT: the patterns are built from `variants` DIRECTLY, not
        # through `like_token_pairs`. `variants` already contains the
        # singular forms, so running the singular expansion over it AGAIN
        # produces a LONGER list than `match_tokens`. The trigram leg
        # unnests the two arrays in parallel (`unnest($1::text[],
        # $4::text[])`), so a length mismatch silently shifts every pattern
        # onto the wrong token - and the extra rows get a NULL token, which
        # makes `similarity(symbol, NULL)` NULL, and a NULL sort key sorts
        # FIRST under `ORDER BY ... DESC` in Postgres. The TypeScript
        # implementation builds the patterns from `variants` for exactly
        # this reason.
        patterns = ["%" + escape_like(variant) + "%" for variant in variants]
        pattern_weights = (
            [variant_weights.get(variant, 1.0) for variant in variants]
            if tuning.use_idf
            else [1.0 for _ in variants]
        )

        full_pattern = "%" + escape_like(text.strip()) + "%"
        # The OR fallback of the full text leg is built from the KEYWORDS,
        # not from the raw question.
        or_query = " ".join(tokens)

        with self.pool.connection() as conn:
            tsvector_rows = conn.execute(
                TSVECTOR_LEG_SQL,
                (
                    text,
                    or_query,
                    text,
                    or_query,
                    project_id,
                    project_id,
                    exclude_path,
                    exclude_path,
                    text,
                    limit,
                ),
            ).fetchall()

            trigram_rows: list[Any] = []
            content_rows: list[Any] = []
            if tokens:
                trigram_rows = conn.execute(
                    TRIGRAM_LEG_SQL,
                    (
                        match_tokens,
                        patterns,
                        project_id,
                        project_id,
                        exclude_path,
                        exclude_path,
                        limit,
                    ),
                ).fetchall()
                content_rows = conn.execute(
                    CONTENT_LEG_SQL,
                    (
                        full_pattern,
                        patterns,
                        pattern_weights,
                        full_pattern,
                        full_pattern,
                        patterns,
                        patterns,
                        project_id,
                        project_id,
                        exclude_path,
                        exclude_path,
                        limit,
                    ),
                ).fetchall()

        by_id: dict[str, Chunk] = {}
        for row in [*tsvector_rows, *trigram_rows, *content_rows]:
            chunk = _to_chunk(row)
            if chunk.id not in by_id:
                by_id[chunk.id] = chunk

        fused = fuse_rrf(
            [
                ("tsvector", [row["id"] for row in tsvector_rows], 1.0),
                ("trigram", [row["id"] for row in trigram_rows], 1.0),
                ("content", [row["id"] for row in content_rows], 1.0),
            ]
        )
        return [by_id[chunk_id] for chunk_id, _score in fused if chunk_id in by_id]

    # ------------------------------------------------------------------
    # The top-level fusion
    # ------------------------------------------------------------------

    def hybrid_search(
        self,
        text: str,
        embedding: Any,
        project_id: str | None,
        tuning: Tuning,
    ) -> list[tuple[Chunk, float]]:
        """The fused candidate pool, best first.

        The pool is NOT the answer: it is what the cross-encoder re-orders.
        """
        exclude_path = path_exclusion(text, tuning.exclude_tests)
        candidates = tuning.candidates

        vector_rows = self.vector_leg(
            embedding, project_id, candidates, exclude_path, tuning.min_vector_chars
        )
        keyword_rows = self.keyword_leg(text, project_id, candidates, exclude_path, tuning)

        by_id: dict[str, Chunk] = {}
        for chunk in [*vector_rows, *keyword_rows]:
            by_id.setdefault(chunk.id, chunk)

        fused = fuse_rrf(
            [
                ("vector", [chunk.id for chunk in vector_rows], tuning.vector_weight),
                ("keyword", [chunk.id for chunk in keyword_rows], tuning.keyword_weight),
            ]
        )
        return [(by_id[chunk_id], score) for chunk_id, score in fused if chunk_id in by_id]


def generic_tokens(
    tokens: list[str], df: dict[str, int], total: int, ratio: float
) -> set[str]:
    """The tokens that are too common to be useful.

    A ratio of `1` disables the filter.
    """
    if ratio >= 1:
        return set()
    cutoff = total * ratio
    return {token for token in tokens if df.get(token, 0) > cutoff}


def idf_weights(tokens: list[str], df: dict[str, int], total: int) -> dict[str, float]:
    """Weight the survivors by inverse document frequency.

    `idf(t) = ln(N / (1 + df(t)))`.
    """
    return {
        token: float(math.log((total + 1) / (df.get(token, 0) + 1)))
        for token in tokens
    }


def _to_chunk(row: dict[str, Any]) -> Chunk:
    """Map a database row to a {@link Chunk}."""
    return Chunk(
        id=str(row["id"]),
        project_id=row["project_id"],
        path=row["path"],
        start_line=int(row["start_line"]),
        end_line=int(row["end_line"]),
        symbol=row["symbol"] or "",
        kind=row["kind"] or "",
        lang=row["lang"] or "",
        header=row["header"] or "",
        content=row["content"] or "",
        content_hash=row["content_hash"] or "",
    )


def timed(fn, *args, **kwargs):
    """Run `fn` and return `(result, elapsed_ms)`. Used by the benchmark."""
    started = time.perf_counter()
    result = fn(*args, **kwargs)
    return result, (time.perf_counter() - started) * 1000
