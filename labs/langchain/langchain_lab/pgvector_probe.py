"""The PGVector experiment: what does LangChain's own vector store cost?

THE QUESTION
------------
LangChain's `PGVector` is the obvious way to do "vector search over
Postgres" in LangChain. Can it read the `chunks` table the portfolio
already has?

THE ANSWER, MEASURED
---------------------
No. `PGVector` always reads and writes its OWN table
(`langchain_pg_embedding`, columns `id`, `collection_id`, `embedding`,
`document`, `cmetadata`), and it creates that table plus a collection row
the moment it is constructed. The `chunks` table has a different shape
(`path`, `start_line`, `symbol`, ... as columns, no `collection_id`, no
`cmetadata`), so `PGVector` cannot be pointed at it.

This script measures what the alternative costs:

  1. construct the store and show that it sees ZERO rows;
  2. copy the corpus into it (one INSERT ... SELECT) and time it;
  3. run the same 79 questions through the LangChain store and compute
     the vector-leg recall;
  4. run the same questions through the raw SQL vector leg and compute
     the same numbers, so the two are comparable;
  5. print the teardown command.

Everything the script creates lives in the `langchain_lab` schema. The
`public` schema - the one the production pipeline uses - is never written
to. `python -m langchain_lab.pgvector_probe --teardown` removes it.
"""

from __future__ import annotations

import argparse
import statistics
import time
from typing import Any

from .config import LAB_SCHEMA, database_url, database_url_direct
from .embeddings import LocalMiniLM
from .golden import read_golden_set, scorable_questions
from .metrics import Hit, RelevantRange, mean, recall_at_k
from .store import NeonStore, Tuning, path_exclusion

#: How many candidates the vector leg pulls, in both implementations.
VECTOR_CANDIDATES = 40

#: The schema the LangChain tables live in.
COLLECTION_NAME = "kaustubh_portfolio"


def sqlalchemy_url(url: str) -> str:
    """Turn a `postgresql://` URL into the psycopg3 flavour SQLAlchemy wants."""
    if url.startswith("postgresql://"):
        return "postgresql+psycopg://" + url[len("postgresql://") :]
    return url


def ensure_schema(store: NeonStore) -> None:
    """Create the schema the lab owns."""
    with store.pool.connection() as conn:
        conn.execute(f"CREATE SCHEMA IF NOT EXISTS {LAB_SCHEMA}")
        conn.commit()


def build_store(url: str):
    """Construct LangChain's `PGVector` inside the lab schema."""
    from langchain_postgres import PGVector

    from .embeddings import LocalOnnxEmbeddings

    return PGVector(
        embeddings=LocalOnnxEmbeddings(),
        connection=sqlalchemy_url(url),
        embedding_length=384,
        collection_name=COLLECTION_NAME,
        create_extension=False,  # the database already has `lakebase_vector`
        engine_args={
            "connect_args": {"options": f"-c search_path={LAB_SCHEMA},public"},
            "pool_pre_ping": True,
        },
    )


def copy_corpus(store: NeonStore) -> tuple[int, float]:
    """Copy the embedded chunks into the LangChain collection table.

    One statement, no re-embedding: the vectors already exist in
    `chunks.embedding`. This is the CHEAPEST way to feed LangChain's
    store. Going through `PGVector.add_texts()` instead would re-embed
    every chunk with the model first.

    @return (rows copied, elapsed milliseconds)
    """
    sql = f"""
      INSERT INTO {LAB_SCHEMA}.langchain_pg_embedding
             (id, collection_id, embedding, document, cmetadata)
      SELECT c.id::text,
             coll.uuid,
             c.embedding,
             c.content,
             jsonb_build_object(
               'project_id',   c.project_id,
               'path',         c.path,
               'start_line',   c.start_line,
               'end_line',     c.end_line,
               'symbol',       c.symbol,
               'content_len',  length(c.content)
             )
        FROM chunks c
        CROSS JOIN {LAB_SCHEMA}.langchain_pg_collection coll
       WHERE coll.name = %s
         AND c.embedding IS NOT NULL
      ON CONFLICT (id) DO UPDATE
         SET embedding = EXCLUDED.embedding,
             document = EXCLUDED.document,
             cmetadata = EXCLUDED.cmetadata"""

    started = time.perf_counter()
    with store.pool.connection() as conn:
        rows = conn.execute(sql, (COLLECTION_NAME,)).rowcount
        conn.commit()
    return rows, (time.perf_counter() - started) * 1000


def row_count(store: NeonStore) -> int:
    """How many rows the LangChain collection table holds."""
    with store.pool.connection() as conn:
        row = conn.execute(
            f"SELECT count(*)::int AS total FROM {LAB_SCHEMA}.langchain_pg_embedding"
        ).fetchone()
        return int(row["total"])


