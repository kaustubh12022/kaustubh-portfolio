-- =============================================================================
-- kaustubh-portfolio :: retrieval schema (Neon / Lakebase Postgres)
-- =============================================================================
--
-- Stores the retrievable chunks of the six source repositories so the
-- conversational portfolio can answer questions like "how does SmartApply
-- score jobs?" with real, line-exact source code.
--
-- Extensions (already created on this branch):
--   pgcrypto        -> gen_random_uuid()
--   lakebase_vector -> pgvector-compatible vector type + ANN index (lakebase_ann)
--   lakebase_text   -> BM25 full-text ranking
--   pg_trgm         -> fuzzy identifier matching
--
-- Embedding model
--   Local `Xenova/all-MiniLM-L6-v2` via @huggingface/transformers
--   -> 384 dimensions, cosine similarity, normalized.
--   The dimension is stamped on every row AND in index_manifest so a model
--   change is detected instead of silently producing nonsense distances.
--
--   IMPORTANT: never mix vectors from different models in one column. If the
--   model changes, re-embed the whole corpus. `index_manifest.embedding_model`
--   is the guard.
--
-- ef_search
--   The HNSW search-effort GUC. The pgvector default of 40 yields recall@10 of
--   only ~0.88 on a corpus this shape, which is the classic cause of a RAG
--   pipeline that looks like it "hallucinates on edge cases". 100 is used
--   here. Set per-transaction with:
--       SET LOCAL hnsw.ef_search = 100;
--
-- Idempotency
--   Every statement below is safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- chunks: the retrievable units of source code
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    text NOT NULL,
  repo_sha      text NOT NULL,
  path          text NOT NULL,
  lang          text NOT NULL,
  kind          text NOT NULL,
  symbol        text NOT NULL DEFAULT '',
  symbols       text[] NOT NULL DEFAULT '{}',
  start_line    integer NOT NULL,
  end_line      integer NOT NULL,
  content       text NOT NULL,
  header        text NOT NULL DEFAULT '',
  content_hash  text NOT NULL,
  parser        text NOT NULL DEFAULT 'tree-sitter',
  embedding     vector(384),
  embedding_model text NOT NULL DEFAULT '',
  embedding_dim   integer NOT NULL DEFAULT 0,
  tsv           tsvector GENERATED ALWAYS AS (
                  to_tsvector('english', coalesce(header, '') || ' ' || coalesce(content, ''))
                ) STORED,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chunks_line_range_valid CHECK (end_line >= start_line),
  CONSTRAINT chunks_unique_identity
    UNIQUE (project_id, path, start_line, end_line, content_hash)
);

-- Full-text search over the header + content (BM25 ranking via lakebase_text).
CREATE INDEX IF NOT EXISTS chunks_tsv_idx ON chunks USING GIN (tsv);

-- Approximate nearest-neighbour index for semantic search.
CREATE INDEX IF NOT EXISTS chunks_embedding_ann
  ON chunks USING lakebase_ann (embedding vector_cosine_ops);

-- Every chunk of a file (citation validation, file-level answers).
CREATE INDEX IF NOT EXISTS chunks_project_path_idx ON chunks (project_id, path);

-- Look up a symbol by name across a project ("where is findZeroSumSubsets?").
CREATE INDEX IF NOT EXISTS chunks_project_symbol_idx ON chunks (project_id, symbol);

-- Fuzzy identifier lookup, for questions that half-remember a name.
CREATE INDEX IF NOT EXISTS chunks_symbol_trgm_idx ON chunks USING gin (symbol gin_trgm_ops);

-- Incremental re-indexing: unchanged content is skipped.
CREATE INDEX IF NOT EXISTS chunks_content_hash_idx ON chunks (content_hash);

-- -----------------------------------------------------------------------------
-- symbols: the named constructs extracted from the AST
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS symbols (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  text NOT NULL,
  path        text NOT NULL,
  name        text NOT NULL,
  kind        text NOT NULL,
  start_line  integer NOT NULL,
  end_line    integer NOT NULL,
  signature   text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT symbols_unique_identity UNIQUE (project_id, path, name, start_line)
);

CREATE INDEX IF NOT EXISTS symbols_project_name_idx ON symbols (project_id, name);
CREATE INDEX IF NOT EXISTS symbols_project_path_idx ON symbols (project_id, path);
CREATE INDEX IF NOT EXISTS symbols_name_trgm_idx ON symbols USING gin (name gin_trgm_ops);

-- -----------------------------------------------------------------------------
-- edges: call / import relationships between symbols
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS edges (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  text NOT NULL,
  from_symbol text NOT NULL,
  to_symbol   text NOT NULL,
  relation    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT edges_relation_valid CHECK (relation IN ('imports', 'calls')),
  CONSTRAINT edges_unique_identity UNIQUE (project_id, from_symbol, to_symbol, relation)
);

CREATE INDEX IF NOT EXISTS edges_project_from_idx ON edges (project_id, from_symbol);
CREATE INDEX IF NOT EXISTS edges_project_to_idx ON edges (project_id, to_symbol);

-- -----------------------------------------------------------------------------
-- index_manifest: one row per indexed project
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS index_manifest (
  project_id      text PRIMARY KEY,
  repo_url        text NOT NULL,
  repo_sha        text NOT NULL,
  indexed_at      timestamptz NOT NULL DEFAULT now(),
  file_count      integer NOT NULL DEFAULT 0,
  chunk_count     integer NOT NULL DEFAULT 0,
  embedding_model text NOT NULL DEFAULT '',
  embedding_dim   integer NOT NULL DEFAULT 0,
  content_hash    text NOT NULL DEFAULT ''
);

-- -----------------------------------------------------------------------------
-- claims: curated, reviewable statements the assistant is allowed to make
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS claims (
  id             text PRIMARY KEY,
  topic          text NOT NULL,
  claim          text NOT NULL,
  status         text NOT NULL DEFAULT 'draft',
  evidence       text NOT NULL DEFAULT '',
  source         text NOT NULL DEFAULT '',
  public_wording text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS claims_topic_idx ON claims (topic);
CREATE INDEX IF NOT EXISTS claims_status_idx ON claims (status);

-- -----------------------------------------------------------------------------
-- answer_log: per-request cost + latency telemetry.
-- Three-rate cost accounting, mirroring the pattern already used in
-- JobHunt-Automation/src/ai_engine.py (cache-hit / cache-miss / completion).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS answer_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     timestamptz NOT NULL DEFAULT now(),
  question       text NOT NULL,
  intent         text NOT NULL DEFAULT '',
  model          text NOT NULL DEFAULT '',
  tool_steps     integer NOT NULL DEFAULT 0,
  citations      integer NOT NULL DEFAULT 0,
  confidence     text NOT NULL DEFAULT '',
  cache_hit_tokens  integer NOT NULL DEFAULT 0,
  cache_miss_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cost_usd       numeric(12, 8) NOT NULL DEFAULT 0,
  latency_ms     integer NOT NULL DEFAULT 0,
  first_token_ms integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS answer_log_created_idx ON answer_log (created_at DESC);
