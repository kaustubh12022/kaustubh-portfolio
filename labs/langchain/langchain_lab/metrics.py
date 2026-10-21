"""Retrieval metrics - a line-by-line port of `lib/eval/metrics.ts`.

The functions are PURE. They take an ordered list of hits and a list of
expectations and return a number. Porting them exactly is the only way the
two implementations can be compared: if the metric code differed, the
comparison would measure the metric code and not the retrievers.

WHY A HIT IS "RELEVANT"
-----------------------
A retrieved chunk counts as relevant when it is the SAME FILE and it
OVERLAPS the expected line range:

    hit.path == relevant.path
    and hit.startLine <= relevant.endLine
    and hit.endLine   >= relevant.startLine

Overlap, not equality: the indexer chunks by AST, so a function usually
lives in a chunk that is a superset of the exact function body. An exact
range match would score a perfectly correct retrieval as a miss.

When the expectation names a SYMBOL but no line range, the hit has to come
from the same file AND carry the same symbol. When it names only a path,
any chunk of that file counts.
"""

from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class Hit:
    """A retrieved chunk, reduced to what the metrics need."""

    path: str
    start_line: int
    end_line: int
    symbol: str = ""


@dataclass(frozen=True)
class RelevantRange:
    """An expected range. The line numbers are optional on purpose."""

    path: str
    start_line: int | None = None
    end_line: int | None = None
    symbol: str | None = None


def line_ranges_overlap(a_start: int, a_end: int, b_start: int, b_end: int) -> bool:
    """Do two line ranges overlap?"""
    return a_start <= b_end and b_start <= a_end


def is_relevant_hit(hit: Hit, relevant: RelevantRange) -> bool:
    """Does a retrieved chunk satisfy an expectation?"""
    if hit.path != relevant.path:
        return False

    has_range = relevant.start_line is not None and relevant.end_line is not None
    if has_range:
        return line_ranges_overlap(
            hit.start_line,
            hit.end_line,
            relevant.start_line,  # type: ignore[arg-type]
            relevant.end_line,  # type: ignore[arg-type]
        )

    if relevant.symbol:
        return hit.symbol.lower() == relevant.symbol.lower()

    return True


def is_relevant_to_any(hit: Hit, relevant: list[RelevantRange]) -> bool:
    """Does the hit satisfy ANY of the expectations?"""
    return any(is_relevant_hit(hit, item) for item in relevant)


def matched_ranges(hits: list[Hit], relevant: list[RelevantRange]) -> list[RelevantRange]:
    """The expectations that were satisfied by the given hits."""
    return [item for item in relevant if any(is_relevant_hit(hit, item) for hit in hits)]


def recall_at_k(hits: list[Hit], relevant: list[RelevantRange], k: int) -> float:
    """The fraction of the expected ranges that were retrieved in the top k."""
    if not relevant:
        return 0.0
    top = hits[: max(0, k)]
    return len(matched_ranges(top, relevant)) / len(relevant)


def hit_rate(hits: list[Hit], relevant: list[RelevantRange], k: int) -> float:
    """1 when at least one expectation was met in the top k, else 0."""
    if not relevant:
        return 0.0
    top = hits[: max(0, k)]
    return 1.0 if matched_ranges(top, relevant) else 0.0


def precision_at_k(hits: list[Hit], relevant: list[RelevantRange], k: int) -> float:
    """The fraction of the top k that was relevant."""
    if not relevant:
        return 0.0
    top = hits[: max(0, k)]
    if not top:
        return 0.0
    relevant_count = sum(1 for hit in top if is_relevant_to_any(hit, relevant))
    return relevant_count / len(top)


def mrr_at_k(hits: list[Hit], relevant: list[RelevantRange], k: int) -> float:
    """The reciprocal of the rank of the FIRST relevant hit."""
    if not relevant:
        return 0.0
    top = hits[: max(0, k)]
    for index, hit in enumerate(top):
        if is_relevant_to_any(hit, relevant):
            return 1.0 / (index + 1)
    return 0.0


def ndcg_at_k(hits: list[Hit], relevant: list[RelevantRange], k: int) -> float:
    """The normalised discounted cumulative gain.

    Gain is BINARY, the discount is `1 / log2(rank + 1)`, and the ideal
    ordering puts `min(k, |relevant|)` relevant hits first.
    """
    if not relevant:
        return 0.0
    top = hits[: max(0, k)]
    if not top:
        return 0.0

    dcg = 0.0
    for index, hit in enumerate(top):
        if is_relevant_to_any(hit, relevant):
            dcg += 1.0 / math.log2(index + 2)

    ideal_hits = min(max(0, k), len(relevant))
    idcg = sum(1.0 / math.log2(index + 2) for index in range(ideal_hits))

    if idcg == 0:
        return 0.0
    return dcg / idcg


def mean(values: list[float]) -> float:
    """The mean of a list of numbers. Returns 0 for an empty list."""
    if not values:
        return 0.0
    return sum(values) / len(values)


@dataclass
class Aggregate:
    """The aggregate numbers of a set of scored questions."""

    count: int
    recall_at5: float
    recall_at10: float
    mrr_at10: float
    ndcg_at10: float
    hit_rate_at10: float
    precision_at10: float
    file_recall_at5: float
    file_recall_at10: float


def aggregate(scored: list[dict[str, float]]) -> Aggregate:
    """Average the metrics of a set of scored questions."""
    return Aggregate(
        count=len(scored),
        recall_at5=mean([item["recallAt5"] for item in scored]),
        recall_at10=mean([item["recallAt10"] for item in scored]),
        mrr_at10=mean([item["mrrAt10"] for item in scored]),
        ndcg_at10=mean([item["ndcgAt10"] for item in scored]),
        hit_rate_at10=mean([item["hitRateAt10"] for item in scored]),
        precision_at10=mean([item["precisionAt10"] for item in scored]),
        file_recall_at5=mean([item["fileRecallAt5"] for item in scored]),
        file_recall_at10=mean([item["fileRecallAt10"] for item in scored]),
    )