def evaluate(store: NeonStore, pg_store: Any, embedder: LocalMiniLM) -> None:
    """Score the vector leg of both implementations on the golden set."""
    questions = scorable_questions(read_golden_set())
    tuning = Tuning()

    raw_recall5: list[float] = []
    raw_file_recall5: list[float] = []
    pg_recall5: list[float] = []
    pg_file_recall5: list[float] = []
    raw_ms: list[float] = []
    pg_ms: list[float] = []

    for question in questions:
        embedding = embedder.embed_query(question.question)
        exclude_path = path_exclusion(question.question, tuning.exclude_tests)

        # --- the raw SQL vector leg ------------------------------------
        started = time.perf_counter()
        raw_rows = store.vector_leg(
            embedding,
            question.project,
            VECTOR_CANDIDATES,
            exclude_path,
            tuning.min_vector_chars,
        )
        raw_ms.append((time.perf_counter() - started) * 1000)

        # --- the LangChain PGVector leg --------------------------------
        filters: dict[str, Any] = {"content_len": {"$gte": tuning.min_vector_chars}}
        if question.project:
            filters["project_id"] = question.project
        started = time.perf_counter()
        pg_rows = pg_store.similarity_search_with_score_by_vector(
            embedding=[float(value) for value in embedding],
            k=VECTOR_CANDIDATES,
            filter=filters,
        )
        pg_ms.append((time.perf_counter() - started) * 1000)

        relevant = [
            RelevantRange(
                path=item.path,
                start_line=item.start_line,
                end_line=item.end_line,
                symbol=item.symbol,
            )
            for item in question.evidence
        ]
        paths = [RelevantRange(path=item.path) for item in question.evidence]

        raw_hits = [
            Hit(row.path, row.start_line, row.end_line, row.symbol) for row in raw_rows
        ]
        pg_hits = [
            Hit(
                doc.metadata.get("path", ""),
                int(doc.metadata.get("start_line", 0)),
                int(doc.metadata.get("end_line", 0)),
                doc.metadata.get("symbol", "") or "",
            )
            for doc, _score in pg_rows
        ]

        raw_recall5.append(recall_at_k(raw_hits, relevant, 5))
        raw_file_recall5.append(recall_at_k(raw_hits, paths, 5))
        pg_recall5.append(recall_at_k(pg_hits, relevant, 5))
        pg_file_recall5.append(recall_at_k(pg_hits, paths, 5))

    print("")
    print(f"--- VECTOR LEG ONLY ({len(questions)} questions) ---")
    print(
        f"  raw SQL over `chunks`   chunk recall@5 {mean(raw_recall5) * 100:5.1f}%   "
        f"file recall@5 {mean(raw_file_recall5) * 100:5.1f}%   "
        f"{statistics.fmean(raw_ms):7.1f} ms/query"
    )
    print(
        f"  LangChain PGVector       chunk recall@5 {mean(pg_recall5) * 100:5.1f}%   "
        f"file recall@5 {mean(pg_file_recall5) * 100:5.1f}%   "
        f"{statistics.fmean(pg_ms):7.1f} ms/query"
    )


def teardown(store: NeonStore) -> None:
    """Drop everything the lab created."""
    with store.pool.connection() as conn:
        conn.execute(f"DROP SCHEMA IF EXISTS {LAB_SCHEMA} CASCADE")
        conn.commit()
    print(f"dropped schema {LAB_SCHEMA}")


def main(argv: list[str] | None = None) -> int:
    """Run the experiment."""
    parser = argparse.ArgumentParser(description="The LangChain PGVector experiment")
    parser.add_argument(
        "--teardown",
        action="store_true",
        help=f"drop the {LAB_SCHEMA} schema and exit",
    )
    parser.add_argument(
        "--keep",
        action="store_true",
        help="keep the copied corpus (so the next run does not copy it again)",
    )
    args = parser.parse_args(argv)

    store = NeonStore(database_url(), database_url_direct())
    try:
        if args.teardown:
            teardown(store)
            return 0

        ensure_schema(store)
        embedder = LocalMiniLM()

        print("")
        print("--- LangChain PGVector against the portfolio's own corpus ---")

        pg_store = build_store(database_url())
        print(f"  tables the store created: langchain_pg_collection, langchain_pg_embedding")
        print(f"  rows visible to PGVector before the copy: {row_count(store)}")
        print(
            "  the `chunks` table is NOT readable by PGVector: it has no "
            "`collection_id` and no `cmetadata` column."
        )

        if row_count(store) == 0:
            rows, elapsed = copy_corpus(store)
            print(
                f"  corpus copied: {rows} rows in {elapsed:.0f} ms "
                f"(one INSERT ... SELECT, no re-embedding)"
            )

        print(f"  rows visible to PGVector after the copy: {row_count(store)}")

        evaluate(store, pg_store, embedder)

        print("")
        if not args.keep:
            teardown(store)
        else:
            print(f"the copied corpus is kept in schema {LAB_SCHEMA}")
            print(f"  teardown: python -m langchain_lab.pgvector_probe --teardown")
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
