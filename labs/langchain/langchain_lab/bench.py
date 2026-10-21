"""The benchmark: the same 79 questions, the same metrics, the same corpus.

WHAT THIS PRINTS
----------------
The metric block is byte-for-byte the same shape as the one
`scripts/eval/bench.ts` prints, because the numbers have to be
comparable:

    chunk recall@5 / chunk recall@10 / MRR@10 / nDCG@10
    hit-rate@10 / precision@10 / FILE recall@5 / FILE recall@10

On top of that the lab prints the latency split, because that is the
number the TypeScript benchmark does NOT print (it caches the query
embeddings, so its wall clock excludes the embedding cost).

MODES
-----
  production   The TypeScript pipeline as it is deployed: one embedding,
               one hybrid search, one cross-encoder pass. This is the
               number that goes in the comparison table.

  multi-query  The same thing with LangChain's `MultiQueryRetriever`
               wrapped around it. Three queries are issued instead of
               one, so three embeddings and three searches happen.

  prf          The same thing with pseudo-relevance feedback INSIDE the
               retriever: the identifiers of the best candidates feed a
               second keyword search. This is what the TypeScript
               pipeline implements by hand (and keeps switched off).

NO LLM CALL. Local ONNX embeddings, the live Neon index, nothing else.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path
from typing import Any

from .config import LAB_SCHEMA, database_url, database_url_direct
from .cross_encoder import OnnxCrossEncoder
from .embeddings import LocalMiniLM
from .golden import Question, read_golden_set, scorable_questions
from .metrics import Hit, RelevantRange, aggregate, hit_rate, mrr_at_k, ndcg_at_k, precision_at_k, recall_at_k
from .retriever import HybridRetriever, build_compressor, build_multi_query_retriever
from .store import NeonStore, Tuning

#: How many hits the benchmark asks for. `scripts/eval/bench.ts` uses 10.
LIMIT = 10


def pct(value: float) -> str:
    """Format a fraction as a percentage, the way the TypeScript bench does."""
    return f"{value * 100:.1f}%"


def to_hits(documents: list[Any]) -> list[Hit]:
    """Reduce LangChain documents to the shape the metrics need."""
    return [
        Hit(
            path=doc.metadata.get("path", ""),
            start_line=int(doc.metadata.get("start_line", 0)),
            end_line=int(doc.metadata.get("end_line", 0)),
            symbol=doc.metadata.get("symbol", "") or "",
        )
        for doc in documents
    ]


def to_relevant(question: Question) -> list[RelevantRange]:
    """Turn a question's evidence into the metric function's expectations."""
    return [
        RelevantRange(
            path=item.path,
            start_line=item.start_line,
            end_line=item.end_line,
            symbol=item.symbol,
        )
        for item in question.evidence
    ]


def run_pass(
    store: NeonStore,
    embedder: LocalMiniLM,
    compressor: Any,
    questions: list[Question],
    tuning: Tuning,
    mode: str,
) -> dict[str, Any]:
    """Score every question and return the aggregate plus the latency split."""
    scored: list[dict[str, float]] = []
    embed_ms: list[float] = []
    retrieve_ms: list[float] = []
    rerank_ms: list[float] = []
    total_ms: list[float] = []
    failures: list[dict[str, Any]] = []

    for question in questions:
        started = time.perf_counter()

        # --- embed -----------------------------------------------------
        embed_started = time.perf_counter()
        embedding = embedder.embed_query(question.question)
        embed_elapsed = (time.perf_counter() - embed_started) * 1000

        # --- retrieve --------------------------------------------------
        retrieve_started = time.perf_counter()
        if mode == "multi-query":
            retriever = build_multi_query_retriever(
                HybridRetriever(
                    store=store,
                    embedding_model=embedder,
                    project_id=question.project,
                    tuning=tuning,
                )
            )
            candidates = retriever.invoke(question.question)
        else:
            retriever = HybridRetriever(
                store=store,
                embedding_model=embedder,
                project_id=question.project,
                tuning=tuning,
            )
            candidates = retriever.invoke(question.question)
        retrieve_elapsed = (time.perf_counter() - retrieve_started) * 1000

        # --- rerank ----------------------------------------------------
        rerank_started = time.perf_counter()
        head = candidates[: tuning.rerank_depth]
        documents = list(compressor.compress_documents(head, question.question))[:LIMIT]
        rerank_elapsed = (time.perf_counter() - rerank_started) * 1000

        total_elapsed = (time.perf_counter() - started) * 1000

        # --- score -----------------------------------------------------
        hits = to_hits(documents)
        relevant = to_relevant(question)
        expected_paths = [RelevantRange(path=item.path) for item in question.evidence]

        scored.append(
            {
                "recallAt5": recall_at_k(hits, relevant, 5),
                "recallAt10": recall_at_k(hits, relevant, 10),
                "mrrAt10": mrr_at_k(hits, relevant, 10),
                "ndcgAt10": ndcg_at_k(hits, relevant, 10),
                "hitRateAt10": hit_rate(hits, relevant, 10),
                "precisionAt10": precision_at_k(hits, relevant, 10),
                "fileRecallAt5": recall_at_k(hits, expected_paths, 5),
                "fileRecallAt10": recall_at_k(hits, expected_paths, 10),
            }
        )

        embed_ms.append(embed_elapsed)
        retrieve_ms.append(retrieve_elapsed)
        rerank_ms.append(rerank_elapsed)
        total_ms.append(total_elapsed)

        if recall_at_k(hits, relevant, 5) < 0.5:
            failures.append(
                {
                    "id": question.id,
                    "bucket": question.bucket,
                    "recallAt5": scored[-1]["recallAt5"],
                    "top": f"{hits[0].path}:{hits[0].start_line}-{hits[0].end_line}" if hits else "-",
                }
            )

    summary = aggregate(scored)
    return {
        "mode": mode,
        "summary": {
            "count": summary.count,
            "recallAt5": summary.recall_at5,
            "recallAt10": summary.recall_at10,
            "mrrAt10": summary.mrr_at10,
            "ndcgAt10": summary.ndcg_at10,
            "hitRateAt10": summary.hit_rate_at10,
            "precisionAt10": summary.precision_at10,
            "fileRecallAt5": summary.file_recall_at5,
            "fileRecallAt10": summary.file_recall_at10,
        },
        "latencyMs": {
            "embed_mean": statistics.fmean(embed_ms) if embed_ms else 0.0,
            "retrieve_mean": statistics.fmean(retrieve_ms) if retrieve_ms else 0.0,
            "rerank_mean": statistics.fmean(rerank_ms) if rerank_ms else 0.0,
            "total_mean": statistics.fmean(total_ms) if total_ms else 0.0,
            "total_p50": statistics.median(total_ms) if total_ms else 0.0,
            "total_p95": (
                sorted(total_ms)[min(len(total_ms) - 1, int(len(total_ms) * 0.95))]
                if total_ms
                else 0.0
            ),
            "total_max": max(total_ms) if total_ms else 0.0,
        },
        "worst": failures,
    }


def main(argv: list[str] | None = None) -> int:
    """Run the benchmark."""
    parser = argparse.ArgumentParser(description="LangChain retrieval side-lab")
    parser.add_argument(
        "--mode",
        choices=["production", "multi-query", "prf"],
        default="production",
        help="which retrieval chain to score",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="score only the first N questions (0 = all scorable questions)",
    )
    parser.add_argument("--out", type=Path, default=None, help="write the report as JSON")
    parser.add_argument(
        "--no-rerank",
        action="store_true",
        help="skip the cross-encoder (to measure the retrieval stage on its own)",
    )
    args = parser.parse_args(argv)

    # --- the models ---------------------------------------------------
    model_started = time.perf_counter()
    embedder = LocalMiniLM()
    encoder = OnnxCrossEncoder()
    model_load_ms = (time.perf_counter() - model_started) * 1000

    tuning = Tuning(
        rerank=not args.no_rerank,
        prf=args.mode == "prf",
    )
    compressor = build_compressor(top_n=LIMIT, model=encoder)

    store = NeonStore(database_url(), database_url_direct())
    try:
        corpus = store.corpus_size()

        questions = scorable_questions(read_golden_set())
        if args.limit:
            questions = questions[: args.limit]

        print("")
        print(f"corpus: {corpus} chunks")
        print(f"lab schema: {LAB_SCHEMA} (the lab writes nothing outside it)")
        print(f"models loaded in {model_load_ms:.0f} ms")
        print("")

        started = time.perf_counter()
        result = run_pass(store, embedder, compressor, questions, tuning, args.mode)
        elapsed = time.perf_counter() - started

        summary = result["summary"]
        latency = result["latencyMs"]
        print(
            f"--- CANDIDATE ({args.mode}) --- "
            f"({elapsed:.1f}s for {summary['count']} questions)"
        )
        print(f"  chunk recall@5     {pct(summary['recallAt5']).rjust(7)}")
        print(f"  chunk recall@10    {pct(summary['recallAt10']).rjust(7)}")
        print(f"  MRR@10             {pct(summary['mrrAt10']).rjust(7)}")
        print(f"  nDCG@10            {pct(summary['ndcgAt10']).rjust(7)}")
        print(f"  hit-rate@10        {pct(summary['hitRateAt10']).rjust(7)}")
        print(f"  precision@10       {pct(summary['precisionAt10']).rjust(7)}")
        print(f"  FILE  recall@5     {pct(summary['fileRecallAt5']).rjust(7)}")
        print(f"  FILE  recall@10    {pct(summary['fileRecallAt10']).rjust(7)}")
        print("")
        print(
            "  latency per query  "
            f"embed {latency['embed_mean']:.1f} ms | "
            f"retrieve {latency['retrieve_mean']:.1f} ms | "
            f"rerank {latency['rerank_mean']:.1f} ms | "
            f"total {latency['total_mean']:.1f} ms"
        )
        print(
            f"  latency percentiles  p50 {latency['total_p50']:.1f} ms | "
            f"p95 {latency['total_p95']:.1f} ms | max {latency['total_max']:.1f} ms"
        )

        if args.out:
            payload = {
                "corpusSize": corpus,
                "mode": args.mode,
                "modelLoadMs": model_load_ms,
                "elapsedSeconds": elapsed,
                "tuning": {
                    "minVectorChars": tuning.min_vector_chars,
                    "vectorWeight": tuning.vector_weight,
                    "keywordWeight": tuning.keyword_weight,
                    "excludeTests": tuning.exclude_tests,
                    "genericTokenDfRatio": tuning.generic_token_df_ratio,
                    "useIdf": tuning.use_idf,
                    "rerank": tuning.rerank,
                    "rerankDepth": tuning.rerank_depth,
                    "candidates": tuning.candidates,
                    "prf": tuning.prf,
                    "prfTopK": tuning.prf_top_k,
                },
                **result,
            }
            args.out.write_text(json.dumps(payload, indent=2), encoding="utf8")
            print(f"\nreport written to {args.out}")
    finally:
        store.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
